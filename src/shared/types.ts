export type ClipboardType = "text" | "link" | "image";

export interface ClipboardItem {
  id: string;
  type: ClipboardType;
  content: string;
  preview: string;
  createdAt: number;
  pinned: boolean;
  byteSize: number;
  width?: number;
  height?: number;
}

export interface ClipnestApi {
  getHistory: () => Promise<ClipboardItem[]>;
  copyItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  togglePinItem: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  hidePanel: () => Promise<void>;
  onHistoryUpdated: (callback: (items: ClipboardItem[]) => void) => () => void;
  onPanelShown: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    clipnest: ClipnestApi;
  }
}

export {};
