import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Modal,
  Notice,
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
    const detailsEl = containerEl.createEl("details", {
      cls: "gdrive-sync-profile",
    });
    const summaryEl = detailsEl.createEl("summary");
    summaryEl.setText(profile.name || `Profile ${index + 1}`);

    // Profile name
    new Setting(detailsEl)
      .setName("Profile name")
      .addText((text) =>
        text
          .setPlaceholder("My Profile")
          .setValue(profile.name)
          .onChange(async (value) => {
            profile.name = value;
            summaryEl.setText(value || `Profile ${index + 1}`);
            await this.plugin.saveSettings();
          }),
      );

    // Local folder
    new Setting(detailsEl)
      .setName("Local folder")
      .setDesc("Leave empty to sync the whole vault, or set a subfolder path")
      .addText((text) =>
        text
          .setPlaceholder("e.g. some/folder")
          .setValue(profile.localFolder)
          .onChange(async (value) => {
            profile.localFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    // Connection status
    const connectionStatus = profile.googleRefreshToken
      ? "Connected"
      : "Not connected";

    const connectSetting = new Setting(detailsEl)
      .setName("Connection status")
      .setDesc(connectionStatus);

    if (profile.googleRefreshToken) {
      connectSetting.addButton((button) =>
        button.setButtonText("Disconnect").onClick(async () => {
          profile.googleRefreshToken = "";
          profile.googleAccessToken = "";
          profile.googleTokenExpiry = 0;
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    } else {
      connectSetting.addButton((button) =>
        button
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            await this.plugin.startOAuthFlow(profile.id);
            this.display();
          }),
      );
    }

    // Drive folder name
    new Setting(detailsEl)
      .setName("Drive folder name")
      .setDesc("Name of the folder in Google Drive to sync to")
      .addText((text) =>
        text
          .setPlaceholder("ObsidianSync")
          .setValue(profile.driveFolderName)
          .onChange(async (value) => {
            profile.driveFolderName = value || "ObsidianSync";
            await this.plugin.saveSettings();
          }),
      );

    // Encryption password
    let passwordInput: TextComponent;
    new Setting(detailsEl)
      .setName("Encryption password")
      .setDesc(
        "All files are encrypted with this password before uploading. " +
          "There is no way to recover data if you forget this password.",
      )
      .addButton((button) =>
        button.setIcon("eye-off").onClick(() => {
          if (passwordInput.inputEl.type === "password") {
            passwordInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            passwordInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Password")
          .setValue(profile.encryptionPassword)
          .onChange(async (value) => {
            profile.encryptionPassword = value;
            await this.plugin.saveSettings();
            if (value) {
              const manager = this.plugin.getSyncManager(profile.id);
              if (manager) {
                await manager.initCryptoKey();
              }
            }
          }).inputEl.type = "password";
        passwordInput = text;
      });

    // Reorder + Delete buttons
    const actionSetting = new Setting(detailsEl);

    if (index > 0) {
      actionSetting.addButton((button) =>
        button.setIcon("arrow-up").onClick(async () => {
          profiles.splice(index, 1);
          profiles.splice(index - 1, 0, profile);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    }
    if (index < profiles.length - 1) {
      actionSetting.addButton((button) =>
        button.setIcon("arrow-down").onClick(async () => {
          profiles.splice(index, 1);
          profiles.splice(index + 1, 0, profile);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    }

    actionSetting.addButton((button) =>
      button
        .setButtonText("Delete profile")
        .setWarning()
        .onClick(async () => {
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
        }),
    );
  }
}
