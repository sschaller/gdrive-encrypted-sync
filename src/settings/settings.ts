export interface SyncProfile {
  id: string;
  name: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  googleTokenExpiry: number;
  encryptionPassword: string;
  driveFolderId: string;
  driveFolderName: string;
  localFolder: string;
}

export interface GDriveSyncSettings {
  googleClientId: string;
  googleClientSecret: string;
  profiles: SyncProfile[];
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

export function createDefaultProfile(): SyncProfile {
  return {
    id: crypto.randomUUID(),
    name: "Default",
    googleRefreshToken: "",
    googleAccessToken: "",
    googleTokenExpiry: 0,
    encryptionPassword: "",
    driveFolderId: "",
    driveFolderName: "ObsidianSync",
    localFolder: "",
  };
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  googleClientId: "",
  googleClientSecret: "",
  profiles: [createDefaultProfile()],
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
