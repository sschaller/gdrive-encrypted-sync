import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  normalizePath,
  Notice,
} from "obsidian";
import { GDriveSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GDriveSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";
import type { Server } from "http";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  exchangeCodeForTokens,
  startLoopbackServer,
} from "./gdrive/oauth";

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings;
  syncManager: SyncManager;
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
  private oauthServer: Server | null = null;

  async onUserEnable() {
    if (
      this.settings.encryptionPassword === "" ||
      this.settings.googleRefreshToken === ""
    ) {
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

    this.addSettingTab(new GDriveSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    await this.syncManager.loadMetadata();

    if (this.settings.encryptionPassword) {
      await this.syncManager.initCryptoKey();
    }

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.syncManager.startEventsListener(this);

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

  async startOAuthFlow() {
    if (!this.settings.googleClientId) {
      new Notice("Set Google Client ID first");
      return;
    }

    // Kill any leftover server from a previous attempt
    if (this.oauthServer) {
      this.oauthServer.close();
      this.oauthServer = null;
    }

    const codeVerifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    const { port, codePromise, server } = await startLoopbackServer(state);
    this.oauthServer = server;
    const redirectUri = `http://127.0.0.1:${port}`;
    const url = buildAuthUrl(this.settings.googleClientId, challenge, redirectUri, state);
    window.open(url);

    try {
      const code = await codePromise;
      const tokens = await exchangeCodeForTokens(
        this.settings.googleClientId,
        this.settings.googleClientSecret,
        code,
        codeVerifier,
        redirectUri,
      );
      this.settings.googleAccessToken = tokens.access_token;
      this.settings.googleRefreshToken =
        tokens.refresh_token || this.settings.googleRefreshToken;
      this.settings.googleTokenExpiry =
        Date.now() + tokens.expires_in * 1000;
      await this.saveSettings();
      new Notice("Connected to Google Drive");
    } catch (err) {
      new Notice(`OAuth failed: ${err}`);
    } finally {
      this.oauthServer = null;
    }
  }

  async sync() {
    if (
      this.settings.encryptionPassword === "" ||
      this.settings.googleRefreshToken === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }
    this.syncManager.onProgress = (current, total) => {
      this.statusBarItem?.setText(`GDrive: Syncing ${current}/${total}`);
    };
    if (this.settings.firstSync) {
      const notice = new Notice("Syncing...");
      try {
        await this.syncManager.firstSync();
        this.settings.firstSync = false;
        this.saveSettings();
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      } catch (err) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
      notice.hide();
    } else {
      await this.syncManager.sync();
    }
    this.syncManager.onProgress = undefined;
    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
    if (this.oauthServer) {
      this.oauthServer.close();
      this.oauthServer = null;
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
    const fileData = this.syncManager.getFileMetadata(activeFile.path);
    if (!fileData) {
      state = "Untracked";
    } else if (fileData.dirty) {
      state = "Outdated";
    } else if (!fileData.dirty) {
      state = "Up to date";
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
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = DEFAULT_SETTINGS;
    this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
