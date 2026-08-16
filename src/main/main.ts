import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
  CloudSyncState,
  UpdateInfo,
} from "../shared/types";
import type { OpenDialogOptions } from "electron";

const DEFAULT_MAX_HISTORY_ITEMS = 100;
const MIN_MAX_HISTORY_ITEMS = 20;
const MAX_MAX_HISTORY_ITEMS = 2_000;
const MAX_HISTORY_BYTES = 25_000_000;
const POLL_INTERVAL_MS = 450;
const MAX_STORED_IMAGE_BYTES = 5_000_000;
const PANEL_HEIGHT = 400;
const HISTORY_FILE_NAME = "history.json";
const STARTUP_ARGUMENT = "--hidden";
const APP_DISPLAY_NAME = "ClipNest";
// Keep the public source free of deployment-specific addresses. The endpoint
// is overridable in Settings and cloud sync remains disabled by default.
const DEFAULT_CLOUD_ENDPOINT = "https://cloud.example.com";
const DEFAULT_CLOUD_PROJECT_ID = "clipnest-windows";
const CLOUD_REQUEST_TIMEOUT_MS = 12_000;
const UPDATE_REQUEST_TIMEOUT_MS = 12_000;
const CLOUD_PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const GITHUB_RELEASE_API = "https://api.github.com/repos/liu-60/clipnest-windows/releases/latest";
const GITHUB_RELEASE_PAGE = "https://github.com/liu-60/clipnest-windows/releases/latest";

interface AppSettings {
  startupConfigured: boolean;
  startupEnabled: boolean;
  storageDirectory: string;
  maxHistoryItems: number;
  cloudEnabled: boolean;
  cloudEndpoint: string;
  cloudProjectId: string;
  cloudAccessToken: string;
  cloudEncryptionKey: string;
  cloudLastSyncAt: number | null;
  cloudTombstones: Record<string, number>;
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
  cloudEnabled: false,
  cloudEndpoint: DEFAULT_CLOUD_ENDPOINT,
  cloudProjectId: DEFAULT_CLOUD_PROJECT_ID,
  cloudAccessToken: "",
  cloudEncryptionKey: "",
  cloudLastSyncAt: null,
  cloudTombstones: {},
};
let startupEnabled = false;
let pollTimer: NodeJS.Timeout | null = null;
let blurTimer: NodeJS.Timeout | null = null;
let panelAnimationTimer: NodeJS.Timeout | null = null;
let cloudSyncTimer: NodeJS.Timeout | null = null;
let cloudSyncPromise: Promise<ClipnestSettings> | null = null;
let cloudSyncQueued = false;
let cloudSyncState: CloudSyncState = "disabled";
let cloudSyncError: string | null = null;
let updateInfo: UpdateInfo = createInitialUpdateInfo();

const appIconSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="58" fill="#f8fafd"/>
    <rect x="10" y="10" width="236" height="236" rx="50" fill="none" stroke="#dbe3ef" stroke-width="8"/>
    <path d="M78 50h68c42 0 68 22 68 58 0 37-26 58-68 58h-30v40H78V50Zm38 34v48h28c20 0 32-8 32-24 0-16-12-24-32-24h-28Z" fill="#347cf3"/>
    <circle cx="188" cy="199" r="10" fill="#347cf3"/>
  </svg>`;

function createAppIcon(size?: number) {
  const iconPath = [
    join(process.resourcesPath, "app.asar.unpacked", "build", "icon.png"),
    join(app.getAppPath(), "build", "icon.png"),
    join(__dirname, "../../build/icon.png"),
  ].find((candidate) => existsSync(candidate));

  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(appIconSvg).toString("base64")}`,
    );
  }

  return size ? icon.resize({ width: size, height: size }) : icon;
}

function applyDataDirectoryOverride(): void {
  const override = process.env.CLIPNEST_DATA_DIR?.trim();
  if (!override) return;

  const dataDirectory = resolve(override);
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath("appData", dataDirectory);
  app.setPath("userData", join(dataDirectory, "userData"));
}

