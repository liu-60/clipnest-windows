import { contextBridge, ipcRenderer } from "electron";
import type {
  ClipboardItem,
  ClipnestApi,
  ClipnestSettings,
  ClipnestSettingsPatch,
  UpdateInfo,
} from "../shared/types";
import type { NativeTriggerKey } from "../shared/native-contracts";

const panelShownListeners = new Set<(requestId: string | null, generation: string | null) => void>();
let pendingPanelShown: string | null = null;
let pendingPanelGeneration: string | null = null;
let activePanelGeneration: string | null = null;
let hasPendingPanelShown = false;

ipcRenderer.on("panel:shown", (_event, requestId: string | null, generation: string | null) => {
  activePanelGeneration = typeof generation === "string" ? generation : null;
  if (panelShownListeners.size === 0) {
    pendingPanelShown = requestId;
    pendingPanelGeneration = activePanelGeneration;
    hasPendingPanelShown = true;
    return;
  }
  for (const callback of panelShownListeners) callback(requestId, activePanelGeneration);
});

const api: ClipnestApi = {
  getHistory: () => ipcRenderer.invoke("history:get"),
  copyItem: (id: string, triggerKeys: readonly NativeTriggerKey[] = []) =>
    ipcRenderer.invoke("history:copy", id, triggerKeys, activePanelGeneration),
  editItem: (id: string, content: string) => ipcRenderer.invoke("history:edit", id, content),
  deleteItem: (id: string) => ipcRenderer.invoke("history:delete", id),
  togglePinItem: (id: string) => ipcRenderer.invoke("history:pin", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  hidePanel: () => ipcRenderer.invoke("panel:hide"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: ClipnestSettingsPatch) => ipcRenderer.invoke("settings:update", patch),
  chooseStorageDirectory: () => ipcRenderer.invoke("settings:storage:choose"),
  syncCloud: () => ipcRenderer.invoke("cloud:sync"),
  getUpdateInfo: () => ipcRenderer.invoke("updates:get"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  reportPanelActionable: (requestId: string) => ipcRenderer.send("metrics:panel-actionable", requestId),
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
  onUpdateState: (callback: (update: UpdateInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: UpdateInfo) => callback(update);
    ipcRenderer.on("updates:state", listener);
    return () => ipcRenderer.removeListener("updates:state", listener);
  },
  onPanelShown: (callback: (requestId: string | null, generation: string | null) => void) => {
    panelShownListeners.add(callback);
    if (hasPendingPanelShown) {
      callback(pendingPanelShown, pendingPanelGeneration);
      pendingPanelShown = null;
      pendingPanelGeneration = null;
      hasPendingPanelShown = false;
    }
    return () => panelShownListeners.delete(callback);
  },
  onNavigateSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("navigation:settings", listener);
    return () => ipcRenderer.removeListener("navigation:settings", listener);
  },
};

contextBridge.exposeInMainWorld("clipnest", api);
