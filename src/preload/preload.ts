import { contextBridge, ipcRenderer } from "electron";
import type { ClipboardItem, ClipnestApi } from "../shared/types";

const api: ClipnestApi = {
  getHistory: () => ipcRenderer.invoke("history:get"),
  copyItem: (id: string) => ipcRenderer.invoke("history:copy", id),
  deleteItem: (id: string) => ipcRenderer.invoke("history:delete", id),
  togglePinItem: (id: string) => ipcRenderer.invoke("history:pin", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  hidePanel: () => ipcRenderer.invoke("panel:hide"),
  onHistoryUpdated: (callback: (items: ClipboardItem[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, items: ClipboardItem[]) => callback(items);
    ipcRenderer.on("history:updated", listener);
    return () => ipcRenderer.removeListener("history:updated", listener);
  },
  onPanelShown: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("panel:shown", listener);
    return () => ipcRenderer.removeListener("panel:shown", listener);
  },
};

contextBridge.exposeInMainWorld("clipnest", api);
