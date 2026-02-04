import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore from "./metadata-store";
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

  private async onCreate(file: TAbstractFile) {
    await this.logger.info("Received create event", file.path);
    if (file instanceof TFolder) {
      return;
    }

    for (const entry of this.entries) {
      if (!this.isSyncable(file.path, entry.profile)) {
        continue;
      }
      await this.onCreateForProfile(file, entry);
    }
  }

  private async onDelete(file: TAbstractFile | string) {
    const filePath = file instanceof TAbstractFile ? file.path : file;
    await this.logger.info("Received delete event", filePath);
    if (file instanceof TFolder) {
      return;
    }

    for (const entry of this.entries) {
      if (!this.isSyncable(filePath, entry.profile)) {
        continue;
      }
      await this.onDeleteForProfile(filePath, entry);
    }
  }

  private async onModify(file: TAbstractFile) {
    await this.logger.info("Received modify event", file.path);
    if (file instanceof TFolder) {
      return;
    }

    for (const entry of this.entries) {
      if (!this.isSyncable(file.path, entry.profile)) {
        continue;
      }
      await this.onModifyForProfile(file, entry);
    }
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    await this.logger.info("Received rename event", file.path);
    if (file instanceof TFolder) {
      return;
    }

    for (const entry of this.entries) {
      const newSyncable = this.isSyncable(file.path, entry.profile);
      const oldSyncable = this.isSyncable(oldPath, entry.profile);

      if (newSyncable && oldSyncable) {
        await this.onCreateForProfile(file, entry);
        await this.onDeleteForProfile(oldPath, entry);
      } else if (newSyncable) {
        await this.onCreateForProfile(file, entry);
      } else if (oldSyncable) {
        await this.onDeleteForProfile(oldPath, entry);
      }
    }
  }

  private async onCreateForProfile(file: TAbstractFile, entry: ProfileEntry) {
    const metaPath = this.toMetaPath(file.path, entry.profile);
    const data = entry.metadataStore.data.files[metaPath];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not created by the user.
      // It's enough to mark it as non just downloaded.
      entry.metadataStore.data.files[metaPath].justDownloaded = false;
      await entry.metadataStore.save();
      await this.logger.info("Updated just downloaded created file", file.path);
      return;
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

  private async onDeleteForProfile(filePath: string, entry: ProfileEntry) {
    const metaPath = this.toMetaPath(filePath, entry.profile);
    if (!entry.metadataStore.data.files[metaPath]) return;

    entry.metadataStore.data.files[metaPath].deleted = true;
    entry.metadataStore.data.files[metaPath].deletedAt = Date.now();
    await entry.metadataStore.save();
    await this.logger.info("Updated deleted file", filePath);
  }

  private async onModifyForProfile(file: TAbstractFile, entry: ProfileEntry) {
    const metaPath = this.toMetaPath(file.path, entry.profile);
    const data = entry.metadataStore.data.files[metaPath];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not modified by the user.
      // It's enough to mark it as non just downloaded.
      entry.metadataStore.data.files[metaPath].justDownloaded = false;
      await entry.metadataStore.save();
      await this.logger.info("Updated just downloaded modified file", file.path);
      return;
    }
    if (!entry.metadataStore.data.files[metaPath]) return;

    entry.metadataStore.data.files[metaPath].lastModified = Date.now();
    entry.metadataStore.data.files[metaPath].dirty = true;
    await entry.metadataStore.save();
    await this.logger.info("Updated modified file", file.path);
  }

  private toMetaPath(filePath: string, profile: SyncProfile): string {
    const folder = profile.localFolder.replace(/\/+$/, "");
    if (!folder) return filePath;
    if (filePath.startsWith(folder + "/")) {
      return filePath.slice(folder.length + 1);
    }
    return filePath;
  }

  private isSyncable(filePath: string, profile: SyncProfile) {
    if (
      filePath === `${this.vault.configDir}/workspace.json` ||
      filePath === `${this.vault.configDir}/workspace-mobile.json`
    ) {
      // Obsidian recommends not syncing the workspace files
      return false;
    } else if (filePath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
      // Don't sync the log file, doesn't make sense
      return false;
    } else if (filePath.startsWith(this.vault.configDir)) {
      // Config files: sync only if profile has syncConfigDir enabled
      return profile.syncConfigDir ?? false;
    }

    // Check folder scope
    const folder = profile.localFolder.replace(/\/+$/, "");
    if (!folder) return true;
    return filePath.startsWith(folder + "/") || filePath === folder;
  }
}
