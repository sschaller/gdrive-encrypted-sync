export interface SyncProfile {
  id: string;
  name: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  googleTokenExpiry: number;
  encryptionPassword: string;
  driveFolderName: string;
  localFolder: string;
  syncConfigDir: boolean;
}

export interface GDriveSyncSettings {
  googleClientId: string;
  googleClientSecret: string;
  oauthRedirectUri: string;
  profiles: SyncProfile[];
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
}

export function createDefaultProfile(): SyncProfile {
  return {
    id: crypto.randomUUID(),
    name: "Default",
    googleRefreshToken: "",
    googleAccessToken: "",
    googleTokenExpiry: 0,
    encryptionPassword: "",
    driveFolderName: "ObsidianSync",
    localFolder: "",
    syncConfigDir: false,
  };
}

export const DEFAULT_OAUTH_REDIRECT_URI =
  "https://sschaller.github.io/oauth-redirect.html";

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  googleClientId: "",
  googleClientSecret: "",
  oauthRedirectUri: DEFAULT_OAUTH_REDIRECT_URI,
  profiles: [createDefaultProfile()],
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
};
