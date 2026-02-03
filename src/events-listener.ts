import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore, { MANIFEST_FILE_NAME } from "./metadata-store";
import { GDriveSyncSettings, SyncProfile } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import GDriveSyncPlugin from "./main";

interface ProfileEntry {
  profile: SyncProfile;
  metadataStore: MetadataStore;
}

/**
 * Tracks changes to local sync directory and updates files metadata.
 */
export default class EventsListener {
  private entries: ProfileEntry[];

  constructor(
    private vault: Vault,
    entries: ProfileEntry[],
    private settings: GDriveSyncSettings,
    private logger: Logger,
  ) {
    this.entries = entries;
  }

  updateEntries(entries: ProfileEntry[]) {
    this.entries = entries;
  }

  start(plugin: GDriveSyncPlugin) {
    // We need to register all the events we subscribe to so they can
    // be correctly detached when the plugin is unloaded too.
    // If we don't they might be left hanging and cause issues.
    plugin.registerEvent(this.vault.on("create", this.onCreate.bind(this)));
    plugin.registerEvent(this.vault.on("delete", this.onDelete.bind(this)));
    plugin.registerEvent(this.vault.on("modify", this.onModify.bind(this)));
    plugin.registerEvent(this.vault.on("rename", this.onRename.bind(this)));
  }

  private matchingEntries(filePath: string): ProfileEntry[] {
    return this.entries.filter((entry) =>
      this.isInProfileScope(filePath, entry.profile),
    );
  }

  private isInProfileScope(filePath: string, profile: SyncProfile): boolean {
    const folder = profile.localFolder.replace(/\/+$/, "");
    if (!folder) return true;
    return filePath.startsWith(folder + "/") || filePath === folder;
  }

  private async onCreate(file: TAbstractFile) {
    await this.logger.info("Received create event", file.path);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    for (const entry of this.matchingEntries(file.path)) {
      const metaPath = this.toMetaPath(file.path, entry.profile);
      if (!this.isSyncable(file.path)) {
        // The file has not been created in directory that we're syncing
        continue;
      }

      const data = entry.metadataStore.data.files[metaPath];
      if (data && data.justDownloaded) {
        // This file was just downloaded and not created by the user.
        // It's enough to mark it as non just downloaded.
        entry.metadataStore.data.files[metaPath].justDownloaded = false;
        await entry.metadataStore.save();
        await this.logger.info("Updated just downloaded created file", file.path);
        continue;
      }

      entry.metadataStore.data.files[metaPath] = {
        path: metaPath,
        contentHash: null,
        dirty: true,
        // This file has been created by the user
        justDownloaded: false,
        lastModified: Date.now(),
        driveFileId: null,
      };
      await entry.metadataStore.save();
      await this.logger.info("Updated created file", file.path);
    }
  }

  private async onDelete(file: TAbstractFile | string) {
    const filePath = file instanceof TAbstractFile ? file.path : file;
    await this.logger.info("Received delete event", filePath);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    for (const entry of this.matchingEntries(filePath)) {
      const metaPath = this.toMetaPath(filePath, entry.profile);
      if (!this.isSyncable(filePath)) {
        // The file was not in directory that we're syncing
        continue;
      }
      if (!entry.metadataStore.data.files[metaPath]) continue;

      entry.metadataStore.data.files[metaPath].deleted = true;
      entry.metadataStore.data.files[metaPath].deletedAt = Date.now();
      await entry.metadataStore.save();
      await this.logger.info("Updated deleted file", filePath);
    }
  }

  private async onModify(file: TAbstractFile) {
    await this.logger.info("Received modify event", file.path);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    for (const entry of this.matchingEntries(file.path)) {
      const metaPath = this.toMetaPath(file.path, entry.profile);
      if (!this.isSyncable(file.path))
      {
        // The file has not been create in directory that we're syncing
        continue;
      }

      const data = entry.metadataStore.data.files[metaPath];
      if (data && data.justDownloaded) {
        // This file was just downloaded and not modified by the user.
        // It's enough to makr it as non just downloaded.
        entry.metadataStore.data.files[metaPath].justDownloaded = false;
        await entry.metadataStore.save();
        await this.logger.info("Updated just downloaded modified file", file.path);
        continue;
      }
      entry.metadataStore.data.files[metaPath].lastModified = Date.now();
      entry.metadataStore.data.files[metaPath].dirty = true;
      await entry.metadataStore.save();
      await this.logger.info("Updated modified file", file.path);
    }
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    await this.logger.info("Received rename event", file.path);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    if (this.isSyncable(file.path) || this.isSyncable(oldPath)) {
      if (this.isSyncable(file.path) && this.isSyncable(oldPath)) {
        // Both files are in the synced directory
        // First create the new one
        await this.onCreate(file);
        // Then delete the old one
        await this.onDelete(oldPath);
      } else if (this.isSyncable(file.path)) {
        // Only the new file is in the local directory
        await this.onCreate(file);
      } else if (this.isSyncable(oldPath)) {
        // Only the old file was in the local directory
        await this.onDelete(oldPath);
      }
    }
  }

  private toMetaPath(filePath: string, profile: SyncProfile): string {
    const folder = profile.localFolder.replace(/\/+$/, "");
    if (!folder) return filePath;
    if (filePath.startsWith(folder + "/")) {
      return filePath.slice(folder.length + 1);
    }
    return filePath;
  }

  private isSyncable(filePath: string) {
    if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
      // Manifest file must always be synced
      return true;
    } else if (
      filePath === `${this.vault.configDir}/workspace.json` ||
      filePath === `${this.vault.configDir}/workspace-mobile.json`
    ) {
      // Obsidian recommends not syncing the workspace files
      return false;
    } else if (filePath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
      // Don't sync the log file, doesn't make sense
      return false;
    } else if (
      this.settings.syncConfigDir &&
      filePath.startsWith(this.vault.configDir)
    ) {
      // Sync configs only if the user explicitly wants to
      return true;
    } else {
      // All other files can be synced
      return true;
    }
  }
}
