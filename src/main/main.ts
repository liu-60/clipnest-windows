import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ClipboardItem,
  ClipboardType,
  ClipnestSettings,
  ClipnestSettingsPatch,
} from "../shared/types";
import type { OpenDialogOptions } from "electron";

const DEFAULT_MAX_HISTORY_ITEMS = 100;
const MIN_MAX_HISTORY_ITEMS = 20;
const MAX_MAX_HISTORY_ITEMS = 2_000;
const MAX_HISTORY_BYTES = 25_000_000;
const POLL_INTERVAL_MS = 450;
const MAX_STORED_IMAGE_BYTES = 5_000_000;
const PANEL_WIDTH = 1200;
const PANEL_HEIGHT = 560;
const HISTORY_FILE_NAME = "history.json";
const STARTUP_ARGUMENT = "--hidden";
const APP_DISPLAY_NAME = "ClipNest";

interface AppSettings {
  startupConfigured: boolean;
  startupEnabled: boolean;
  storageDirectory: string;
  maxHistoryItems: number;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let history: ClipboardItem[] = [];
let lastClipboardSignature = "";
let storeDirectory = "";
let storePath = "";
let settingsPath = "";
let appSettings: AppSettings = {
  startupConfigured: false,
  startupEnabled: true,
  storageDirectory: "",
  maxHistoryItems: DEFAULT_MAX_HISTORY_ITEMS,
};
let startupEnabled = false;
let pollTimer: NodeJS.Timeout | null = null;
let blurTimer: NodeJS.Timeout | null = null;

const appIconSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="58" fill="#4f56d8"/>
    <path d="M78 53h58c45 0 70 22 70 59s-25 59-70 59h-22v32H78V53Zm36 31v56h21c23 0 35-10 35-28s-12-28-35-28h-21Z" fill="#fff"/>
  </svg>`;

function fingerprint(type: ClipboardType, content: string): string {
  return createHash("sha256").update(`${type}:${content}`).digest("hex");
}

function isStartupSupported(): boolean {
  return process.platform === "win32" && app.isPackaged;
}

function startupLoginItemOptions(): { path: string; args: string[] } {
  return {
    path: process.execPath,
    args: [STARTUP_ARGUMENT],
  };
}

function defaultStorageDirectory(): string {
  return join(app.getPath("appData"), "ClipNest");
}

function clampMaxHistoryItems(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_HISTORY_ITEMS;
  return Math.min(MAX_MAX_HISTORY_ITEMS, Math.max(MIN_MAX_HISTORY_ITEMS, Math.round(value)));
}

function loadAppSettings(): void {
  const defaultDirectory = defaultStorageDirectory();
  settingsPath = join(defaultDirectory, "settings.json");
  appSettings = {
    startupConfigured: false,
    startupEnabled: true,
    storageDirectory: defaultDirectory,
    maxHistoryItems: DEFAULT_MAX_HISTORY_ITEMS,
  };

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<AppSettings>;
      if (typeof parsed.startupConfigured === "boolean") {
        appSettings.startupConfigured = parsed.startupConfigured;
      }
      if (typeof parsed.startupEnabled === "boolean") {
        appSettings.startupEnabled = parsed.startupEnabled;
      }
      if (typeof parsed.storageDirectory === "string" && parsed.storageDirectory.trim()) {
        appSettings.storageDirectory = resolve(parsed.storageDirectory);
      }
      if (typeof parsed.maxHistoryItems === "number") {
        appSettings.maxHistoryItems = clampMaxHistoryItems(parsed.maxHistoryItems);
      }
    } catch (error) {
      console.warn("ClipNest: unable to read app settings", error);
    }
  }

  storeDirectory = resolve(appSettings.storageDirectory);
  storePath = join(storeDirectory, HISTORY_FILE_NAME);
}

function saveAppSettings(): void {
  if (!settingsPath) return;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), "utf8");
  } catch (error) {
    console.warn("ClipNest: unable to persist app settings", error);
  }
}

function getAppSettingsSnapshot(): ClipnestSettings {
  return {
    startupSupported: isStartupSupported(),
    startupEnabled: isStartupSupported() ? startupEnabled : false,
    storageDirectory: storeDirectory,
    maxHistoryItems: appSettings.maxHistoryItems,
  };
}

function sendSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("settings:updated", getAppSettingsSnapshot());
}

function getStartupEnabled(): boolean {
  if (!isStartupSupported()) return false;

  try {
    return app.getLoginItemSettings(startupLoginItemOptions()).openAtLogin;
  } catch (error) {
    console.warn("ClipNest: unable to read Windows startup setting", error);
    return false;
  }
}

function setStartupEnabled(enabled: boolean): void {
  if (!isStartupSupported()) {
    startupEnabled = false;
    refreshTrayMenu();
    sendSettings();
    return;
  }

  try {
    app.setLoginItemSettings({
      ...startupLoginItemOptions(),
      openAtLogin: enabled,
      enabled,
      name: APP_DISPLAY_NAME,
    });
    startupEnabled = enabled;
    appSettings = {
      ...appSettings,
      startupConfigured: true,
      startupEnabled: enabled,
    };
    saveAppSettings();

    if (getStartupEnabled() !== enabled) {
      console.warn(`ClipNest: Windows startup setting did not apply (requested=${enabled})`);
    }
  } catch (error) {
    console.warn("ClipNest: unable to update Windows startup setting", error);
  }

  refreshTrayMenu();
  sendSettings();
}

function configureStartup(): void {
  loadAppSettings();
  if (!isStartupSupported()) {
    startupEnabled = false;
    sendSettings();
    return;
  }

  const preferredState = appSettings.startupConfigured
    ? appSettings.startupEnabled
    : true;
  setStartupEnabled(preferredState);
}

function isLink(text: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(text.trim());
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 280);
}

function isClipboardItem(value: unknown): value is ClipboardItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ClipboardItem>;
  return (
    typeof item.id === "string" &&
    (item.type === "text" || item.type === "link" || item.type === "image") &&
    typeof item.content === "string" &&
    typeof item.preview === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.pinned === "boolean" &&
    typeof item.byteSize === "number" &&
    (item.tags === undefined || Array.isArray(item.tags))
  );
}

function readHistoryFromPath(path: string): ClipboardItem[] {
  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed
        .filter(isClipboardItem)
        .sort((left, right) => right.createdAt - left.createdAt);
    } catch {
      // Try the backup before falling back to an empty history.
    }
  }

  return [];
}

function loadHistory(): void {
  if (!storePath) return;
  history = readHistoryFromPath(storePath);
  trimHistory();
}

function mergeHistories(primary: ClipboardItem[], secondary: ClipboardItem[]): ClipboardItem[] {
  const seen = new Set<string>();
  return [...primary, ...secondary]
    .filter((item) => {
      const key = `${item.type}:${item.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

function saveHistory(): void {
  if (!storePath) return;
  const tempPath = `${storePath}.tmp`;
  const backupPath = `${storePath}.bak`;

  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(history), "utf8");
    if (existsSync(storePath)) {
      if (existsSync(backupPath)) unlinkSync(backupPath);
      renameSync(storePath, backupPath);
    }
    renameSync(tempPath, storePath);
    if (existsSync(backupPath)) unlinkSync(backupPath);
  } catch (error) {
    try {
      if (!existsSync(storePath) && existsSync(backupPath)) renameSync(backupPath, storePath);
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch (recoveryError) {
      console.warn("ClipNest: history recovery failed", recoveryError);
    }
    console.warn("ClipNest: unable to persist clipboard history", error);
  }
}

function sendHistory(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("history:updated", history);
}

function trimHistory(): void {
  const ordered = [...history].sort((left, right) => right.createdAt - left.createdAt);
  const pinned = ordered.filter((item) => item.pinned);
  const unpinned = ordered.filter((item) => !item.pinned);
  const unpinnedLimit = Math.max(0, appSettings.maxHistoryItems - pinned.length);
  history = [...pinned, ...unpinned.slice(0, unpinnedLimit)].sort(
    (left, right) => right.createdAt - left.createdAt,
  );

  let totalBytes = history.reduce((total, item) => total + item.byteSize, 0);
  while (totalBytes > MAX_HISTORY_BYTES && history.some((item) => !item.pinned)) {
    const oldestUnpinnedIndex = [...history]
      .map((item, index) => ({ item, index }))
      .reverse()
      .find(({ item }) => !item.pinned)?.index;
    if (oldestUnpinnedIndex === undefined) break;
    totalBytes -= history[oldestUnpinnedIndex].byteSize;
    history.splice(oldestUnpinnedIndex, 1);
  }
}

function setMaxHistoryItems(value: number): void {
  const nextValue = clampMaxHistoryItems(value);
  if (appSettings.maxHistoryItems === nextValue) return;

  appSettings = { ...appSettings, maxHistoryItems: nextValue };
  trimHistory();
  saveAppSettings();
  saveHistory();
  sendHistory();
  sendSettings();
}

function setStorageDirectory(directory: string): void {
  const nextDirectory = resolve(directory);
  mkdirSync(nextDirectory, { recursive: true });
  const nextPath = join(nextDirectory, HISTORY_FILE_NAME);
  const previousPath = storePath;
  const samePath = previousPath && resolve(previousPath).toLowerCase() === nextPath.toLowerCase();

  if (samePath) return;

  const targetAlreadyExists = existsSync(nextPath);
  if (targetAlreadyExists) {
    history = mergeHistories(history, readHistoryFromPath(nextPath));
  }

  storeDirectory = nextDirectory;
  storePath = nextPath;
  appSettings = { ...appSettings, storageDirectory: nextDirectory };
  trimHistory();
  saveHistory();
  saveAppSettings();

  // Only remove the old active file after the new location has been written.
  // If the destination already had data, keep the old copy as a safety net.
  if (!targetAlreadyExists && previousPath && existsSync(nextPath) && existsSync(previousPath)) {
    try {
      unlinkSync(previousPath);
    } catch (error) {
      console.warn("ClipNest: unable to remove old history location", error);
    }
  }

  sendHistory();
  sendSettings();
}

function updateAppSettings(patch: unknown): ClipnestSettings {
  if (!patch || typeof patch !== "object") return getAppSettingsSnapshot();
  const nextPatch = patch as ClipnestSettingsPatch;

  if (typeof nextPatch.startupEnabled === "boolean") {
    setStartupEnabled(nextPatch.startupEnabled);
  }
  if (typeof nextPatch.maxHistoryItems === "number") {
    setMaxHistoryItems(nextPatch.maxHistoryItems);
  }

  return getAppSettingsSnapshot();
}

async function chooseStorageDirectory(): Promise<ClipnestSettings | null> {
  const options: OpenDialogOptions = {
    title: "选择剪切板历史保存位置",
    buttonLabel: "使用此文件夹",
    properties: ["openDirectory", "createDirectory"],
  };
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;

  setStorageDirectory(result.filePaths[0]);
  return getAppSettingsSnapshot();
}

function addHistoryItem(item: ClipboardItem): void {
  const duplicate = history.find(
    (existing) => existing.type === item.type && existing.content === item.content,
  );

  if (duplicate) {
    history = [
      { ...duplicate, createdAt: item.createdAt },
      ...history.filter((existing) => existing.id !== duplicate.id),
    ];
  } else {
    history = [item, ...history];
  }

  trimHistory();
  saveHistory();
  sendHistory();
}

function readClipboardImage(): { item: ClipboardItem; signature: string } | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const size = image.getSize();
  const largestSide = Math.max(size.width, size.height);
  const scale = Math.min(1, 960 / Math.max(1, largestSide));
  const normalizedImage = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      })
    : image;

  const normalizedPng = normalizedImage.toPNG();
  let bytes = normalizedPng;
  let mimeType = "image/png";

  // Photos can still produce large PNGs after resizing. Keep the copy instead
  // of dropping it by falling back to a bounded JPEG representation.
  if (bytes.byteLength > MAX_STORED_IMAGE_BYTES) {
    bytes = normalizedImage.toJPEG(82);
    mimeType = "image/jpeg";
  }
  if (bytes.byteLength > MAX_STORED_IMAGE_BYTES) return null;

  return {
    signature: fingerprint("image", normalizedPng.toString("base64")),
    item: {
      id: randomUUID(),
      type: "image",
      content: `data:${mimeType};base64,${bytes.toString("base64")}`,
      preview: `图片 ${size.width} × ${size.height}`,
      createdAt: Date.now(),
      pinned: false,
      tags: [],
      byteSize: bytes.byteLength,
      width: size.width,
      height: size.height,
    },
  };
}

