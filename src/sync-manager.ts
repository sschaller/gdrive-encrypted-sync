import { Vault, Notice, normalizePath } from "obsidian";
import GDriveClient from "./gdrive/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GDriveSyncSettings, SyncProfile } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { hasTextExtension } from "./utils";
import GDriveSyncPlugin from "./main";
import {
  encryptContent,
  decryptContent,
  encryptFilename,
  computeContentHash,
  generateSalt,
  deriveKey,
} from "./crypto/encryption";

const SYNC_MANIFEST_NAME = "_sync_manifest";
const SALT_LENGTH = 16;

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export default class SyncManager {
  metadataStore: MetadataStore;
  private client: GDriveClient;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;
  private cryptoKey: CryptoKey | null = null;
  onProgress?: (current: number, total: number) => void;

  constructor(
    private vault: Vault,
    private settings: GDriveSyncSettings,
    private profile: SyncProfile,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault, this.profile.id);
    this.client = new GDriveClient(this.settings, this.profile, this.logger);
  }

  /** Get localFolder with trailing slashes removed */
  private get normalizedLocalFolder(): string {
    return this.profile.localFolder.replace(/\/+$/, "");
  }

  /** Convert a metadata-relative path to a vault-absolute path */
  private toVaultPath(metaPath: string): string {
    const folder = this.normalizedLocalFolder;
    if (!folder) return metaPath;
    return `${folder}/${metaPath}`;
  }

  /** Convert a vault-absolute path to a metadata-relative path */
  private toMetaPath(vaultPath: string): string {
    const folder = this.normalizedLocalFolder;
    if (!folder) return vaultPath;
    if (vaultPath.startsWith(folder + "/")) {
      return vaultPath.slice(folder.length + 1);
    }
    return vaultPath;
  }

  /** Check if a vault path is within this profile's scope */
  private isInScope(vaultPath: string): boolean {
    const folder = this.normalizedLocalFolder;
    if (!folder) return true;
    return vaultPath.startsWith(folder + "/") || vaultPath === folder;
  }

  async initCryptoKey(): Promise<void> {
    if (!this.profile.encryptionPassword) {
      this.cryptoKey = null;
      return;
    }
    let salt: Uint8Array;
    if (this.metadataStore.data.encryptionSalt) {
      salt = new Uint8Array(
        atob(this.metadataStore.data.encryptionSalt)
          .split("")
          .map((c) => c.charCodeAt(0)),
      );
    } else {
      salt = await generateSalt();
      this.metadataStore.data.encryptionSalt = btoa(
        String.fromCharCode(...salt),
      );
      await this.metadataStore.save();
    }
    this.cryptoKey = await deriveKey(this.profile.encryptionPassword, salt);
  }

  /**
   * Syncs local and remote folders. Handles both initial sync and subsequent syncs.
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      return;
    }

    this.syncing = true;
    try {
      await this.syncImpl();
    } finally {
      this.syncing = false;
    }
  }

  private async syncImpl() {
    await this.logger.info("Starting sync");

    if (!this.cryptoKey) {
      throw new Error("Encryption key not initialized. Set a password first.");
    }

    // Find or create the Drive folder
    const folderId = await this.client.findOrCreateSyncFolder(this.profile.driveFolderName);
    const driveFiles = await this.client.listFiles(folderId);

    // Check for existing remote manifest
    let manifestFile = driveFiles.find(
      (f) => f.name === SYNC_MANIFEST_NAME,
    );

    // If remote manifest exists, adopt its salt and re-derive key
    if (manifestFile) {
      const manifestRaw = await this.client.downloadFile(manifestFile.id);
      const manifestBytes = new Uint8Array(manifestRaw);
      const remoteSalt = manifestBytes.slice(0, SALT_LENGTH);
      const remoteSaltB64 = btoa(String.fromCharCode(...remoteSalt));

      // If our salt differs from remote, adopt the remote salt
      if (this.metadataStore.data.encryptionSalt !== remoteSaltB64) {
        await this.logger.info("Adopting remote encryption salt");
        this.metadataStore.data.encryptionSalt = remoteSaltB64;
        this.cryptoKey = await deriveKey(
          this.profile.encryptionPassword,
          remoteSalt,
        );
        await this.metadataStore.save();
      }
    }

    // If no manifest exists yet, create an empty one to bootstrap
    if (!manifestFile) {
      await this.logger.info("No remote manifest found, creating initial manifest");
      await this.finalizeSync(folderId, null);
      // Re-fetch drive files to get the new manifest
      const updatedDriveFiles = await this.client.listFiles(folderId);
      manifestFile = updatedDriveFiles.find((f) => f.name === SYNC_MANIFEST_NAME);
      if (!manifestFile) {
        throw new Error("Failed to create remote manifest");
      }
    }

    // Download and decrypt the remote manifest
    const manifestRaw = await this.client.downloadFile(manifestFile.id);
    const manifestBytes = new Uint8Array(manifestRaw);
    const manifestEncrypted = manifestBytes.slice(SALT_LENGTH).buffer as ArrayBuffer;
    let remoteMetadata: Metadata;
    try {
      const manifestDecrypted = await decryptContent(
        manifestEncrypted,
        this.cryptoKey!,
      );
      remoteMetadata = JSON.parse(
        new TextDecoder().decode(manifestDecrypted),
      );
    } catch {
      throw new Error(
        "Failed to decrypt remote manifest. Wrong encryption password?",
      );
    }

    const conflicts = await this.findConflicts(remoteMetadata.files);

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts", conflicts);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all the conflicts
        conflictResolutions = await this.onConflicts(conflicts);
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        // The user explicitly wants to always overwrite the local file
        // in case of conflicts so we just download the remote file to solve it

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the remote file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "download", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        // The user explicitly wants to always overwrite the remote file
        // in case of conflicts so we just upload the remote file to solve it.

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the local file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      }
    }

    await this.logger.info("Filename of metadata manifest", this.metadataStore.fileName);

    await this.logger.info(
      "Local files in metadata",
      Object.keys(this.metadataStore.data.files),
    );
    await this.logger.info(
      "Remote files in manifest",
      Object.keys(remoteMetadata.files),
    );

    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
    ];

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return;
    }
    await this.logger.info("Actions to sync", actions);

    // Execute actions
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      switch (action.type) {
        case "upload": {
          const vaultPath = this.toVaultPath(action.filePath);
          const normalizedPath = normalizePath(vaultPath);
          const resolution = conflictResolutions.find(
            (c) => c.filePath === action.filePath,
          );
          // If the file was conflicting we need to read the content from the
          // conflict resolution instead of reading it from file since at this point
          // we still have not updated the local file.
          let content: ArrayBuffer;
          if (resolution) {
            content = new TextEncoder().encode(resolution.content).buffer;
          } else {
            if (!(await this.vault.adapter.exists(normalizedPath))) {
              // File doesn't exist locally, nothing to upload
              break;
            }
            content = await this.vault.adapter.readBinary(normalizedPath);
          }

          const contentHash = await computeContentHash(content);
          const encrypted = await encryptContent(content, this.cryptoKey!);

          const existingMeta =
            this.metadataStore.data.files[action.filePath];
          let driveFileId: string;

          if (existingMeta?.driveFileId) {
            // Update existing file
            await this.client.updateFile(existingMeta.driveFileId, encrypted);
            driveFileId = existingMeta.driveFileId;
          } else {
            // Upload new file
            const obfuscatedName = await encryptFilename(
              action.filePath,
              this.cryptoKey!,
            );
            const uploaded = await this.client.uploadFile(
              folderId,
              obfuscatedName,
              encrypted,
            );
            driveFileId = uploaded.id;
          }

          this.metadataStore.data.files[action.filePath] = {
            path: action.filePath,
            contentHash,
            dirty: false,
            justDownloaded: false,
            lastModified: Date.now(),
            driveFileId,
          };
          break;
        }
        case "download": {
          const remoteMeta = remoteMetadata.files[action.filePath];
          if (!remoteMeta?.driveFileId) {
            continue;
          }

          const encrypted = await this.client.downloadFile(remoteMeta.driveFileId);
          const decrypted = await decryptContent(encrypted, this.cryptoKey!);

          const vaultPath = this.toVaultPath(action.filePath);
          const normalizedPath = normalizePath(vaultPath);
          const fileFolder = normalizePath(
            normalizedPath.split("/").slice(0, -1).join("/"),
          );
          if (
            fileFolder &&
            !(await this.vault.adapter.exists(fileFolder))
          ) {
            await this.vault.adapter.mkdir(fileFolder);
          }

          await this.vault.adapter.writeBinary(normalizedPath, decrypted);

          this.metadataStore.data.files[action.filePath] = {
            path: action.filePath,
            contentHash: remoteMeta.contentHash,
            dirty: false,
            justDownloaded: true,
            lastModified: remoteMeta.lastModified,
            driveFileId: remoteMeta.driveFileId,
          };
          break;
        }
        case "delete_local": {
          const vaultPath = this.toVaultPath(action.filePath);
          const normalizedPath = normalizePath(vaultPath);
          if (await this.vault.adapter.exists(normalizedPath)) {
            await this.vault.adapter.remove(normalizedPath);
          }
          this.metadataStore.data.files[action.filePath].deleted = true;
          this.metadataStore.data.files[action.filePath].deletedAt =
            Date.now();
          break;
        }
        case "delete_remote": {
          const meta = this.metadataStore.data.files[action.filePath];
          if (meta?.driveFileId) {
            await this.client.deleteFile(meta.driveFileId);
          }
          this.metadataStore.data.files[action.filePath].deleted = true;
          this.metadataStore.data.files[action.filePath].deletedAt =
            Date.now();
          break;
        }
      }
      this.onProgress?.(i + 1, actions.length);
    }

    // Write conflict resolutions to local files
    for (const resolution of conflictResolutions) {
      const vaultPath = this.toVaultPath(resolution.filePath);
      await this.vault.adapter.write(vaultPath, resolution.content);
      this.metadataStore.data.files[resolution.filePath].lastModified =
        Date.now();
    }

    await this.finalizeSync(folderId, manifestFile.id);
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const metaFileName = this.metadataStore.fileName;
    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${metaFileName}`) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        const actualLocalHash = await this.calculateContentHash(filePath);
        const remoteChanged = remoteFile.contentHash !== localFile.contentHash;
        const localChanged = actualLocalHash !== localFile.contentHash;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata hash is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actuallyDifferent = remoteFile.contentHash !== actualLocalHash;
        if (remoteChanged && localChanged && actuallyDifferent) {
          return filePath;
        }
        return null;
      }),
    );

    const conflictPaths = conflicts.filter(
      (fp): fp is string => fp !== null,
    );

    return await Promise.all(
      conflictPaths.map(async (filePath: string) => {
        // Load contents in parallel
        const remoteMeta = filesMetadata[filePath];
        let remoteContent = "";

        if (remoteMeta.driveFileId) {
          const encrypted = await this.client.downloadFile(
            remoteMeta.driveFileId,
          );
          const decrypted = await decryptContent(encrypted, this.cryptoKey!);
          remoteContent = new TextDecoder().decode(decrypted);
        }

        const vaultPath = this.toVaultPath(filePath);
        const localContent = await this.vault.adapter.read(
          normalizePath(vaultPath),
        );
        return { filePath, remoteContent, localContent };
      }),
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const metaFileName = this.metadataStore.fileName;
    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${metaFileName}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localHash = await this.calculateContentHash(filePath);
        if (remoteFile.contentHash === localHash) {
          // If the remote file hash is identical to the actual hash of the local file
          // there are no actions to take.
          // We calculate the hash at the moment instead of using the one stored in the
          // metadata file cause we update that only when the file is uploaded or downloaded.
          return;
        }

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({ type: "delete_local", filePath: filePath });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({ type: "delete_remote", filePath: filePath });
            return;
          }
        }

        // For non-deletion cases, if hashes differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localHash !== localFile.contentHash) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    if (!this.settings.syncConfigDir) {
      // Remove all actions that involve the config directory if the user doesn't want to sync it.
      // The manifest file is always synced.
      return actions.filter((action: SyncAction) => {
        return (
          !action.filePath.startsWith(this.vault.configDir) ||
          action.filePath === `${this.vault.configDir}/${metaFileName}`
        );
      });
    }

    return actions;
  }

  /**
   * Calculates the SHA-256 content hash of a file.
   * @param filePath normalized path to file
   * @returns String containing the file content hash or null in case the file doesn't exist
   */
  async calculateContentHash(filePath: string): Promise<string | null> {
    const vaultPath = this.toVaultPath(filePath);
    if (!(await this.vault.adapter.exists(vaultPath))) {
      // The file doesn't exist, can't calculate any hash
      return null;
    }
    const content = await this.vault.adapter.readBinary(vaultPath);
    return computeContentHash(content);
  }

  /**
   * Finalizes the sync by encrypting and uploading the metadata manifest
   * to the remote Drive folder.
   *
   * @param folderId The Google Drive folder ID
   * @param existingManifestFileId The Drive file ID of the existing manifest, or null if first sync
   */
  private async finalizeSync(
    folderId: string,
    existingManifestFileId: string | null,
  ) {
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    await this.metadataStore.save();

    // Encrypt and upload manifest with salt prepended (unencrypted)
    // so other vaults can read the salt before decrypting
    const manifestJson = JSON.stringify(this.metadataStore.data);
    const manifestBuffer = new TextEncoder().encode(manifestJson).buffer;
    const encryptedManifest = await encryptContent(
      manifestBuffer,
      this.cryptoKey!,
    );
    const salt = new Uint8Array(
      atob(this.metadataStore.data.encryptionSalt)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    const manifestWithSalt = new Uint8Array(
      salt.length + encryptedManifest.byteLength,
    );
    manifestWithSalt.set(salt, 0);
    manifestWithSalt.set(new Uint8Array(encryptedManifest), salt.length);
    const finalManifest = manifestWithSalt.buffer as ArrayBuffer;

    if (existingManifestFileId) {
      await this.client.updateFile(existingManifestFileId, finalManifest);
    } else {
      await this.client.uploadFile(
        folderId,
        SYNC_MANIFEST_NAME,
        finalManifest,
      );
    }

    await this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      let files: string[] = [];
      const rootPath = this.profile.localFolder || this.vault.getRoot().path;
      let folders = [rootPath];

      if (this.profile.localFolder && !(await this.vault.adapter.exists(rootPath))) {
        // Local folder doesn't exist yet, nothing to enumerate
        folders = [];
      }

      while (folders.length > 0) {
        const folder = folders.pop();
        if (folder === undefined) continue;
        if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
          await this.logger.info("Skipping config dir");
          // Skip the config dir if the user doesn't want to sync it
          continue;
        }
        const res = await this.vault.adapter.list(folder);
        files.push(...res.files);
        folders.push(...res.folders);
      }
      files = files.filter((f) => {
        const basename = f.split("/").pop() || "";
        return !basename.startsWith(".");
      });
      files.forEach((filePath: string) => {
        if (filePath === `${this.vault.configDir}/workspace.json`) {
          // Obsidian recommends not syncing the workspace file
          return;
        }

        const metaPath = this.toMetaPath(filePath);
        this.metadataStore.data.files[metaPath] = {
          path: metaPath,
          contentHash: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
          driveFileId: null,
        };
      });

      this.metadataStore.save();
    }
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Get all the files in the config dir
    let files: string[] = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    // Add them to the metadata store
    files.forEach((filePath: string) => {
      const metaPath = this.toMetaPath(filePath);
      this.metadataStore.data.files[metaPath] = {
        path: metaPath,
        contentHash: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
        driveFileId: null,
      };
    });
    this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files: string[] = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    const metaFileName = this.metadataStore.fileName;
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${metaFileName}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      const metaPath = this.toMetaPath(filePath);
      delete this.metadataStore.data.files[metaPath];
    });
    this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    const metaPath = this.toMetaPath(filePath);
    return this.metadataStore.data.files[metaPath];
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
