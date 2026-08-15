export type ClipboardType = "text" | "link" | "image";

export interface ClipboardItem {
  id: string;
  type: ClipboardType;
  content: string;
  preview: string;
  createdAt: number;
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
}

export type ClipnestSettingsPatch = Partial<
  Pick<ClipnestSettings, "startupEnabled" | "maxHistoryItems">
>;

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
  onHistoryUpdated: (callback: (items: ClipboardItem[]) => void) => () => void;
  onSettingsUpdated: (callback: (settings: ClipnestSettings) => void) => () => void;
  onPanelShown: (callback: () => void) => () => void;
  onNavigateSettings: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    clipnest: ClipnestApi;
  }
}

export {};
