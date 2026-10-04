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
  systemPreferences,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { IMAGE_LIMITS, ImagePreparationService, inspectImageSource } from "./clipboard/image-preparation";
import { raceSelectionPreparation, selectionHelperDeadlineAtCommit, startSelectionKeyReleaseMonitor, SELECTION_KEY_RELEASE_WINDOW_MS, type SelectionKeyReleaseMonitor } from "./clipboard/selection-key-deadline";
import { encodeClipboardImage } from "./clipboard/image-payload";
import { setPanelInitialPresentation, shouldAnimatePanel } from "./clipboard/panel-presentation";
import { ClipboardSequenceGate } from "./clipboard/sequence-gate";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ClipboardItem,
  ClipboardType,
  ClipnestSettings,
  ClipnestSettingsPatch,
  CopyItemResult,
  CloudSyncState,
  UpdateInfo,
} from "../shared/types";
import type { NativeResult, NativeTarget, NativeTriggerKey } from "../shared/native-contracts";
import type { OpenDialogOptions } from "electron";
import { MetricsRecorder } from "./metrics/recorder";
import { captureClipboardBaseline, HostAuthorizationGate } from "./native/host-authorization";
import { ClipboardWriteFence, NativeHelperClient } from "./native/helper-client";
import { NativeContentProvider, type NativeContentSnapshot, type NativeImageBitmap } from "./native/content-provider";
import { createWin32HostBridge, type Win32HostBridge } from "./native/win32-host-bridge";
import { createNativeHelperEnvironment } from "./native/profile-identity";

const benchmarkMode = process.env.CLIPNEST_BENCHMARK_MODE === "1";

function benchmarkProfileDirectory(): string {
  const benchmarkRoot = resolve(__dirname, "../../tests/tasks/T01/runtime-profile");
  const override = process.env.CLIPNEST_DATA_DIR?.trim();
  if (!override) throw new Error("Benchmark mode requires an isolated profile directory");
  const profile = resolve(override);
  const relativeProfile = relative(benchmarkRoot, profile);
  if (
    !/^run-[0-9]+-[a-f0-9-]+$/i.test(relativeProfile) ||
    relativeProfile === ".." ||
    relativeProfile.startsWith(`..${sep}`) ||
    isAbsolute(relativeProfile)
  ) {
    throw new Error("Benchmark profile must be a unique child of the T01 runtime profile root");
  }
  return profile;
}

function benchmarkSampleCount(): number {
  const value = Number(process.env.CLIPNEST_BENCHMARK_SAMPLES ?? "1");
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("CLIPNEST_BENCHMARK_SAMPLES must be an integer from 1 to 100");
  }
  return value;
}

const benchmarkSamples = benchmarkMode ? benchmarkSampleCount() : 0;
const suppressBenchmarkAcknowledgement = benchmarkMode && process.argv.includes("--simulate-no-ack");
if (benchmarkMode) {
  const profile = process.env.CLIPNEST_DATA_DIR?.trim();
  if (!profile || resolve(profile) !== benchmarkProfileDirectory()) {
    throw new Error("Benchmark mode requires the isolated T01 profile path");
  }
  if (!process.argv.includes("--no-input")) {
    throw new Error("Benchmark mode requires --no-input");
  }
  app.setName("ClipNest-T01-Benchmark");
}

const metrics = new MetricsRecorder({
  enabled: benchmarkMode,
  outputPath: benchmarkMode ? join(benchmarkProfileDirectory(), "metrics.jsonl") : undefined,
});
let completedBenchmarkSamples = 0;
let failedBenchmarkSamples = 0;
const benchmarkAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
const BENCHMARK_ACTIONABLE_TIMEOUT_MS = 5_000;

const DEFAULT_MAX_HISTORY_ITEMS = 100;
const MIN_MAX_HISTORY_ITEMS = 20;
const MAX_MAX_HISTORY_ITEMS = 2_000;
const MAX_HISTORY_BYTES = 25_000_000;
const MAX_EDITABLE_TEXT_BYTES = 2_000_000;
const POLL_INTERVAL_MS = 450;
const PANEL_HEIGHT = 315;
const HISTORY_FILE_NAME = "history.json";
const STARTUP_ARGUMENT = "--hidden";
const APP_DISPLAY_NAME = "ClipNest";
// Keep the public source free of deployment-specific addresses. The endpoint
// is overridable in Settings and cloud sync remains disabled by default.
const DEFAULT_CLOUD_ENDPOINT = "https://cloud.example.com";
const DEFAULT_CLOUD_PROJECT_ID = "clipnest-windows";
const CLOUD_REQUEST_TIMEOUT_MS = 12_000;
const WEB_SNAPSHOT_KDF_ITERATIONS = 120_000;
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
  cloudWebPassword: string;
  cloudEncryptionKey: string;
  cloudLastSyncAt: number | null;
  cloudTombstones: Record<string, number>;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let history: ClipboardItem[] = [];
let lastClipboardSignature = "";
const clipboardSequenceGate = new ClipboardSequenceGate();
const imagePreparationService = new ImagePreparationService();
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
  cloudWebPassword: "",
  cloudEncryptionKey: "",
  cloudLastSyncAt: null,
  cloudTombstones: {},
};
let startupEnabled = false;
let pollTimer: NodeJS.Timeout | null = null;
let blurTimer: NodeJS.Timeout | null = null;
let panelAnimationTimer: NodeJS.Timeout | null = null;
let panelGeneration: string | null = null;
let panelTarget: NativeTarget | null = null;
let pendingPanelGeneration: string | null = null;
let openingGuardUntil = 0;
let nativePasteJob: {
  jobId: string;
  generation: string;
  objectToken: string;
  itemRef: string;
  contentPreparationDeadlineAt: number;
  helperClient: NativeHelperClient | null;
  imageDecodeController: AbortController;
  keyReleaseMonitor: SelectionKeyReleaseMonitor | null;
  snapshot: NativeContentSnapshot | null;
  registrationAttempted: boolean;
  registered: boolean;
  clipboardCommitAttempted: boolean;
  pasteRequested: boolean;
  clipboardSequence: string | null;
  triggerKeys: NativeTriggerKey[];
  cancelled: boolean;
  preparationPromise: Promise<NativeResult> | null;
  cancellationQuiescent: boolean;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  cancelPromise: Promise<boolean> | null;
} | null = null;
let openingGuardTimer: NodeJS.Timeout | null = null;
let helperClient: NativeHelperClient | null = null;
let helperReady: Extract<NativeResult, { status: "ready" }> | null = null;
let helperRestartAttempted = false;
let helperRestartPromise: Promise<boolean> | null = null;
const helperClipboardFence = new ClipboardWriteFence();
let win32HostBridge: Win32HostBridge | null = null;
let nativeContentProvider: NativeContentProvider | null = null;
const hostAuthorizationGate = new HostAuthorizationGate();
let panelOpeningPromise: Promise<void> | null = null;
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
  if (benchmarkMode && !override) {
    throw new Error("Benchmark mode refuses to use the default profile");
  }
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

