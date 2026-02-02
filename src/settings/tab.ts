import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Modal,
  Notice,
  setIcon,
} from "obsidian";
import GDriveSyncPlugin from "src/main";
import { copyToClipboard } from "src/utils";
import { SyncProfile, createDefaultProfile } from "./settings";

export default class GDriveSyncSettingsTab extends PluginSettingTab {
  plugin: GDriveSyncPlugin;

  constructor(app: App, plugin: GDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    // ── Google Drive (shared credentials) ──
    new Setting(containerEl).setName("Google Drive").setHeading();

    new Setting(containerEl)
      .setName("Google Client ID")
      .setDesc(
        "OAuth 2.0 Client ID from Google Cloud Console (Desktop app type)",
      )
      .addText((text) =>
        text
          .setPlaceholder("Client ID")
          .setValue(this.plugin.settings.googleClientId)
          .onChange(async (value) => {
            this.plugin.settings.googleClientId = value;
            await this.plugin.saveSettings();
          }),
      );

    let secretInput: TextComponent;
    new Setting(containerEl)
      .setName("Google Client Secret")
      .setDesc("OAuth 2.0 Client Secret from Google Cloud Console")
      .addButton((button) =>
        button.setIcon("eye-off").onClick(() => {
          if (secretInput.inputEl.type === "password") {
            secretInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            secretInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Client Secret")
          .setValue(this.plugin.settings.googleClientSecret)
          .onChange(async (value) => {
            this.plugin.settings.googleClientSecret = value;
            await this.plugin.saveSettings();
          }).inputEl.type = "password";
        secretInput = text;
      });

    // ── Sync Profiles ──
    new Setting(containerEl).setName("Sync profiles").setHeading();

    for (let idx = 0; idx < this.plugin.settings.profiles.length; idx++) {
      const profile = this.plugin.settings.profiles[idx];
      this.renderProfile(containerEl, profile, idx);
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Add profile")
        .setCta()
        .onClick(async () => {
          const newProfile = createDefaultProfile();
          newProfile.name = `Profile ${this.plugin.settings.profiles.length + 1}`;
          this.plugin.settings.profiles.push(newProfile);
          await this.plugin.saveSettings();
          await this.plugin.initSyncManagers();
          this.display();
        }),
    );

    // ── Sync ──
    new Setting(containerEl).setName("Sync").setHeading();

    const syncStrategies = {
      manual: "Manually",
      interval: "On Interval",
    };
    const uploadStrategySetting = new Setting(containerEl)
      .setName("Sync strategy")
      .setDesc("How to sync files with Google Drive");

    let syncInterval = "1";
    if (this.plugin.settings.syncInterval) {
      syncInterval = this.plugin.settings.syncInterval.toString();
    }
    const intervalSettings = new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Interval in minutes between automatic syncs")
      .addText((text) =>
        text
          .setPlaceholder("Interval in minutes")
          .setValue(syncInterval)
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 1;
            await this.plugin.saveSettings();
            // We need to restart the interval if the value is changed
            this.plugin.restartSyncInterval();
          }),
      );
    intervalSettings.setDisabled(
      this.plugin.settings.syncStrategy !== "interval",
    );

    uploadStrategySetting.addDropdown((dropdown) =>
      dropdown
        .addOptions(syncStrategies)
        .setValue(this.plugin.settings.syncStrategy)
        .onChange(async (value: keyof typeof syncStrategies) => {
          intervalSettings.setDisabled(value !== "interval");
          this.plugin.settings.syncStrategy = value;
          await this.plugin.saveSettings();
          if (value === "interval") {
            this.plugin.startSyncInterval();
          } else {
            this.plugin.stopSyncInterval();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Download up to date files from remote on startup")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync configs")
      .setDesc("Sync Vault config folder with Google Drive")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncConfigDir)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigDir = value;
            if (value) {
              for (const manager of this.plugin.syncManagers.values()) {
                await manager.addConfigDirToMetadata();
              }
            } else {
              for (const manager of this.plugin.syncManagers.values()) {
                await manager.removeConfigDirFromMetadata();
              }
            }
            await this.plugin.saveSettings();
          });
      });

    const conflictHandlingOptions = {
      overwriteLocal: "Overwrite local file",
      ask: "Ask",
      overwriteRemote: "Overwrite remote file",
    };
    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc(
        "What to do in case remote and local files conflict when syncing with Google Drive",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(conflictHandlingOptions)
          .setValue(this.plugin.settings.conflictHandling)
          .onChange(async (value: keyof typeof conflictHandlingOptions) => {
            this.plugin.settings.conflictHandling = value;
            await this.plugin.saveSettings();
          });
      });

    // ── Interface ──
    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc("Displays the status bar item that show the file sync status")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showStatusBarItem)
          .onChange((value) => {
            this.plugin.settings.showStatusBarItem = value;
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show sync button")
      .setDesc("Displays a ribbon button to sync files")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSyncRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showSyncRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showSyncRibbonIcon();
            } else {
              this.plugin.hideSyncRibbonIcon();
            }
          });
      });

    new Setting(containerEl)
      .setName("Show conflicts view button")
      .setDesc("Displays a ribbon button that opens the conflicts view")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showConflictsRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showConflictsRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showConflictsRibbonIcon();
            } else {
              this.plugin.hideConflictsRibbonIcon();
            }
          });
      });

    const diffModeOptions = {
      default: "Default",
      unified: "Unified",
      split: "Split",
    };
    new Setting(containerEl)
      .setName("Conflict resolution view mode")
      .setDesc("Set which diff view mode should be shown in case of conflicts")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(diffModeOptions)
          .setValue(this.plugin.settings.conflictViewMode)
          .onChange(async (value: keyof typeof diffModeOptions) => {
            this.plugin.settings.conflictViewMode = value;
            await this.plugin.saveSettings();
          });
      });

    // ── Extra ──
    new Setting(containerEl).setName("Extra").setHeading();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        "If enabled logs from this plugin will be saved in a file in your config directory.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange((value) => {
            this.plugin.settings.enableLogging = value;
            if (value) {
              this.plugin.logger.enable();
            } else {
              this.plugin.logger.disable();
            }
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Copy logs")
      .setDesc("Copy the log file content, this is useful to report bugs.")
      .addButton((button) => {
        button.setButtonText("Copy").onClick(async () => {
          const logs: string = await this.plugin.logger.read();
          try {
            await copyToClipboard(logs);
            new Notice("Logs copied", 5000);
          } catch (err) {
            new Notice(`Failed copying logs: ${err}`, 10000);
          }
        });
      });

    new Setting(containerEl)
      .setName("Clean logs")
      .setDesc("Delete all existing logs.")
      .addButton((button) => {
        button.setButtonText("Clean").onClick(async () => {
          await this.plugin.logger.clean();
        });
      });

    new Setting(containerEl)
      .setName("Reset")
      .setDesc("Reset the plugin settings and metadata")
      .addButton((button) => {
        button
          .setButtonText("RESET")
          .setCta()
          .onClick(() => {
            const modal = new Modal(this.plugin.app);
            modal.setTitle("Are you sure?");
            modal.setContent(
              "This will completely delete all sync metadata and plugin settings.\n" +
                "You'll have to repeat the first sync if you want to use the plugin again.",
            );
            new Setting(modal.contentEl);
            new Setting(modal.contentEl)
              .addButton((btn) =>
                btn
                  .setButtonText("Reset")
                  .setCta()
                  .onClick(async () => {
                    await this.plugin.reset();
                    modal.close();
                  }),
              )
              .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                  modal.close();
                }),
              );
            modal.open();
          });
      });
  }

  private renderProfile(
    containerEl: HTMLElement,
    profile: SyncProfile,
    index: number,
  ) {
    const profiles = this.plugin.settings.profiles;

    // Single setting with all profile controls stacked vertically
    const connectionStatus = profile.googleRefreshToken
      ? "Connected"
      : "Not connected";

    const setting = new Setting(containerEl)
      .setClass("gdrive-sync-profile-item")
      .setName(profile.name || `Profile ${index + 1}`)
      .setDesc(connectionStatus);

    const ctrl = setting.controlEl;

    // Profile name
    const nameRow = ctrl.createDiv({ cls: "gdrive-sync-profile-row" });
    nameRow.createEl("label", { text: "Profile name" });
    const nameInput = nameRow.createEl("input", {
      type: "text",
      placeholder: "My Profile",
      value: profile.name,
    });
    nameInput.addEventListener("input", async () => {
      profile.name = nameInput.value;
      setting.setName(nameInput.value || `Profile ${index + 1}`);
      await this.plugin.saveSettings();
    });

    // Local folder
    const folderRow = ctrl.createDiv({ cls: "gdrive-sync-profile-row" });
    folderRow.createEl("label", { text: "Local folder" });
    const folderInput = folderRow.createEl("input", {
      type: "text",
      placeholder: "e.g. some/folder",
      value: profile.localFolder,
    });
    folderInput.addEventListener("input", async () => {
      profile.localFolder = folderInput.value;
      await this.plugin.saveSettings();
    });

    // Connection
    const connectRow = ctrl.createDiv({ cls: "gdrive-sync-profile-row" });
    connectRow.createEl("label", { text: "Connection" });
    const connectBtn = connectRow.createEl("button", {
      text: profile.googleRefreshToken ? "Disconnect" : "Connect",
    });
    if (!profile.googleRefreshToken) {
      connectBtn.addClass("mod-cta");
    }
    connectBtn.addEventListener("click", async () => {
      if (profile.googleRefreshToken) {
        profile.googleRefreshToken = "";
        profile.googleAccessToken = "";
        profile.googleTokenExpiry = 0;
        await this.plugin.saveSettings();
      } else {
        await this.plugin.startOAuthFlow(profile.id);
      }
      this.display();
    });

    // Drive folder name
    const driveRow = ctrl.createDiv({ cls: "gdrive-sync-profile-row" });
    driveRow.createEl("label", { text: "Drive folder name" });
    const driveInput = driveRow.createEl("input", {
      type: "text",
      placeholder: "ObsidianSync",
      value: profile.driveFolderName,
    });
    driveInput.addEventListener("input", async () => {
      profile.driveFolderName = driveInput.value || "ObsidianSync";
      await this.plugin.saveSettings();
    });

    // Encryption password
    const passRow = ctrl.createDiv({ cls: "gdrive-sync-profile-row" });
    passRow.createEl("label", { text: "Encryption password" });
    const passContainer = passRow.createDiv({
      cls: "gdrive-sync-profile-password",
    });
    const passInput = passContainer.createEl("input", {
      type: "password",
      placeholder: "Password",
      value: profile.encryptionPassword,
    });
    const toggleBtn = passContainer.createEl("button");
    toggleBtn.addClass("clickable-icon");
    setIcon(toggleBtn, "eye-off");
    toggleBtn.addEventListener("click", () => {
      if (passInput.type === "password") {
        passInput.type = "text";
        setIcon(toggleBtn, "eye");
      } else {
        passInput.type = "password";
        setIcon(toggleBtn, "eye-off");
      }
    });
    passInput.addEventListener("input", async () => {
      profile.encryptionPassword = passInput.value;
      await this.plugin.saveSettings();
      if (passInput.value) {
        const manager = this.plugin.getSyncManager(profile.id);
        if (manager) {
          await manager.initCryptoKey();
        }
      }
    });

    // Reorder + Delete buttons
    const actionRow = ctrl.createDiv({ cls: "gdrive-sync-profile-actions" });

    if (index > 0) {
      const upBtn = actionRow.createEl("button");
      upBtn.addClass("clickable-icon");
      setIcon(upBtn, "arrow-up");
      upBtn.addEventListener("click", async () => {
        profiles.splice(index, 1);
        profiles.splice(index - 1, 0, profile);
        await this.plugin.saveSettings();
        this.display();
      });
    }
    if (index < profiles.length - 1) {
      const downBtn = actionRow.createEl("button");
      downBtn.addClass("clickable-icon");
      setIcon(downBtn, "arrow-down");
      downBtn.addEventListener("click", async () => {
        profiles.splice(index, 1);
        profiles.splice(index + 1, 0, profile);
        await this.plugin.saveSettings();
        this.display();
      });
    }

    const deleteBtn = actionRow.createEl("button", {
      text: "Delete profile",
    });
    deleteBtn.addClass("mod-warning");
    deleteBtn.addEventListener("click", async () => {
      const modal = new Modal(this.plugin.app);
      modal.setTitle("Delete profile?");
      modal.setContent(
        `This will remove the profile "${profile.name}" and its metadata.`,
      );
      new Setting(modal.contentEl)
        .addButton((btn) =>
          btn
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              profiles.splice(index, 1);
              await this.plugin.saveSettings();
              await this.plugin.initSyncManagers();
              modal.close();
              this.display();
            }),
        )
        .addButton((btn) =>
          btn.setButtonText("Cancel").onClick(() => {
            modal.close();
          }),
        );
      modal.open();
    });
  }
}
