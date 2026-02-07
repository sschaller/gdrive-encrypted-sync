import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  normalizePath,
  Notice,
} from "obsidian";
import { GDriveSyncSettings, SyncProfile, DEFAULT_SETTINGS } from "./settings/settings";
import GDriveSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  exchangeCodeForTokens,
  waitForOAuthCode,
  handleOAuthCallback,
} from "./gdrive/oauth";
import EventsListener from "./events-listener";

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings;
  syncManagers: Map<string, SyncManager> = new Map();
  eventsListener: EventsListener;
  logger: Logger;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];
  private cancelOAuth: (() => void) | null = null;

  /** Helper to get the first profile's sync manager (for backwards compat in settings UI) */
  getSyncManager(profileId: string): SyncManager | undefined {
    return this.syncManagers.get(profileId);
  }

  async onUserEnable() {
    const unconfigured = this.settings.profiles.some(
      (p) => p.encryptionPassword === "" || p.googleRefreshToken === "",
    );
    if (unconfigured) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.registerObsidianProtocolHandler("gdrive-encrypted-sync", (params) => {
      handleOAuthCallback(params);
    });

    this.addSettingTab(new GDriveSyncSettingsTab(this.app, this));

    await this.initSyncManagers();

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.eventsListener.start(this);

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with Google Drive",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.sync.bind(this),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });
  }

  async initSyncManagers() {
    this.syncManagers.clear();

    for (const profile of this.settings.profiles) {
      const manager = new SyncManager(
        this.app.vault,
        this.settings,
        profile,
        this.onConflicts.bind(this),
        this.logger,
      );
      await manager.loadMetadata();
      if (profile.encryptionPassword) {
        await manager.initCryptoKey();
      }
      this.syncManagers.set(profile.id, manager);
    }

    const entries = this.settings.profiles.map((profile) => ({
      profile,
      metadataStore: this.syncManagers.get(profile.id)!.metadataStore,
    }));

    if (this.eventsListener) {
      this.eventsListener.updateEntries(entries);
    } else {
      this.eventsListener = new EventsListener(
        this.app.vault,
        entries,
        this.settings,
        this.logger,
      );
    }
  }

  async startOAuthFlow(profileId: string) {
    const profile = this.settings.profiles.find((p) => p.id === profileId);
    if (!profile) {
      new Notice("Profile not found");
      return;
    }

    if (!this.settings.googleClientId) {
      new Notice("Set Google Client ID first");
      return;
    }

    // Cancel any leftover flow from a previous attempt
    if (this.cancelOAuth) {
      this.cancelOAuth();
      this.cancelOAuth = null;
    }

    const codeVerifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    const { codePromise, cancel } = waitForOAuthCode(state);
    this.cancelOAuth = cancel;
    const url = buildAuthUrl(this.settings.googleClientId, challenge, this.settings.oauthRedirectUri, state);
    window.open(url);

    try {
      const code = await codePromise;
      const tokens = await exchangeCodeForTokens(
        this.settings.googleClientId,
        this.settings.googleClientSecret,
        code,
        codeVerifier,
        this.settings.oauthRedirectUri,
      );
      profile.googleAccessToken = tokens.access_token;
      profile.googleRefreshToken =
        tokens.refresh_token || profile.googleRefreshToken;
      profile.googleTokenExpiry =
        Date.now() + tokens.expires_in * 1000;
      await this.saveSettings();
      new Notice(`Connected profile "${profile.name}" to Google Drive`);
    } catch (err) {
      new Notice(`OAuth failed: ${err}`);
    } finally {
      this.cancelOAuth = null;
    }
  }

  async sync() {
    const configuredProfiles = this.settings.profiles.filter(
      (p) => p.encryptionPassword !== "" && p.googleRefreshToken !== "",
    );
    if (configuredProfiles.length === 0) {
      new Notice("Sync plugin not configured");
      return;
    }

    for (const profile of configuredProfiles) {
      const manager = this.syncManagers.get(profile.id);
      if (!manager) continue;

      manager.onProgress = (current, total) => {
        this.statusBarItem?.setText(
          `GDrive: Syncing "${profile.name}" ${current}/${total}`,
        );
      };

      const notice = new Notice(`Syncing "${profile.name}"...`);
      try {
        await manager.sync();
        new Notice(`Sync "${profile.name}" successful`, 5000);
      } catch (err) {
        new Notice(`Error syncing "${profile.name}". ${err}`);
      }
      notice.hide();

      manager.onProgress = undefined;
    }

    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
    if (this.cancelOAuth) {
      this.cancelOAuth();
      this.cancelOAuth = null;
    }
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    let state = "Unknown";
    // Check across all managers
    for (const manager of this.syncManagers.values()) {
      const fileData = manager.getFileMetadata(activeFile.path);
      if (fileData) {
        if (fileData.dirty) {
          state = "Outdated";
        } else {
          state = "Up to date";
        }
        break;
      }
    }
    if (state === "Unknown") {
      state = "Untracked";
    }

    this.statusBarItem.setText(`GDrive: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with Google Drive",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    for (const manager of this.syncManagers.values()) {
      try {
        const intervalID = manager.startSyncInterval(
          this.settings.syncInterval,
        );
        this.registerInterval(intervalID);
      } catch {
        // Already running
      }
    }
  }

  stopSyncInterval() {
    for (const manager of this.syncManagers.values()) {
      manager.stopSyncInterval();
    }
  }

  restartSyncInterval() {
    for (const manager of this.syncManagers.values()) {
      manager.stopSyncInterval();
      manager.startSyncInterval(this.settings.syncInterval);
    }
  }

  async reset() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.saveSettings();
    for (const manager of this.syncManagers.values()) {
      await manager.resetMetadata();
    }
    this.syncManagers.clear();
  }
}