interface EncryptedWebSnapshot {
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
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
    const isLocalHttp = url.protocol === "http:" && (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
    if (url.protocol !== "https:" && !isLocalHttp) return null;
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
    cloudWebPassword: "",
    cloudEncryptionKey: "",
    cloudLastSyncAt: null,
    cloudTombstones: {},
  };

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<AppSettings> & {
        cloudAccessTokenEncrypted?: string;
        cloudWebPasswordEncrypted?: string;
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
      if (typeof parsed.cloudWebPasswordEncrypted === "string" && safeStorage.isEncryptionAvailable()) {
        try {
          appSettings.cloudWebPassword = safeStorage
            .decryptString(Buffer.from(parsed.cloudWebPasswordEncrypted, "base64"));
        } catch (error) {
          console.warn("ClipNest: unable to decrypt cloud web password", error);
        }
      } else if (typeof parsed.cloudWebPassword === "string") {
        appSettings.cloudWebPassword = parsed.cloudWebPassword;
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
    const { cloudAccessToken, cloudWebPassword, ...settingsWithoutSecrets } = appSettings;
    const persistedSettings: Record<string, unknown> = { ...settingsWithoutSecrets };
    if (cloudAccessToken) {
      if (safeStorage.isEncryptionAvailable()) {
        persistedSettings.cloudAccessTokenEncrypted = safeStorage
          .encryptString(cloudAccessToken)
          .toString("base64");
      } else {
        console.warn("ClipNest: cloud project token was not persisted because safeStorage is unavailable");
      }
    }
    if (cloudWebPassword) {
      if (safeStorage.isEncryptionAvailable()) {
        persistedSettings.cloudWebPasswordEncrypted = safeStorage
          .encryptString(cloudWebPassword)
          .toString("base64");
      } else {
        console.warn("ClipNest: cloud web password was not persisted because safeStorage is unavailable");
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
    cloudWebConfigured: Boolean(appSettings.cloudWebPassword),
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

function encryptWebSnapshot(items: ClipboardItem[]): EncryptedWebSnapshot {
  if (!appSettings.cloudWebPassword) {
    throw new Error("尚未配置网页登录密码");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(
    appSettings.cloudWebPassword,
    salt,
    WEB_SNAPSHOT_KDF_ITERATIONS,
    32,
    "sha256",
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ version: 1, updatedAt: Date.now(), items }), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "pbkdf2-sha256",
    iterations: WEB_SNAPSHOT_KDF_ITERATIONS,
    salt: salt.toString("base64url"),
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

async function uploadWebSnapshot(): Promise<void> {
  if (!appSettings.cloudWebPassword) return;
  const basePath = `/v1/projects/${encodeURIComponent(appSettings.cloudProjectId)}/web-snapshot`;
  const response = await requestCloud(basePath, {
    method: "PUT",
    body: JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      payload: encryptWebSnapshot(history),
    }),
  });
  if (!response.ok) {
    throw new Error(`网页快照写入失败（HTTP ${response.status}）`);
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

      await uploadWebSnapshot();

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
  if (typeof nextPatch.cloudWebPassword === "string" && nextPatch.cloudWebPassword.trim()) {
    appSettings = { ...appSettings, cloudWebPassword: nextPatch.cloudWebPassword };
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

function editPinnedHistoryItem(id: string, nextContent: string): void {
  const item = history.find((candidate) => candidate.id === id);
  if (!item || !item.pinned || item.type === "image") {
    throw new Error("只有常用文本或链接支持修改");
  }
  if (!nextContent || !nextContent.trim()) {
    throw new Error("常用内容不能为空");
  }
  if (Buffer.byteLength(nextContent, "utf8") > MAX_EDITABLE_TEXT_BYTES) {
    throw new Error("常用内容不能超过 2 MB");
  }

  const updatedAt = Date.now();
  const nextType: ClipboardType = isLink(nextContent) ? "link" : "text";
  const nextItem: ClipboardItem = {
    ...item,
    type: nextType,
    content: nextContent,
    preview: previewText(nextContent),
    updatedAt,
    byteSize: Buffer.byteLength(nextContent, "utf8"),
    tags: [...new Set([...(item.tags ?? []), "常用"])],
  };
  const duplicate = history.find(
    (candidate) => candidate.id !== id && candidate.type === nextType && candidate.content === nextContent,
  );

  updateCloudTombstones([item], updatedAt);
  history = duplicate
    ? [
        {
          ...duplicate,
          ...nextItem,
          id,
          createdAt: Math.min(item.createdAt, duplicate.createdAt),
          pinned: true,
        },
        ...history.filter((candidate) => candidate.id !== id && candidate.id !== duplicate.id),
      ]
    : [nextItem, ...history.filter((candidate) => candidate.id !== id)];
  clearCloudTombstones([nextItem]);
  saveHistory();
  sendHistory();
  scheduleCloudSync();
}

function readClipboardImage(): { item: ClipboardItem; signature: string } | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const size = image.getSize();
  const encoded = encodeClipboardImage(image);
  if (!encoded) return null;
  const base64 = encoded.bytes.toString("base64");

  return {
    signature: fingerprint("image", base64),
    item: {
      id: randomUUID(),
      type: "image",
      content: `data:${encoded.mimeType};base64,${base64}`,
      preview: `图片 ${size.width} × ${size.height}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      tags: [],
      byteSize: encoded.bytes.byteLength,
      width: encoded.width,
      height: encoded.height,
    },
  };
}

function readClipboardItem(): { item: ClipboardItem; signature: string } | null {
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
}

function currentClipboardSequence(): number | null {
  const sequence = win32HostBridge?.getClipboardSequenceNumber();
  return typeof sequence === "number" && Number.isInteger(sequence) &&
    sequence > 0 && sequence <= 0xffff_ffff ? sequence : null;
}

function markCurrentClipboardSequenceProcessed(): boolean {
  const sequence = currentClipboardSequence();
  return sequence !== null && clipboardSequenceGate.markProcessed(sequence);
}

function pollClipboard(): void {
  void clipboardSequenceGate.capture(currentClipboardSequence, readClipboardItem).then((capture) => {
    if (capture.status === "skipped" || capture.status === "in_progress" ||
        capture.status === "captured_unstable") return;
    const payload = capture.value;
    if (!payload || payload.signature === lastClipboardSignature) return;

    try {
      if (addHistoryItem(payload.item)) {
        lastClipboardSignature = payload.signature;
      } else if (capture.status === "captured") {
        clipboardSequenceGate.forgetProcessed(capture.sequence);
      }
    } catch (error) {
      if (capture.status === "captured") clipboardSequenceGate.forgetProcessed(capture.sequence);
      throw error;
    }
  }).catch((error: unknown) => {
    console.warn("ClipNest: clipboard polling failed", error);
  });
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

function hidePanel(cancelPaste = true): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (panelAnimationTimer) {
    clearInterval(panelAnimationTimer);
    panelAnimationTimer = null;
  }
  if (cancelPaste && panelGeneration) {
    const oldGeneration = panelGeneration;
    panelGeneration = null;
    panelTarget = null;
    pendingPanelGeneration = null;
    if (openingGuardTimer) clearTimeout(openingGuardTimer);
    openingGuardTimer = null;
    openingGuardUntil = 0;
    if (nativePasteJob?.generation === oldGeneration) void cancelNativePasteJob(nativePasteJob);
  }
  mainWindow.hide();
}

function getMainWindowHandle(): string | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const nativeHandle = mainWindow.getNativeWindowHandle();
  if (!nativeHandle.length) return null;
  return (nativeHandle.length >= 8
    ? nativeHandle.readBigUInt64LE(0)
    : BigInt(nativeHandle.readUInt32LE(0))).toString();
}

function getMainWindowTarget(): NativeTarget | null {
  const hwnd = getMainWindowHandle();
  if (!hwnd || !win32HostBridge) return null;
  const target = win32HostBridge.getWindowTarget(hwnd);
  return target?.pid === process.pid ? target : null;
}

function nativeHelperPath(): string | null {
  const packagedPath = join(process.resourcesPath, "native", "clipnest-helper.exe");
  const candidates = app.isPackaged
    ? [packagedPath]
    : [
        join(app.getAppPath(), "native", "target-electron-l0", "x86_64-pc-windows-gnu", "release", "clipnest-helper.exe"),
        resolve(app.getAppPath(), "..", ".tools", "rust", "target-electron-l0", "x86_64-pc-windows-gnu", "release", "clipnest-helper.exe"),
      ];
  return candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate)) ?? null;
}

function handleCurrentNativeResult(result: NativeResult): void {
  if (result.status !== "job_finished") return;
  const job = nativePasteJob;
  if (!job || job.jobId !== result.jobId || job.generation !== result.generation) return;
  if (job.snapshot) nativeContentProvider?.release(job.snapshot, job.jobId, job.objectToken);
  nativePasteJob = null;
  job.resolveTerminal();
}

async function restartNativeHelperAfterFailure(client: NativeHelperClient): Promise<boolean> {
  if (helperClient !== client) return client.hasExited;
  if (helperRestartPromise) return helperRestartPromise;
  const shouldRestart = !helperRestartAttempted;
  if (shouldRestart) {
    helperRestartAttempted = true;
    helperReady = null;
  }
  const restarting = (async () => {
    const exited = await client.terminateAndWait(300);
    if (exited) helperClipboardFence.confirmHelperExit();
    if (helperClient === client && exited) helperClient = null;
    if (!exited || isQuitting) {
      console.warn("ClipNest: native helper restart skipped", exited ? "app_quitting" : "helper_exit_unconfirmed");
      return exited;
    }
    if (shouldRestart) startNativeHelper();
    return true;
  })();
  helperRestartPromise = restarting;
  try {
    return await restarting;
  } finally {
    if (helperRestartPromise === restarting) helperRestartPromise = null;
  }
}

async function decodeNativeClipboardImage(dataUrl: string, encodedBytes: Buffer): Promise<NativeImageBitmap> {
  const source = inspectImageSource(dataUrl, encodedBytes);
  const identity = createHash("sha256").update(encodedBytes).digest("hex");
  const job = nativePasteJob;
  if (!job) throw new Error("image_selection_job_missing");
  const { image } = await imagePreparationService.prepare({
    itemRef: identity,
    itemVersion: identity,
    format: source.format,
    encodedBytes,
    width: source.width,
    height: source.height,
  }, {
    signal: job.imageDecodeController.signal,
    isCurrent: () => isCurrentNativePasteJob(job),
    deadlineAt: job.contentPreparationDeadlineAt,
  });
  const bgra = Buffer.allocUnsafe(image.pixels.byteLength);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < image.pixels.length; sourceOffset += 4, targetOffset += 4) {
    const alpha = image.pixels[sourceOffset + 3];
    bgra[targetOffset] = Math.round(image.pixels[sourceOffset + 2] * alpha / 255);
    bgra[targetOffset + 1] = Math.round(image.pixels[sourceOffset + 1] * alpha / 255);
    bgra[targetOffset + 2] = Math.round(image.pixels[sourceOffset] * alpha / 255);
    bgra[targetOffset + 3] = alpha;
  }
  return { width: image.width, height: image.height, bgra };
}
function startNativeHelper(): void {
  if (process.platform !== "win32" || benchmarkMode || isQuitting) return;
  try {
    win32HostBridge ??= createWin32HostBridge();
    nativeContentProvider ??= new NativeContentProvider({
      lookupCurrentItem: (itemRef) => history.find((item) => item.id === itemRef),
      isTrustedSender: (senderId) => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId),
      // Image decoding stays off the Electron main event loop in the utility process.
      decodeImage: decodeNativeClipboardImage,
    });
    const executablePath = nativeHelperPath();
    if (!executablePath) throw new Error("native_helper_resource_missing");
    const helperEnvironment = createNativeHelperEnvironment(app.getPath("userData"));
    const bridge = win32HostBridge;
    let client: NativeHelperClient;
    client = new NativeHelperClient({
      acceptReady: (ready, childPid) => {
        const identity = bridge.getProcessIdentity(childPid);
        const accepted = identity?.pid === ready.helperPid &&
          ready.helperPid === childPid &&
          identity.processCreatedAt === ready.helperProcessCreatedAt;
        if (accepted) helperReady = ready;
        return accepted;
      },
      onCurrentResult: handleCurrentNativeResult,
      onUnavailable: () => {
        if (helperClient === client) {
          if (nativePasteJob?.clipboardCommitAttempted && !client.hasExited) helperClipboardFence.blockUntilHelperExit();
          helperReady = null;
          void restartNativeHelperAfterFailure(client);
        }
      },
      onProcessExit: () => {
        if (helperClient === client) helperClipboardFence.confirmHelperExit();
        const job = nativePasteJob;
        if (job?.cancelled && job.registrationAttempted && job.helperClient === client) {
          if (job.snapshot) nativeContentProvider?.release(job.snapshot, job.jobId, job.objectToken);
          job.cancellationQuiescent = true;
          nativePasteJob = null;
          job.resolveTerminal();
        }
      },
    });
    helperClient = client;
    void client.start(executablePath, helperEnvironment).catch((error: unknown) => {
      console.warn("ClipNest: native helper unavailable", error instanceof Error ? error.message : "startup_failed");
    });
  } catch (error) {
    helperReady = null;
    console.warn("ClipNest: native paste unavailable", error instanceof Error ? error.message : "bridge_start_failed");
  }
}

function writeItemToElectronClipboard(item: ClipboardItem): void {
  helperClipboardFence.assertWriteAllowed();
  if (item.type === "image") {
    const image = nativeImage.createFromDataURL(item.content);
    clipboard.writeImage(image);
    if (!markCurrentClipboardSequenceProcessed()) {
      lastClipboardSignature = fingerprint("image", image.toPNG().toString("base64"));
    }
    return;
  }
  clipboard.writeText(item.content);
  lastClipboardSignature = fingerprint(item.type, item.content);
  markCurrentClipboardSequenceProcessed();
}

function makeNativePasteJob(
  generation: string,
  itemRef: string,
  triggerKeys: NativeTriggerKey[],
  contentPreparationDeadlineAt: number,
  keyReleaseMonitor: SelectionKeyReleaseMonitor | null,
) {
  let resolveTerminal: () => void = () => {};
  const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  return {
    jobId: randomUUID(),
    generation,
    objectToken: randomUUID(),
    itemRef,
    contentPreparationDeadlineAt,
    helperClient: null,
    imageDecodeController: new AbortController(),
    keyReleaseMonitor,
    snapshot: null as NativeContentSnapshot | null,
    registrationAttempted: false,
    registered: false,
    clipboardCommitAttempted: false,
    pasteRequested: false,
    clipboardSequence: null as string | null,
    triggerKeys,
    cancelled: false,
    preparationPromise: null as Promise<NativeResult> | null,
    cancellationQuiescent: false,
    terminalPromise,
    resolveTerminal,
    cancelPromise: null as Promise<boolean> | null,
  };
}

function isCurrentNativePasteJob(job: NonNullable<typeof nativePasteJob>): boolean {
  return nativePasteJob === job && !job.cancelled && panelGeneration === job.generation;
}

async function cancelNativePasteJob(job: NonNullable<typeof nativePasteJob>): Promise<boolean> {
  if (job.cancelPromise) return job.cancelPromise;
  job.cancelPromise = (async () => {
    job.cancelled = true;
    job.keyReleaseMonitor?.cancel();
    job.imageDecodeController.abort();
    const startedAt = performance.now();
    const deadlineAt = startedAt + 50;
    if (!job.registrationAttempted) {
      if (!job.snapshot) {
        // Waiting for terminalPromise here deadlocks: the owner settles it only
        // after this cancellation race returns. Wait for the actual preparation
        // work, bounded by the local cleanup deadline, instead.
        const preparation = job.preparationPromise;
        if (preparation) {
          const preparationQuiescent = await Promise.race([
            preparation.then(() => true, () => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, deadlineAt - performance.now()))),
          ]);
          if (!preparationQuiescent) {
            job.cancellationQuiescent = false;
            return false;
          }
        }
      }
      if (job.snapshot) nativeContentProvider?.release(job.snapshot, job.jobId, job.objectToken);
      if (nativePasteJob === job) nativePasteJob = null;
      job.cancellationQuiescent = true;
      return true;
    }
    const client = job.helperClient;
    if (!client || client.hasExited) {
      if (job.snapshot) nativeContentProvider?.release(job.snapshot, job.jobId, job.objectToken);
      if (nativePasteJob === job) nativePasteJob = null;
      job.cancellationQuiescent = true;
      job.resolveTerminal();
      return true;
    }
    if (client.state !== "ready" || client.currentPanelGeneration !== job.generation) {
      job.cancellationQuiescent = false;
      helperClipboardFence.blockUntilHelperExit();
      return false;
    }
    try {
      const result = await client.request(
        nativeContentProvider!.cancelCommand(job.jobId),
        job.generation,
        { deadlineAt },
      );
      if (result.status !== "cancelled" && result.status !== "too_late") {
        job.cancellationQuiescent = false;
        helperClipboardFence.blockUntilHelperExit();
        return false;
      }
      const remaining = Math.max(0, deadlineAt - performance.now());
      const quiescent = await Promise.race([
        job.terminalPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining)),
      ]);
      job.cancellationQuiescent = quiescent;
      if (!quiescent) helperClipboardFence.blockUntilHelperExit();
      return quiescent;
    } catch {
      job.cancellationQuiescent = false;
      helperClipboardFence.blockUntilHelperExit();
      return false;
    }
  })();
  return job.cancelPromise;
}
async function sendNativeContent(
  job: NonNullable<typeof nativePasteJob>,
  provider: NativeContentProvider,
  client: NativeHelperClient,
): Promise<NativeResult> {
  const snapshot = job.snapshot;
  if (!snapshot) throw new Error("content_snapshot_missing");
  job.helperClient = client;
  job.registrationAttempted = true;
  const registered = await client.request(provider.registerCommand(snapshot, job.jobId, job.objectToken), job.generation);
  if (registered.status !== "content_registered") return registered;
  job.registered = true;
  provider.markRegistered(snapshot, job.jobId, job.objectToken);
  if (!isCurrentNativePasteJob(job)) throw new Error("paste_cancelled");

  const transfer = provider.createTransfer(snapshot, job.jobId, job.objectToken);
  let chunk = transfer.nextChunk();
  while (chunk) {
    if (!isCurrentNativePasteJob(job)) throw new Error("paste_cancelled");
    const chunkResult = await client.request(chunk, job.generation);
    if (chunkResult.status !== "chunk_accepted" || chunkResult.jobId !== job.jobId) return chunkResult;
    transfer.acknowledge(chunk.index, true);
    chunk = transfer.nextChunk();
  }
  const finish = transfer.finishCommand();
  if (finish) {
    const finished = await client.request(finish, job.generation);
    if (finished.status !== "content_registered" || finished.jobId !== job.jobId) return finished;
  }
  if (!isCurrentNativePasteJob(job)) throw new Error("paste_cancelled");
  return client.request(provider.prepareCommand(snapshot, job.jobId, job.objectToken), job.generation);
}

function completeBenchmarkSample(requestId: string, succeeded: boolean): void {
  const timer = benchmarkAckTimers.get(requestId);
  if (timer) clearTimeout(timer);
  benchmarkAckTimers.delete(requestId);
  completedBenchmarkSamples += 1;
  if (!succeeded) failedBenchmarkSamples += 1;

  if (completedBenchmarkSamples >= benchmarkSamples) {
    void metrics.flush().then(
      () => app.exit(failedBenchmarkSamples === 0 ? 0 : 1),
      () => app.exit(1),
    );
    return;
  }
  mainWindow?.hide();
  setImmediate(showPanel);
}

function renderPanel(requestId: string | null, generation: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (blurTimer) clearTimeout(blurTimer);
  const targetBounds = panelBoundsForCurrentDisplay();
  const opening = !mainWindow.isVisible();
  const shouldAnimate = shouldAnimatePanel(
    opening,
    benchmarkMode,
    () => systemPreferences.getAnimationSettings(),
  );
  if (panelAnimationTimer) {
    clearInterval(panelAnimationTimer);
    panelAnimationTimer = null;
  }

  // Keep the native window at its final bounds; motion uses opacity, not repeated SetWindowPos calls.
  setPanelInitialPresentation(mainWindow, targetBounds, shouldAnimate);
  if (benchmarkMode) mainWindow.showInactive();
  else mainWindow.show();

  if (opening && !benchmarkMode) {
    openingGuardUntil = performance.now() + 100;
    if (openingGuardTimer) clearTimeout(openingGuardTimer);
    openingGuardTimer = setTimeout(() => {
      openingGuardUntil = 0;
      openingGuardTimer = null;
    }, 100);
  }

  if (shouldAnimate) {
    const startedAt = performance.now();
    panelAnimationTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        if (panelAnimationTimer) clearInterval(panelAnimationTimer);
        panelAnimationTimer = null;
        return;
      }
      const progress = Math.min(1, (performance.now() - startedAt) / 150);
      const eased = 1 - Math.pow(1 - progress, 3);
      mainWindow.setOpacity(eased);
      if (progress >= 1) {
        if (panelAnimationTimer) clearInterval(panelAnimationTimer);
        panelAnimationTimer = null;
        mainWindow.setOpacity(1);
      }
    }, 16);
  }
  metrics.mark(requestId, "panel_shown");
  mainWindow.webContents.send("panel:shown", requestId, generation);
}
function showPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed() || panelOpeningPromise) return;
  const requestId = metrics.begin("wake");
  if (benchmarkMode && requestId) {
    const timer = setTimeout(() => {
      if (!metrics.isActive(requestId)) return;
      metrics.mark(requestId, "panel_actionable_timeout", "failed");
      metrics.finish(requestId, "failed");
      completeBenchmarkSample(requestId, false);
    }, BENCHMARK_ACTIONABLE_TIMEOUT_MS);
    benchmarkAckTimers.set(requestId, timer);
  }

  if (mainWindow.isVisible()) {
    const generation = panelGeneration ?? randomUUID();
    panelGeneration = generation;
    renderPanel(requestId, generation);
    return;
  }

  const generation = randomUUID();
  panelGeneration = generation;
  panelTarget = null;
  pendingPanelGeneration = generation;

  const opening = (async () => {
    const oldJob = nativePasteJob;
    if (oldJob) {
      const stopped = await cancelNativePasteJob(oldJob);
      if (!stopped) {
        if (oldJob.registrationAttempted) {
          const failedClient = oldJob.helperClient;
          if (oldJob.clipboardCommitAttempted && failedClient && !failedClient.hasExited) {
            helperClipboardFence.blockUntilHelperExit();
          }
          if (failedClient) void restartNativeHelperAfterFailure(failedClient);
        } else {
          if (oldJob.snapshot) nativeContentProvider?.release(oldJob.snapshot, oldJob.jobId, oldJob.objectToken);
          if (nativePasteJob === oldJob) nativePasteJob = null;
          oldJob.cancellationQuiescent = true;
          oldJob.resolveTerminal();
        }
      }
    } else if (helperClient?.activeJobCount) {
      if (!helperClient.hasExited) helperClipboardFence.blockUntilHelperExit();
      void restartNativeHelperAfterFailure(helperClient);
    }
    if (panelGeneration !== generation) return;

    const client = helperClient;
    if (client?.state === "ready") {
      try {
        client.beginPanelGeneration(generation);
        metrics.mark(requestId, "previous_window_capture_started");
        const result = await client.request({ kind: "capture" }, generation, { timeoutMs: 100 });
        panelTarget = result.status === "captured" && result.target.pid !== process.pid
          ? result.target
          : null;
        metrics.mark(requestId, "previous_window_captured");
      } catch {
        panelTarget = null;
        metrics.mark(requestId, "previous_window_captured", "failed");
      }
    }
    if (panelGeneration !== generation) return;
    pendingPanelGeneration = null;
    renderPanel(requestId, generation);
  })();
  panelOpeningPromise = opening.finally(() => {
    panelOpeningPromise = null;
  });
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
    alwaysOnTop: !benchmarkMode,
    backgroundColor: "#e4e1e8",
    hasShadow: false,
    title: "ClipNest",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (benchmarkMode) mainWindow.setOpacity(0);
  if (!benchmarkMode) mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.on("blur", () => {
    if (benchmarkMode) return;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!isQuitting && mainWindow && mainWindow.isVisible() && !mainWindow.isFocused()) {
        // The helper is handing foreground back to the captured input window. Hiding
        // after that transfer must not cancel the same request or discard its target.
        hidePanel(!nativePasteJob?.pasteRequested);
      }
    }, 120);
  });
  mainWindow.on("focus", () => {
    if (blurTimer) clearTimeout(blurTimer);
    if (openingGuardTimer) clearTimeout(openingGuardTimer);
    openingGuardTimer = null;
    openingGuardUntil = 0;
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
    if (benchmarkMode) {
      showPanel();
    } else if (process.argv.includes("--show")) {
      setTimeout(showPanel, 80);
    }
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

function parseNativeTriggerKeys(value: unknown): NativeTriggerKey[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  if (!value.every((key) => key === "Enter" || key === "V")) return null;
  const keys = value as NativeTriggerKey[];
  if (new Set(keys).size !== keys.length || (keys.includes("Enter") && keys.includes("V"))) return null;
  return [...keys];
}

function resultForNativeStatus(result: NativeResult): CopyItemResult {
  if (result.status === "input_submitted") return { status: "input_submitted" };
  if (result.status === "copied_only") return { status: "copied_only", reasonCode: result.reasonCode };
  if (result.status === "cancelled") return { status: "cancelled", reasonCode: result.reasonCode };
  const reasonCode = "reasonCode" in result ? result.reasonCode : undefined;
  return { status: "blocked", reasonCode: reasonCode ?? result.status };
}

function finishSelectionMetrics(requestId: string | null, outcome: "ok" | "not_found" | "no_input" | "failed"): void {
  metrics.mark(requestId, "copy_ipc_acknowledged");
  metrics.finish(requestId, outcome);
  if (!benchmarkMode) void metrics.flush().catch(() => undefined);
}

async function copySelectedItem(
  senderId: number,
  trustedFrame: boolean,
  itemRef: unknown,
  rawTriggerKeys: unknown,
  generation: unknown,
  requestId: string | null,
): Promise<CopyItemResult> {
  metrics.mark(requestId, "selection_received");
  if (!trustedFrame || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "untrusted_sender" };
  }
  if (typeof itemRef !== "string" || typeof generation !== "string") {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "selection_arguments_invalid" };
  }
  const triggerKeys = parseNativeTriggerKeys(rawTriggerKeys);
  if (!triggerKeys) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "trigger_keys_invalid" };
  }
  const item = history.find((candidate) => candidate.id === itemRef);
  if (!item) {
    finishSelectionMetrics(requestId, "not_found");
    return { status: "not_found" };
  }
  if (benchmarkMode && process.argv.includes("--no-input")) {
    finishSelectionMetrics(requestId, "no_input");
    return { status: "copied_only", reasonCode: "benchmark_no_input" };
  }
  if (
    generation !== panelGeneration ||
    pendingPanelGeneration === generation ||
    !mainWindow.isVisible()
  ) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "cancelled", reasonCode: "stale_panel_generation" };
  }
  if (performance.now() < openingGuardUntil) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "panel_opening_guard" };
  }
  if (helperClipboardFence.isBlocked) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "helper_side_effect_unresolved" };
  }
  if (nativePasteJob?.generation === generation && nativePasteJob.itemRef === itemRef &&
      nativePasteJob.triggerKeys.length === triggerKeys.length &&
      nativePasteJob.triggerKeys.every((key, index) => key === triggerKeys[index])) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "duplicate_selection_intent" };
  }

  const bridge = win32HostBridge;
  const selectionStartedTickMs = bridge?.getMonotonicTickMs() ?? null;
  const selectionDeadlineTickMs = selectionStartedTickMs === null
    ? null
    : selectionStartedTickMs + SELECTION_KEY_RELEASE_WINDOW_MS;
  const selectionStartedAt = performance.now();
  const selectionDeadlineAt = selectionStartedAt + SELECTION_KEY_RELEASE_WINDOW_MS;
  let selectionMonitorActive = true;
  const selectionKeyReleaseMonitor = bridge && selectionDeadlineTickMs !== null
    ? startSelectionKeyReleaseMonitor({
      selectionDeadlineAt,
      selectionDeadlineTickMs,
      nowAt: () => performance.now(),
      nowTickMs: () => bridge.getMonotonicTickMs(),
      keysReleased: () => bridge.areKeysReleased(triggerKeys),
      isCurrent: () => selectionMonitorActive && panelGeneration === generation,
    })
    : null;
  try {
    const baselineClipboardSequence = bridge ? captureClipboardBaseline(bridge) : null;

  if (nativePasteJob) {
    if (nativePasteJob.clipboardCommitAttempted || nativePasteJob.cancelled) {
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode: "active_job" };
    }
    const stopped = await cancelNativePasteJob(nativePasteJob);
    if (!stopped) {
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode: "cancel_not_quiescent" };
    }
  }
  if (helperClipboardFence.isBlocked) {
    finishSelectionMetrics(requestId, "failed");
    return { status: "blocked", reasonCode: "helper_side_effect_unresolved" };
  }

  const client = helperClient;
  const provider = nativeContentProvider;
  if (
    !client ||
    client.state !== "ready" ||
    client.currentPanelGeneration !== generation ||
    client.acceptedHelperGeneration !== generation ||
    !provider ||
    !bridge ||
    selectionDeadlineTickMs === null
  ) {
    if (item.type === "image") {
      finishSelectionMetrics(requestId, "failed");
      return {
        status: "blocked",
        reasonCode: bridge && selectionDeadlineTickMs === null ? "selection_clock_unavailable" : "native_helper_unavailable",
      };
    }
    try {
      writeItemToElectronClipboard(item);
      metrics.mark(requestId, "clipboard_written");
      hidePanel(false);
      metrics.mark(requestId, "panel_hidden");
      finishSelectionMetrics(requestId, "ok");
      return {
        status: "copied_only",
        reasonCode: bridge && selectionDeadlineTickMs === null ? "selection_clock_unavailable" : "native_helper_unavailable",
      };
    } catch {
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode: helperClipboardFence.isBlocked ? "helper_side_effect_unresolved" : "clipboard_write_failed" };
    }
  }

  if (baselineClipboardSequence === null) {
    if (item.type === "image") {
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode: "clipboard_sequence_unavailable" };
    }
    try {
      // This is still the user's direct copy action; automation is disabled when
      // Windows cannot provide a sequence baseline for a conditional native write.
      writeItemToElectronClipboard(item);
      metrics.mark(requestId, "clipboard_written");
      hidePanel(false);
      metrics.mark(requestId, "panel_hidden");
      finishSelectionMetrics(requestId, "ok");
      return { status: "copied_only", reasonCode: "clipboard_sequence_unavailable" };
    } catch {
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode: helperClipboardFence.isBlocked ? "helper_side_effect_unresolved" : "clipboard_write_failed" };
    }
  }

  const job = makeNativePasteJob(
    generation,
    itemRef,
    triggerKeys,
    selectionStartedAt + IMAGE_LIMITS.contentPrepareTimeoutMs,
    selectionKeyReleaseMonitor,
  );
  nativePasteJob = job;

  try {
    const preparation = (async () => {
      job.snapshot = await provider.snapshot(senderId, itemRef);
      if (!isCurrentNativePasteJob(job)) throw new Error("paste_cancelled");
      return sendNativeContent(job, provider, client);
    })();
    job.preparationPromise = preparation;
    const cancelSelectionJobWork = async (): Promise<void> => {
      job.imageDecodeController.abort();
      const quiescent = await cancelNativePasteJob(job);
      if (!quiescent && job.registrationAttempted) {
        helperClipboardFence.blockUntilHelperExit();
        const failedClient = job.helperClient;
        if (failedClient) {
          const helperRetired = await restartNativeHelperAfterFailure(failedClient);
          if (helperRetired) {
            if (job.snapshot) provider.release(job.snapshot, job.jobId, job.objectToken);
            job.cancellationQuiescent = true;
            if (nativePasteJob === job) nativePasteJob = null;
            job.resolveTerminal();
          }
        }
      }
    };
    const preparationRace = await raceSelectionPreparation({
      monitor: selectionKeyReleaseMonitor!,
      preparation,
      cancelPreparation: cancelSelectionJobWork,
    });
    if (preparationRace.kind === "blocked") {
      if (preparationRace.decision.reasonCode === "selection_cancelled") {
        finishSelectionMetrics(requestId, "failed");
        return { status: "cancelled", reasonCode: "selection_cancelled" };
      }
      finishSelectionMetrics(requestId, "no_input");
      return { status: "blocked", reasonCode: preparationRace.decision.reasonCode };
    }
    const prepared = preparationRace.result;
    if (prepared.status !== "prepared" || prepared.jobId !== job.jobId) {
      const response = resultForNativeStatus(prepared);
      finishSelectionMetrics(requestId, "failed");
      return response;
    }
    if (!job.snapshot || !provider.isCurrent(job.snapshot)) {
      await cancelSelectionJobWork();
      finishSelectionMetrics(requestId, "failed");
      return { status: "cancelled", reasonCode: "content_snapshot_stale" };
    }
    if (!isCurrentNativePasteJob(job)) {
      await cancelSelectionJobWork();
      finishSelectionMetrics(requestId, "failed");
      return { status: "cancelled", reasonCode: "selection_cancelled" };
    }
    const keyRelease = selectionKeyReleaseMonitor
      ? await selectionKeyReleaseMonitor.waitForPreparation()
      : { kind: "blocked", reasonCode: "selection_clock_unavailable" } as const;
    if (keyRelease.kind !== "continue") {
      await cancelSelectionJobWork();
      if (keyRelease.reasonCode === "selection_cancelled") {
        finishSelectionMetrics(requestId, "failed");
        return { status: "cancelled", reasonCode: "selection_cancelled" };
      }
      finishSelectionMetrics(requestId, "no_input");
      return { status: "blocked", reasonCode: keyRelease.reasonCode };
    }

    const keysReleasedBeforeCommit = bridge.areKeysReleased(triggerKeys);
    if (keysReleasedBeforeCommit !== true) {
      finishSelectionMetrics(requestId, "no_input");
      return {
        status: "blocked",
        reasonCode: keysReleasedBeforeCommit === false ? "key_held" : "key_state_unavailable",
      };
    }
    const helperSelectionDeadline = selectionHelperDeadlineAtCommit(
      bridge.getMonotonicTickMs(),
      selectionDeadlineTickMs,
    );
    if (helperSelectionDeadline.kind === "unavailable") {
      finishSelectionMetrics(requestId, "no_input");
      return { status: "blocked", reasonCode: "selection_clock_unavailable" };
    }

    // The helper rechecks trigger and modifier keys; its operation timeout remains bounded separately.
    job.clipboardCommitAttempted = true;
    const commitWriteCommand = {
      kind: "commit_write",
      jobId: job.jobId,
      prepareToken: prepared.prepareToken,
      baselineClipboardSequence,
      // Zero means the original 500ms cutoff elapsed: recheck keys immediately, never restart the wait.
      selectionBudgetMs: helperSelectionDeadline.kind === "expired"
        ? helperSelectionDeadline.selectionBudgetMs
        : keyRelease.operationBudgetMs,
      ...(helperSelectionDeadline.kind === "include"
        ? { selectionDeadlineTickMs: helperSelectionDeadline.deadlineTickMs }
        : {}),
      triggerKeys,
    } as const;
    const written = await client.request(commitWriteCommand, generation);
    if (written.status !== "clipboard_written" || written.jobId !== job.jobId) {
      const response = resultForNativeStatus(written);
      finishSelectionMetrics(requestId, "failed");
      return response;
    }
    job.clipboardSequence = written.clipboardSequence;
    clipboardSequenceGate.markProcessed(Number(written.clipboardSequence));
    metrics.mark(requestId, "clipboard_written");

    if (!isCurrentNativePasteJob(job)) {
      finishSelectionMetrics(requestId, "failed");
      return { status: "copied_only", reasonCode: "cancelled_after_clipboard_commit" };
    }
    if (!panelTarget) {
      await cancelNativePasteJob(job);
      finishSelectionMetrics(requestId, "failed");
      return { status: "copied_only", reasonCode: "target_unavailable" };
    }
    const hostWindow = getMainWindowTarget();
    const ready = helperReady;
    if (!hostWindow || !ready) {
      await cancelNativePasteJob(job);
      finishSelectionMetrics(requestId, "failed");
      return { status: "copied_only", reasonCode: "host_identity_unavailable" };
    }
    const authorization = hostAuthorizationGate.authorize(
      ready,
      { pid: ready.helperPid },
      hostWindow,
      bridge,
    );
    if (authorization !== "authorized") {
      await cancelNativePasteJob(job);
      finishSelectionMetrics(requestId, "failed");
      return { status: "copied_only", reasonCode: authorization };
    }
    if (!isCurrentNativePasteJob(job)) {
      await cancelNativePasteJob(job);
      finishSelectionMetrics(requestId, "failed");
      return { status: "copied_only", reasonCode: "selection_cancelled" };
    }
    const keysReleased = bridge.areKeysReleased(triggerKeys);
    if (keysReleased !== true) {
      await cancelNativePasteJob(job);
      finishSelectionMetrics(requestId, "no_input");
      return {
        status: "copied_only",
        reasonCode: keysReleased === false ? "trigger_key_held" : "key_state_unavailable",
      };
    }

    // Keep the host foreground until the authorized helper takes focus. Hiding
    // first lets Windows activate a transient/third window and cancels the paste.
    const target = panelTarget;
    job.pasteRequested = true;
    const pasted = await client.request({
      kind: "paste",
      jobId: job.jobId,
      prepareToken: prepared.prepareToken,
      hostWindow,
      target,
      expectedClipboardSequence: written.clipboardSequence,
      triggerKeys,
    }, generation, { timeoutMs: 750 });
    if (
      pasted.status === "input_submitted" &&
      pasted.jobId === job.jobId &&
      pasted.target.hwnd === target.hwnd &&
      pasted.target.pid === target.pid &&
      pasted.target.processCreatedAt === target.processCreatedAt
    ) {
      metrics.mark(requestId, "send_input_acknowledged");
      if (panelGeneration === generation) {
        hidePanel(false);
        metrics.mark(requestId, "panel_hidden");
        panelGeneration = null;
        panelTarget = null;
      }
      finishSelectionMetrics(requestId, "ok");
      return { status: "input_submitted" };
    }
    if (pasted.status === "input_submitted") {
      if (mainWindow && !mainWindow.isVisible()) showPanel();
      finishSelectionMetrics(requestId, "failed");
      return { status: "unknown", reasonCode: "input_ack_identity_mismatch" };
    }
    if (mainWindow && !mainWindow.isVisible()) showPanel();
    finishSelectionMetrics(requestId, "failed");
    return {
      status: "copied_only",
      reasonCode: "reasonCode" in pasted ? pasted.reasonCode : pasted.status,
    };
  } catch (error) {
    const reasonCode = error instanceof Error ? error.message : "native_paste_failed";
    if (job.clipboardCommitAttempted) {
      // A lost acknowledgement makes the side effect unknown. Never retry it.
      if (mainWindow && !mainWindow.isVisible()) showPanel();
      finishSelectionMetrics(requestId, "failed");
      return { status: "unknown", reasonCode };
    }
    if (reasonCode === "image_prepare_timeout") {
      // Keep the panel and clipboard untouched when the bounded image preparation expires.
      finishSelectionMetrics(requestId, "failed");
      return { status: "blocked", reasonCode };
    }
    if (item.type === "image") {
      // An image snapshot is decoded and bounded before the helper can commit.
      // If that preparation fails, copying through Electron would bypass the
      // failed worker path and replace the user's current clipboard contents.
      finishSelectionMetrics(requestId, "failed");
      return { status: reasonCode === "paste_cancelled" ? "cancelled" : "blocked", reasonCode };
    }
    const currentItem = history.find((candidate) => candidate.id === item.id);
    const selectedContentStillCurrent =
      currentItem?.type === item.type && currentItem.content === item.content;
    if (
      !job.cancelled &&
      !helperClipboardFence.isBlocked &&
      generation === panelGeneration &&
      Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) &&
      selectedContentStillCurrent
    ) {
      try {
        writeItemToElectronClipboard(item);
        metrics.mark(requestId, "clipboard_written");
        hidePanel(false);
        metrics.mark(requestId, "panel_hidden");
        finishSelectionMetrics(requestId, "ok");
        return { status: "copied_only", reasonCode };
      } catch {
        finishSelectionMetrics(requestId, "failed");
        return { status: "blocked", reasonCode: helperClipboardFence.isBlocked ? "helper_side_effect_unresolved" : "clipboard_write_failed" };
      }
    }
    finishSelectionMetrics(requestId, "failed");
    return { status: reasonCode === "paste_cancelled" ? "cancelled" : "blocked", reasonCode };
  } finally {
    if (!job.registrationAttempted || (job.cancelled && job.cancellationQuiescent) || client.hasExited) {
      if (job.snapshot) provider.release(job.snapshot, job.jobId, job.objectToken);
      if (nativePasteJob === job) nativePasteJob = null;
      job.resolveTerminal();
    } else if (!job.clipboardCommitAttempted && !job.cancelled && nativePasteJob === job) {
      void cancelNativePasteJob(job);
    }
  }
  } finally {
    selectionMonitorActive = false;
    selectionKeyReleaseMonitor?.cancel();
  }
}

function registerIpc(): void {
  ipcMain.on("metrics:panel-actionable", (event, requestId: unknown) => {
    if (
      !mainWindow ||
      event.sender.id !== mainWindow.webContents.id ||
      typeof requestId !== "string" ||
      !metrics.isActive(requestId)
    ) return;
    if (suppressBenchmarkAcknowledgement) return;

    metrics.mark(requestId, "panel_actionable");
    if (!metrics.finish(requestId, "ok")) return;
    if (!benchmarkMode) {
      void metrics.flush().catch(() => undefined);
      return;
    }
    completeBenchmarkSample(requestId, true);
  });

  ipcMain.handle("history:get", () => history);
  ipcMain.handle("settings:get", () => getAppSettingsSnapshot());
  ipcMain.handle("settings:update", (_event, patch: unknown) => updateAppSettings(patch));
  ipcMain.handle("settings:storage:choose", chooseStorageDirectory);
  ipcMain.handle("cloud:sync", () => syncCloudHistory());
  ipcMain.handle("updates:get", () => updateInfo);
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:download", () => downloadUpdate());
  ipcMain.handle("updates:install", () => installUpdate());
  ipcMain.handle("history:copy", async (event, id: unknown, triggerKeys: unknown, generation: unknown): Promise<CopyItemResult> => {
    const requestId = metrics.begin("selection");
    const trustedFrame = event.senderFrame === event.sender.mainFrame;
    const result = await copySelectedItem(event.sender.id, trustedFrame, id, triggerKeys, generation, requestId);
    if (process.env.CLIPNEST_DEBUG_PASTE === "1") {
      // Only operation status: never log clipboard contents or target window titles.
      console.info("ClipNest: paste result", JSON.stringify(result));
    }
    return result;
  });
  ipcMain.handle("history:edit", (_event, id: string, content: string) => {
    if (typeof content !== "string") throw new Error("常用内容格式无效");
    editPinnedHistoryItem(id, content);
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
  ipcMain.handle("panel:hide", () => hidePanel());
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
    app.setAppUserModelId(benchmarkMode ? "com.clipnest.app.t01" : "com.clipnest.app");
    if (benchmarkMode) {
      loadAppSettings();
      appSettings = {
        ...appSettings,
        storageDirectory: benchmarkProfileDirectory(),
        cloudEnabled: false,
        cloudAccessToken: "",
        cloudWebPassword: "",
        cloudEncryptionKey: "",
      };
      storeDirectory = benchmarkProfileDirectory();
      storePath = join(storeDirectory, HISTORY_FILE_NAME);
    } else {
      registerAutoUpdater();
      // Keep the data location stable even when the app is launched from a
      // portable folder or the executable is rebuilt with a different name.
      configureStartup();
    }
    loadHistory();
    createMainWindow();
    startNativeHelper();
    if (!benchmarkMode) createTray();
    registerIpc();
    cloudSyncState = appSettings.cloudEnabled
      ? (isCloudConfigured() ? "idle" : "error")
      : "disabled";
    cloudSyncError = appSettings.cloudEnabled && !isCloudConfigured()
      ? "请先配置云端项目令牌"
      : null;
    if (appSettings.cloudEnabled && isCloudConfigured()) void syncCloudHistory();

    if (!benchmarkMode) {
      const registered = globalShortcut.register("CommandOrControl+Shift+V", showPanel);
      if (!registered) {
        console.warn("ClipNest: 无法注册 Ctrl+Shift+V，可能已被其他软件占用。");
      }
      pollClipboard();
      pollTimer = setInterval(pollClipboard, POLL_INTERVAL_MS);
    }
  });

  if (!benchmarkMode) app.on("activate", showPanel);
  app.on("window-all-closed", () => {
    // ClipNest stays alive in the tray even if the panel is closed.
  });
  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (pollTimer) clearInterval(pollTimer);
    void imagePreparationService.dispose();
    helperClient?.close();
    helperClient = null;
    helperReady = null;
    win32HostBridge?.close();
    win32HostBridge = null;
    tray?.destroy();
  });
}
