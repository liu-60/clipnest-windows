export type ClipboardType = "text" | "link" | "image";

export interface ClipboardItem {
  id: string;
  type: ClipboardType;
  content: string;
  preview: string;
  createdAt: number;
  updatedAt?: number;
  pinned: boolean;
  tags?: string[];
  byteSize: number;
  width?: number;
  height?: number;
}

export interface ClipnestSettings {
  startupSupported: boolean;
  startupEnabled: boolean;
  storageDirectory: string;
  maxHistoryItems: number;
  cloudEnabled: boolean;
  cloudEndpoint: string;
  cloudProjectId: string;
  cloudConfigured: boolean;
  cloudSyncState: CloudSyncState;
  cloudLastSyncAt: number | null;
  cloudError: string | null;
}

export type CloudSyncState = "disabled" | "idle" | "syncing" | "synced" | "error";

export type ClipnestSettingsPatch = Partial<
  Pick<
    ClipnestSettings,
    "startupEnabled" | "maxHistoryItems" | "cloudEnabled" | "cloudEndpoint" | "cloudProjectId"
  >
> & {
  cloudAccessToken?: string;
};

export type UpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  state: UpdateState;
  downloadProgress: number;
  error: string | null;
}

export interface ClipnestApi {
  getHistory: () => Promise<ClipboardItem[]>;
  copyItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  togglePinItem: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  hidePanel: () => Promise<void>;
  getSettings: () => Promise<ClipnestSettings>;
  updateSettings: (patch: ClipnestSettingsPatch) => Promise<ClipnestSettings>;
  chooseStorageDirectory: () => Promise<ClipnestSettings | null>;
  syncCloud: () => Promise<ClipnestSettings>;
  getUpdateInfo: () => Promise<UpdateInfo>;
  checkForUpdates: () => Promise<UpdateInfo>;
  downloadUpdate: () => Promise<UpdateInfo>;
  installUpdate: () => Promise<void>;
  onHistoryUpdated: (callback: (items: ClipboardItem[]) => void) => () => void;
  onSettingsUpdated: (callback: (settings: ClipnestSettings) => void) => () => void;
  onUpdateState: (callback: (update: UpdateInfo) => void) => () => void;
  onPanelShown: (callback: () => void) => () => void;
  onNavigateSettings: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    clipnest: ClipnestApi;
  }
}

export {};
