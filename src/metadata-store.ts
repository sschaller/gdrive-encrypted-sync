import { Vault, normalizePath } from "obsidian";

export const MANIFEST_FILE_NAME = "gdrive-sync-metadata.json" as const;

/**
 * A file metadata.
 * Store info that makes easier to track a file locally and in the remote repo.
 */
export interface FileMetadata {
  // Local path to the file
  path: string;
  // SHA of the file in the remote repository.
  // This is necessary to update the file remotely.
  // If this is null the file has not yet been pushed to the remote repository.
  // This doesn't change when the file is manually edited by the user but only
  // when uploading or downloading this file.
  // In short this is the content hash of the remote file at the time of the last sync,
  // as far as the local environment is aware.
  contentHash: string | null;
  // Whether the file has been modified locally.
  dirty: boolean;
  // This is mostly used to track if the file has been just downloaded from the remote.
  // This is necessary since even when creating a file programatically after it has been
  // downloaded it will trigger a 'create' or 'modify' event.
  // This is a problem as we can't know whether an event has been triggered by us or the user.
  justDownloaded: boolean;
  // The last time the file was modified
  lastModified: number;
  // Whether the file has been deleted
  deleted?: boolean | null;
  // When the file was deleted
  deletedAt?: number | null;
  driveFileId: string | null;
  obfuscatedName: string | null;
}

export interface Metadata {
  lastSync: number;
  files: Record<string, FileMetadata>;
  encryptionSalt: string;
  driveFolderId: string;
}

/**
 * Stores files metadata between sesssions.
 * Data is saved as JSON in the .obsidian folder in the current Vault.
 */
export default class MetadataStore {
  data: Metadata;
  private metadataFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private vault: Vault, profileId?: string) {
    const fileName = profileId
      ? `gdrive-sync-metadata-${profileId}.json`
      : MANIFEST_FILE_NAME;
    this.metadataFile = normalizePath(
      `${this.vault.configDir}/${fileName}`,
    );
  }

  get fileName(): string {
    return this.metadataFile.split("/").pop() || MANIFEST_FILE_NAME;
  }

  /**
   * Loads the metadata from disk.
   */
  async load() {
    const fileExists = await this.vault.adapter.exists(this.metadataFile);
    if (fileExists) {
      const content = await this.vault.adapter.read(this.metadataFile);
      this.data = JSON.parse(content);
    } else {
      this.data = {
        lastSync: 0,
        files: {},
        encryptionSalt: "",
        driveFolderId: "",
      };
    }
  }

  /**
   * Save current metadata to disk.
   */
  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.vault.adapter.write(
        this.metadataFile,
        JSON.stringify(this.data),
      );
    });
    return this.writeQueue;
  }

  reset() {
    this.data = {
      lastSync: 0,
      files: {},
      encryptionSalt: "",
      driveFolderId: "",
    };
  }
}