function readClipboardItem(): { item: ClipboardItem; signature: string } | null {
  try {
    const formats = clipboard.availableFormats();
    const hasImageFormat = formats.some((format) =>
      /image\/|bitmap|dib|png|jpeg|jpg|gif/i.test(format),
    );

    // On Windows an image copy can expose a stale text representation too.
    // Read the native image first whenever the native formats identify one.
    if (hasImageFormat || formats.length === 0) {
      const image = readClipboardImage();
      if (image) return image;
    }

    const text = clipboard.readText();
    if (!text) return null;
    const type: ClipboardType = isLink(text) ? "link" : "text";
    return {
      signature: fingerprint(type, text),
      item: {
        id: randomUUID(),
        type,
        content: text,
        preview: previewText(text),
        createdAt: Date.now(),
        pinned: false,
        tags: [],
        byteSize: Buffer.byteLength(text, "utf8"),
      },
    };
  } catch (error) {
    // Clipboard owners can disappear between reads; one failed poll must not
    // stop the long-running watcher.
    console.warn("ClipNest: clipboard read failed", error);
    return null;
  }
}

function pollClipboard(): void {
  try {
    const payload = readClipboardItem();
    if (!payload || payload.signature === lastClipboardSignature) return;
    lastClipboardSignature = payload.signature;
    addHistoryItem(payload.item);
  } catch (error) {
    console.warn("ClipNest: clipboard polling failed", error);
  }
}