interface EncryptedCloudSnapshot {
  version: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface CloudSnapshot {
  version: 2;
  items: ClipboardItem[];
  tombstones: Record<string, number>;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

function createInitialUpdateInfo(): UpdateInfo {
  return {
    currentVersion: app.getVersion(),
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseUrl: GITHUB_RELEASE_PAGE,
    publishedAt: null,
    state: "idle",
    downloadProgress: 0,
    error: null,
  };
}

function setUpdateInfo(patch: Partial<UpdateInfo>): void {
  updateInfo = { ...updateInfo, ...patch };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("updates:state", updateInfo);
}

function setCloudSyncState(state: CloudSyncState, error: string | null = null): void {
  cloudSyncState = state;
  cloudSyncError = error;
  sendSettings();
}

function normalizeCloudEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isCloudConfigured(): boolean {
  return Boolean(
    normalizeCloudEndpoint(appSettings.cloudEndpoint) &&
    CLOUD_PROJECT_ID_PATTERN.test(appSettings.cloudProjectId) &&
    appSettings.cloudAccessToken,
  );
}

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
    cloudEnabled: false,
    cloudEndpoint: DEFAULT_CLOUD_ENDPOINT,
    cloudProjectId: DEFAULT_CLOUD_PROJECT_ID,
    cloudAccessToken: "",
    cloudEncryptionKey: "",
    cloudLastSyncAt: null,
    cloudTombstones: {},
  };

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<AppSettings> & {
        cloudAccessTokenEncrypted?: string;
      };
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
      if (typeof parsed.cloudEnabled === "boolean") {
        appSettings.cloudEnabled = parsed.cloudEnabled;
      }
      if (typeof parsed.cloudEndpoint === "string" && parsed.cloudEndpoint.trim()) {
        appSettings.cloudEndpoint = parsed.cloudEndpoint.trim();
      }
      if (typeof parsed.cloudProjectId === "string" && CLOUD_PROJECT_ID_PATTERN.test(parsed.cloudProjectId)) {
        appSettings.cloudProjectId = parsed.cloudProjectId;
      }
      if (typeof parsed.cloudAccessTokenEncrypted === "string" && safeStorage.isEncryptionAvailable()) {
        try {
          appSettings.cloudAccessToken = safeStorage
            .decryptString(Buffer.from(parsed.cloudAccessTokenEncrypted, "base64"))
            .trim();
        } catch (error) {
          console.warn("ClipNest: unable to decrypt cloud project token", error);
        }
      } else if (typeof parsed.cloudAccessToken === "string") {
        appSettings.cloudAccessToken = parsed.cloudAccessToken.trim();
      }
      if (typeof parsed.cloudEncryptionKey === "string") {
        appSettings.cloudEncryptionKey = parsed.cloudEncryptionKey;
      }
      if (typeof parsed.cloudLastSyncAt === "number") {
        appSettings.cloudLastSyncAt = parsed.cloudLastSyncAt;
      }
      if (parsed.cloudTombstones && typeof parsed.cloudTombstones === "object") {
        appSettings.cloudTombstones = Object.fromEntries(
          Object.entries(parsed.cloudTombstones).filter(
            ([key, value]) => typeof key === "string" && typeof value === "number" && Number.isFinite(value),
          ),
        );
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
    const { cloudAccessToken, ...settingsWithoutToken } = appSettings;
    const persistedSettings: Record<string, unknown> = { ...settingsWithoutToken };
    if (cloudAccessToken) {
      if (safeStorage.isEncryptionAvailable()) {
        persistedSettings.cloudAccessTokenEncrypted = safeStorage
          .encryptString(cloudAccessToken)
          .toString("base64");
      } else {
        console.warn("ClipNest: cloud project token was not persisted because safeStorage is unavailable");
      }
    }
    writeFileSync(settingsPath, JSON.stringify(persistedSettings, null, 2), "utf8");
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
    cloudEnabled: appSettings.cloudEnabled,
    cloudEndpoint: appSettings.cloudEndpoint,
    cloudProjectId: appSettings.cloudProjectId,
    cloudConfigured: isCloudConfigured(),
    cloudSyncState: cloudSyncState,
    cloudLastSyncAt: appSettings.cloudLastSyncAt,
    cloudError: cloudSyncError,
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
    (item.updatedAt === undefined || typeof item.updatedAt === "number") &&
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
  const loadedHistory = readHistoryFromPath(storePath);
  history = mergeHistories([], loadedHistory);
  trimHistory();
  if (history.length !== loadedHistory.length) saveHistory();
}

function historyKey(item: Pick<ClipboardItem, "type" | "content">): string {
  return `${item.type}:${item.content}`;
}

function itemTimestamp(item: ClipboardItem): number {
  return item.updatedAt ?? item.createdAt;
}

function mergeHistories(primary: ClipboardItem[], secondary: ClipboardItem[]): ClipboardItem[] {
  const byContent = new Map<string, ClipboardItem>();
  for (const item of [...primary, ...secondary]) {
    const key = historyKey(item);
    const found = byContent.get(key);
    if (!found) {
      byContent.set(key, {
        ...item,
        updatedAt: item.updatedAt ?? item.createdAt,
      });
      continue;
    }

    const latest = itemTimestamp(item) > itemTimestamp(found) ? item : found;
    const pinned = found.pinned || item.pinned;
    const tags = [...new Set([
      ...(found.tags ?? []),
      ...(item.tags ?? []),
      ...(pinned ? ["常用"] : []),
    ])];
    byContent.set(key, {
      ...latest,
      pinned,
      tags,
      createdAt: Math.max(found.createdAt, item.createdAt),
      updatedAt: Math.max(itemTimestamp(found), itemTimestamp(item)),
    });
  }

  return [...byContent.values()]
    .sort((left, right) => itemTimestamp(right) - itemTimestamp(left));
}

function saveHistory(): boolean {
  if (!storePath) return false;
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
    return true;
  } catch (error) {
    try {
      if (!existsSync(storePath) && existsSync(backupPath)) renameSync(backupPath, storePath);
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch (recoveryError) {
      console.warn("ClipNest: history recovery failed", recoveryError);
    }
    console.warn("ClipNest: unable to persist clipboard history", error);
    return false;
  }
}

function updateCloudTombstones(
  items: ClipboardItem[],
  deletedAt: number,
): void {
  const nextTombstones = { ...appSettings.cloudTombstones };
  let changed = false;
  for (const item of items) {
    const key = historyKey(item);
    if ((nextTombstones[key] ?? 0) >= deletedAt) continue;
    nextTombstones[key] = deletedAt;
    changed = true;
  }
  if (!changed) return;
  appSettings = { ...appSettings, cloudTombstones: nextTombstones };
  saveAppSettings();
}

function clearCloudTombstones(items: ClipboardItem[]): void {
  const nextTombstones = { ...appSettings.cloudTombstones };
  let changed = false;
  for (const item of items) {
    const key = historyKey(item);
    if (!(key in nextTombstones) || itemTimestamp(item) <= nextTombstones[key]) continue;
    delete nextTombstones[key];
    changed = true;
  }
  if (!changed) return;
  appSettings = { ...appSettings, cloudTombstones: nextTombstones };
  saveAppSettings();
}

function mergeCloudSnapshot(remote: CloudSnapshot): CloudSnapshot {
  const tombstones = { ...appSettings.cloudTombstones, ...remote.tombstones };
  for (const [key, value] of Object.entries(remote.tombstones)) {
    tombstones[key] = Math.max(appSettings.cloudTombstones[key] ?? 0, value);
  }

  const mergedItems = mergeHistories(history, remote.items);
  const items = mergedItems.filter((item) => itemTimestamp(item) > (tombstones[historyKey(item)] ?? 0));
  for (const item of items) {
    const key = historyKey(item);
    if (itemTimestamp(item) > (tombstones[key] ?? 0)) delete tombstones[key];
  }

  return { version: 2, items, tombstones };
}

function sendHistory(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("history:updated", history);
}

function cloudSnapshotKey(): Buffer {
  if (!appSettings.cloudAccessToken) {
    throw new Error("云端项目令牌未配置");
  }
  return createHash("sha256")
    .update(`ClipNest cloud snapshot v1:${appSettings.cloudProjectId}:${appSettings.cloudAccessToken}`, "utf8")
    .digest();
}

function encryptCloudSnapshot(snapshot: CloudSnapshot): EncryptedCloudSnapshot {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cloudSnapshotKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptCloudSnapshot(value: unknown): CloudSnapshot {
  if (!value || typeof value !== "object") throw new Error("云端返回的数据格式无效");
  const snapshot = value as Partial<EncryptedCloudSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.iv !== "string" ||
    typeof snapshot.authTag !== "string" ||
    typeof snapshot.ciphertext !== "string"
  ) {
    throw new Error("云端返回的加密快照版本不兼容");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    cloudSnapshotKey(),
    Buffer.from(snapshot.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(snapshot.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(snapshot.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (Array.isArray(parsed)) {
    return { version: 2, items: parsed.filter(isClipboardItem), tombstones: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("云端历史格式无效");
  }
  const cloudSnapshot = parsed as Partial<CloudSnapshot>;
  if (cloudSnapshot.version !== 2 || !Array.isArray(cloudSnapshot.items)) {
    throw new Error("云端历史版本不兼容");
  }
  const tombstones = cloudSnapshot.tombstones && typeof cloudSnapshot.tombstones === "object"
    ? Object.fromEntries(
        Object.entries(cloudSnapshot.tombstones).filter(
          ([key, timestamp]) => typeof key === "string" && typeof timestamp === "number" && Number.isFinite(timestamp),
        ),
      )
    : {};
  return { version: 2, items: cloudSnapshot.items.filter(isClipboardItem), tombstones };
}

function decryptCloudSnapshotLegacy(value: unknown): ClipboardItem[] {
  if (!value || typeof value !== "object") throw new Error("云端返回的数据格式无效");
  const snapshot = value as Partial<EncryptedCloudSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.iv !== "string" ||
    typeof snapshot.authTag !== "string" ||
    typeof snapshot.ciphertext !== "string"
  ) {
    throw new Error("云端返回的数据版本不兼容");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    cloudSnapshotKey(),
    Buffer.from(snapshot.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(snapshot.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(snapshot.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (!Array.isArray(parsed)) throw new Error("云端历史不是有效列表");
  return parsed.filter(isClipboardItem);
}

function cloudRequestUrl(path: string): string {
  const endpoint = normalizeCloudEndpoint(appSettings.cloudEndpoint);
  if (!endpoint) throw new Error("云端地址无效，请使用 http:// 或 https:// 地址");
  if (!CLOUD_PROJECT_ID_PATTERN.test(appSettings.cloudProjectId)) {
    throw new Error("云端项目标识无效，只能使用字母、数字、下划线和短横线");
  }
  return `${endpoint}${path}`;
}

async function requestCloud(path: string, init: RequestInit = {}): Promise<Response> {
  if (!appSettings.cloudAccessToken) throw new Error("尚未配置云端项目令牌");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(cloudRequestUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${appSettings.cloudAccessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function syncCloudHistory(): Promise<ClipnestSettings> {
  if (cloudSyncPromise) {
    cloudSyncQueued = true;
    return cloudSyncPromise;
  }

  cloudSyncPromise = (async () => {
    if (!appSettings.cloudEnabled) {
      setCloudSyncState("disabled");
      return getAppSettingsSnapshot();
    }
    if (!isCloudConfigured()) {
      setCloudSyncState("error", "请先配置云端项目令牌");
      return getAppSettingsSnapshot();
    }

    setCloudSyncState("syncing");
    try {
      const basePath = `/v1/projects/${encodeURIComponent(appSettings.cloudProjectId)}/snapshot`;
      const remoteResponse = await requestCloud(basePath);
      let remoteSnapshot: CloudSnapshot = { version: 2, items: [], tombstones: {} };
      if (remoteResponse.status === 200) {
        const remotePayload = await remoteResponse.json() as { found?: boolean; payload?: unknown };
        if (remotePayload.found !== false && remotePayload.payload) {
          remoteSnapshot = decryptCloudSnapshot(remotePayload.payload);
        }
      } else if (remoteResponse.status !== 404) {
        throw new Error(`云端读取失败（HTTP ${remoteResponse.status}）`);
      }

      const mergedSnapshot = mergeCloudSnapshot(remoteSnapshot);
      history = mergedSnapshot.items;
      appSettings = { ...appSettings, cloudTombstones: mergedSnapshot.tombstones };
      trimHistory();
      saveHistory();
      saveAppSettings();
      sendHistory();

      const uploadResponse = await requestCloud(basePath, {
        method: "PUT",
        body: JSON.stringify({
          version: 1,
          updatedAt: Date.now(),
          payload: encryptCloudSnapshot({
            version: 2,
            items: history,
            tombstones: appSettings.cloudTombstones,
          }),
        }),
      });
      if (!uploadResponse.ok) {
        throw new Error(`云端写入失败（HTTP ${uploadResponse.status}）`);
      }

      appSettings = { ...appSettings, cloudLastSyncAt: Date.now() };
      saveAppSettings();
      setCloudSyncState("synced");
    } catch (error) {
      const message = error instanceof Error ? error.message : "云端同步失败";
      setCloudSyncState("error", message);
    }
    return getAppSettingsSnapshot();
  })().finally(() => {
    cloudSyncPromise = null;
    if (cloudSyncQueued) {
      cloudSyncQueued = false;
      scheduleCloudSync();
    }
  });

  return cloudSyncPromise;
}

function scheduleCloudSync(): void {
  if (!appSettings.cloudEnabled || !isCloudConfigured()) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    void syncCloudHistory();
  }, 900);
}

function trimHistory(): void {
  const previousHistory = [...history];
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

  const retainedKeys = new Set(history.map((item) => historyKey(item)));
  const removedItems = previousHistory.filter((item) => !retainedKeys.has(historyKey(item)));
  if (removedItems.length) updateCloudTombstones(removedItems, Date.now());
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
  scheduleCloudSync();
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
  scheduleCloudSync();
}

function updateAppSettings(patch: unknown): ClipnestSettings {
  if (!patch || typeof patch !== "object") return getAppSettingsSnapshot();
  const nextPatch = patch as ClipnestSettingsPatch;
  let cloudSettingsChanged = false;

  if (typeof nextPatch.startupEnabled === "boolean") {
    setStartupEnabled(nextPatch.startupEnabled);
  }
  if (typeof nextPatch.maxHistoryItems === "number") {
    setMaxHistoryItems(nextPatch.maxHistoryItems);
  }

  if (typeof nextPatch.cloudEndpoint === "string") {
    const endpoint = normalizeCloudEndpoint(nextPatch.cloudEndpoint);
    if (endpoint) {
      appSettings = { ...appSettings, cloudEndpoint: endpoint };
      cloudSettingsChanged = true;
    } else {
      setCloudSyncState("error", "云端地址无效，请使用 http:// 或 https:// 地址");
    }
  }
  if (typeof nextPatch.cloudProjectId === "string") {
    const projectId = nextPatch.cloudProjectId.trim();
    if (CLOUD_PROJECT_ID_PATTERN.test(projectId)) {
      appSettings = {
        ...appSettings,
        cloudProjectId: projectId,
        cloudTombstones: projectId === appSettings.cloudProjectId ? appSettings.cloudTombstones : {},
      };
      cloudSettingsChanged = true;
    } else {
      setCloudSyncState("error", "项目标识只能使用字母、数字、下划线和短横线");
    }
  }
  if (typeof nextPatch.cloudAccessToken === "string" && nextPatch.cloudAccessToken.trim()) {
    appSettings = { ...appSettings, cloudAccessToken: nextPatch.cloudAccessToken.trim() };
    cloudSettingsChanged = true;
  }
  if (typeof nextPatch.cloudEnabled === "boolean") {
    appSettings = { ...appSettings, cloudEnabled: nextPatch.cloudEnabled };
    cloudSettingsChanged = true;
    if (!nextPatch.cloudEnabled) setCloudSyncState("disabled");
  }

  if (cloudSettingsChanged) {
    saveAppSettings();
    if (appSettings.cloudEnabled) {
      if (isCloudConfigured()) {
        setCloudSyncState("idle");
      } else {
        setCloudSyncState("error", "请先配置云端项目令牌");
      }
    }
    sendSettings();
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

function addHistoryItem(item: ClipboardItem): boolean {
  const duplicate = history.find(
    (existing) => existing.type === item.type && existing.content === item.content,
  );

  if (duplicate) {
    history = [
      { ...duplicate, createdAt: item.createdAt, updatedAt: item.updatedAt ?? item.createdAt },
      ...history.filter((existing) => existing.id !== duplicate.id),
    ];
  } else {
    history = [{ ...item, updatedAt: item.updatedAt ?? item.createdAt }, ...history];
  }

  clearCloudTombstones([item]);
  trimHistory();
  const persisted = saveHistory();
  sendHistory();
  scheduleCloudSync();
  return persisted;
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
      updatedAt: Date.now(),
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
        updatedAt: Date.now(),
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
    if (addHistoryItem(payload.item)) lastClipboardSignature = payload.signature;
  } catch (error) {
    console.warn("ClipNest: clipboard polling failed", error);
  }
}

function panelBoundsForCurrentDisplay(): Electron.Rectangle {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const height = Math.min(PANEL_HEIGHT, area.height);
  return {
    x: area.x,
    y: area.y + area.height - height,
    width: area.width,
    height,
  };
}

function positionPanel(): Electron.Rectangle | null {
  if (!mainWindow) return null;
  const bounds = panelBoundsForCurrentDisplay();
  mainWindow.setBounds(bounds, false);
  return bounds;
}

function hidePanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (panelAnimationTimer) {
    clearInterval(panelAnimationTimer);
    panelAnimationTimer = null;
  }
  mainWindow.hide();
}

function showPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (blurTimer) clearTimeout(blurTimer);
  const targetBounds = panelBoundsForCurrentDisplay();
  const shouldAnimate = !mainWindow.isVisible();
  if (panelAnimationTimer) clearInterval(panelAnimationTimer);

  if (shouldAnimate) {
    const startY = targetBounds.y + Math.min(28, targetBounds.height);
    mainWindow.setBounds({ ...targetBounds, y: startY }, false);
  } else {
    mainWindow.setBounds(targetBounds, false);
  }
  mainWindow.showInactive();
  mainWindow.focus();

  if (shouldAnimate) {
    const startedAt = Date.now();
    panelAnimationTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const progress = Math.min(1, (Date.now() - startedAt) / 150);
      const eased = 1 - Math.pow(1 - progress, 3);
      mainWindow.setBounds({
        ...targetBounds,
        y: Math.round(targetBounds.y + (targetBounds.height > 0 ? 28 * (1 - eased) : 0)),
      }, false);
      if (progress >= 1) {
        clearInterval(panelAnimationTimer!);
        panelAnimationTimer = null;
        mainWindow.setBounds(targetBounds, false);
      }
    }, 16);
  }
  mainWindow.webContents.send("panel:shown");
}

function showSettings(): void {
  showPanel();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("navigation:settings");
}

function createMainWindow(): void {
  const preloadPath = join(__dirname, "../preload/preload.js");
  const windowIcon = createAppIcon();
  const initialDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  mainWindow = new BrowserWindow({
    width: initialDisplay.workArea.width,
    height: PANEL_HEIGHT,
    icon: windowIcon,
    minWidth: 960,
    show: false,
    frame: false,
    resizable: false,
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
    mainWindow?.webContents.send("updates:state", updateInfo);
  });
  mainWindow.once("ready-to-show", () => {
    if (process.argv.includes("--show")) setTimeout(showPanel, 80);
  });
}

function clearUnpinnedHistory(): void {
  const removedItems = history.filter((item) => !item.pinned);
  history = history.filter((item) => item.pinned);
  updateCloudTombstones(removedItems, Date.now());
  saveHistory();
  sendHistory();
  scheduleCloudSync();
}

function normalizeVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
    .concat([0, 0, 0])
    .slice(0, 3);
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function registerAutoUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-available", (info) => {
    setUpdateInfo({
      latestVersion: info.version,
      state: "available",
      error: null,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    setUpdateInfo({
      latestVersion: info.version,
      state: "up-to-date",
      downloadProgress: 0,
      error: null,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdateInfo({
      state: "downloading",
      downloadProgress: Math.max(0, Math.min(100, Math.round(progress.percent))),
      error: null,
    });
  });
  autoUpdater.on("update-downloaded", () => {
    setUpdateInfo({ state: "downloaded", downloadProgress: 100, error: null });
  });
  autoUpdater.on("error", (error) => {
    setUpdateInfo({ state: "error", error: error.message || "更新失败" });
  });
}

async function checkForUpdates(): Promise<UpdateInfo> {
  if (updateInfo.state === "checking") return updateInfo;
  setUpdateInfo({
    currentVersion: app.getVersion(),
    state: "checking",
    error: null,
    downloadProgress: 0,
  });

  try {
    const response = await fetchWithTimeout(GITHUB_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ClipNest-Updater",
      },
    }, UPDATE_REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new Error(`版本检查失败（HTTP ${response.status}）`);
    const release = await response.json() as GitHubReleasePayload;
    const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
    const latestVersion = tagName.replace(/^v/i, "");
    if (!latestVersion) throw new Error("GitHub Release 未返回有效版本号");

    const available = compareVersions(latestVersion, app.getVersion()) > 0;
    setUpdateInfo({
      currentVersion: app.getVersion(),
      latestVersion,
      releaseName: typeof release.name === "string" ? release.name : `ClipNest v${latestVersion}`,
      releaseNotes: typeof release.body === "string" ? release.body : "暂无更新说明",
      releaseUrl: typeof release.html_url === "string" ? release.html_url : GITHUB_RELEASE_PAGE,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      state: available ? "available" : "up-to-date",
      error: null,
    });

    if (available && app.isPackaged) {
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        const message = error instanceof Error ? error.message : "更新包检查失败";
        setUpdateInfo({ state: "available", error: message });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "版本检查失败";
    setUpdateInfo({ state: "error", error: message });
  }
  return updateInfo;
}

async function downloadUpdate(): Promise<UpdateInfo> {
  if (!app.isPackaged) {
    setUpdateInfo({ state: "error", error: "开发模式不能执行一键升级，请使用 Windows 打包版本" });
    return updateInfo;
  }
  if (updateInfo.state === "downloaded") return updateInfo;
  setUpdateInfo({ state: "downloading", downloadProgress: 0, error: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新下载失败";
    setUpdateInfo({ state: "error", error: message });
  }
  return updateInfo;
}

function installUpdate(): void {
  if (!app.isPackaged || updateInfo.state !== "downloaded") return;
  autoUpdater.quitAndInstall(false, true);
}

function createTray(): void {
  const icon = createAppIcon(18);
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
  ipcMain.handle("cloud:sync", () => syncCloudHistory());
  ipcMain.handle("updates:get", () => updateInfo);
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:download", () => downloadUpdate());
  ipcMain.handle("updates:install", () => installUpdate());
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
    updateCloudTombstones([item], Date.now());
    saveHistory();
    sendHistory();
    scheduleCloudSync();
  });
  ipcMain.handle("history:pin", (_event, id: string) => {
    history = history.map((item) =>
      item.id === id
        ? {
            ...item,
            updatedAt: Date.now(),
            pinned: !item.pinned,
            tags: !item.pinned ? ["常用"] : [],
          }
        : item,
    );
    saveHistory();
    sendHistory();
    scheduleCloudSync();
  });
  ipcMain.handle("history:clear", clearUnpinnedHistory);
  ipcMain.handle("panel:hide", hidePanel);
}

applyDataDirectoryOverride();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (!commandLine.includes(STARTUP_ARGUMENT)) showPanel();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId("com.clipnest.app");
    registerAutoUpdater();
    // Keep the data location stable even when the app is launched from a
    // portable folder or the executable is rebuilt with a different name.
    configureStartup();
    loadHistory();
    createMainWindow();
    createTray();
    registerIpc();
    cloudSyncState = appSettings.cloudEnabled
      ? (isCloudConfigured() ? "idle" : "error")
      : "disabled";
    cloudSyncError = appSettings.cloudEnabled && !isCloudConfigured()
      ? "请先配置云端项目令牌"
      : null;
    if (appSettings.cloudEnabled && isCloudConfigured()) void syncCloudHistory();

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
