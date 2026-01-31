export interface GDriveSyncSettings {
  firstSync: boolean;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  googleTokenExpiry: number;
  encryptionPassword: string;
  driveFolderId: string;
  driveFolderName: string;
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  syncConfigDir: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  firstSync: true,
  googleClientId: "",
  googleClientSecret: "",
  googleRefreshToken: "",
  googleAccessToken: "",
  googleTokenExpiry: 0,
  encryptionPassword: "",
  driveFolderId: "",
  driveFolderName: "ObsidianSync",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
};
