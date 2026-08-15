import { contextBridge, ipcRenderer } from "electron";
import type {
  ClipboardItem,
  ClipnestApi,
  ClipnestSettings,
  ClipnestSettingsPatch,
} from "../shared/types";

const api: ClipnestApi = {
  getHistory: () => ipcRenderer.invoke("history:get"),
  copyItem: (id: string) => ipcRenderer.invoke("history:copy", id),
  deleteItem: (id: string) => ipcRenderer.invoke("history:delete", id),
  togglePinItem: (id: string) => ipcRenderer.invoke("history:pin", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  hidePanel: () => ipcRenderer.invoke("panel:hide"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: ClipnestSettingsPatch) => ipcRenderer.invoke("settings:update", patch),
  chooseStorageDirectory: () => ipcRenderer.invoke("settings:storage:choose"),
  onHistoryUpdated: (callback: (items: ClipboardItem[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, items: ClipboardItem[]) => callback(items);
    ipcRenderer.on("history:updated", listener);
    return () => ipcRenderer.removeListener("history:updated", listener);
  },
  onSettingsUpdated: (callback: (settings: ClipnestSettings) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: ClipnestSettings) => callback(settings);
    ipcRenderer.on("settings:updated", listener);
    return () => ipcRenderer.removeListener("settings:updated", listener);
  },
  onPanelShown: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("panel:shown", listener);
    return () => ipcRenderer.removeListener("panel:shown", listener);
  },
  onNavigateSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("navigation:settings", listener);
    return () => ipcRenderer.removeListener("navigation:settings", listener);
  },
};

contextBridge.exposeInMainWorld("clipnest", api);