function positionPanel(): void {
  if (!mainWindow) return;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const bounds = mainWindow.getBounds();
  const margin = 14;
  const x = Math.min(
    Math.max(area.x + margin, cursor.x - Math.round(bounds.width / 2)),
    area.x + area.width - bounds.width - margin,
  );
  const below = cursor.y + 18;
  const y = below + bounds.height <= area.y + area.height - margin
    ? below
    : Math.max(area.y + margin, cursor.y - bounds.height - 18);

  mainWindow.setPosition(Math.round(x), Math.round(y), false);
}

function hidePanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function showPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (blurTimer) clearTimeout(blurTimer);
  positionPanel();
  mainWindow.showInactive();
  mainWindow.focus();
  mainWindow.webContents.send("panel:shown");
}

function showSettings(): void {
  showPanel();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("navigation:settings");
}

function createMainWindow(): void {
  const preloadPath = join(__dirname, "../preload/preload.js");
  const windowIcon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(appIconSvg).toString("base64")}`,
  );
  mainWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    icon: windowIcon,
    minWidth: 960,
    minHeight: 430,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#f5f5fb",
    title: "ClipNest",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.on("blur", () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!isQuitting && mainWindow && !mainWindow.isFocused()) hidePanel();
    }, 120);
  });
  mainWindow.on("focus", () => {
    if (blurTimer) clearTimeout(blurTimer);
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hidePanel();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    sendHistory();
    sendSettings();
  });
  mainWindow.once("ready-to-show", () => {
    if (process.argv.includes("--show")) setTimeout(showPanel, 80);
  });
}

function clearUnpinnedHistory(): void {
  history = history.filter((item) => item.pinned);
  saveHistory();
  sendHistory();
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(appIconSvg).toString("base64")}`,
  ).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("ClipNest 剪切板");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", showPanel);
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
      { label: "打开 ClipNest", click: showPanel },
      { label: "设置", click: showSettings },
      {
        label: "开机自启",
        type: "checkbox",
        checked: startupEnabled,
        enabled: isStartupSupported(),
        click: () => setStartupEnabled(!startupEnabled),
      },
      { label: "清除非收藏历史", click: clearUnpinnedHistory },
      { type: "separator" },
      { label: "退出 ClipNest", click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

function registerIpc(): void {
  ipcMain.handle("history:get", () => history);
  ipcMain.handle("settings:get", () => getAppSettingsSnapshot());
  ipcMain.handle("settings:update", (_event, patch: unknown) => updateAppSettings(patch));
  ipcMain.handle("settings:storage:choose", chooseStorageDirectory);
  ipcMain.handle("history:copy", (_event, id: string) => {
    const item = history.find((candidate) => candidate.id === id);
    if (!item) return;

    if (item.type === "image") {
      const image = nativeImage.createFromDataURL(item.content);
      clipboard.writeImage(image);
      // Compare pixels rather than the stored data URL. JPEG fallback images
      // are re-encoded by Windows when read back from the clipboard.
      lastClipboardSignature = fingerprint("image", image.toPNG().toString("base64"));
    } else {
      clipboard.writeText(item.content);
      lastClipboardSignature = fingerprint(item.type, item.content);
    }
    hidePanel();
  });
  ipcMain.handle("history:delete", (_event, id: string) => {
    const item = history.find((candidate) => candidate.id === id);
    if (!item || item.pinned) return;
    history = history.filter((candidate) => candidate.id !== id);
    saveHistory();
    sendHistory();
  });
  ipcMain.handle("history:pin", (_event, id: string) => {
    history = history.map((item) =>
      item.id === id
        ? {
            ...item,
            pinned: !item.pinned,
            tags: !item.pinned ? ["常用"] : [],
          }
        : item,
    );
    saveHistory();
    sendHistory();
  });
  ipcMain.handle("history:clear", clearUnpinnedHistory);
  ipcMain.handle("panel:hide", hidePanel);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (!commandLine.includes(STARTUP_ARGUMENT)) showPanel();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId("com.clipnest.app");
    // Keep the data location stable even when the app is launched from a
    // portable folder or the executable is rebuilt with a different name.
    configureStartup();
    loadHistory();
    configureStartup();
    createMainWindow();
    createTray();
    registerIpc();

    const registered = globalShortcut.register("CommandOrControl+Shift+V", showPanel);
    if (!registered) {
      console.warn("ClipNest: 无法注册 Ctrl+Shift+V，可能已被其他软件占用。");
    }

    pollClipboard();
    pollTimer = setInterval(pollClipboard, POLL_INTERVAL_MS);
  });

  app.on("activate", showPanel);
  app.on("window-all-closed", () => {
    // ClipNest stays alive in the tray even if the panel is closed.
  });
  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (pollTimer) clearInterval(pollTimer);
    tray?.destroy();
  });
}
