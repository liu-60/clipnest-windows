import {
  ArrowLeft,
  Check,
  Cloud,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Heart,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ClipnestSettings, ClipnestSettingsPatch, UpdateInfo } from "../shared/types";

interface SettingsPageProps {
  settings: ClipnestSettings | null;
  updateInfo: UpdateInfo | null;
  onBack: () => void;
  onSettingsChange: (settings: ClipnestSettings) => void;
  onNotice: (message: string) => void;
}

function shortenPath(path: string): string {
  if (path.length <= 64) return path;
  return `${path.slice(0, 28)}…${path.slice(-32)}`;
}

export default function SettingsPage({
  settings,
  updateInfo,
  onBack,
  onSettingsChange,
  onNotice,
}: SettingsPageProps) {
  const [maxItems, setMaxItems] = useState("");
  const [cloudEndpoint, setCloudEndpoint] = useState("");
  const [cloudProjectId, setCloudProjectId] = useState("");
  const [cloudToken, setCloudToken] = useState("");

  useEffect(() => {
    if (!settings) return;
    setMaxItems(String(settings.maxHistoryItems));
    setCloudEndpoint(settings.cloudEndpoint);
    setCloudProjectId(settings.cloudProjectId);
    setCloudToken("");
  }, [settings?.cloudEndpoint, settings?.cloudProjectId, settings?.maxHistoryItems]);

  if (!settings) {
    return (
      <div className="settings-page">
        <div className="settings-header drag-region">
          <button className="settings-back no-drag" onClick={onBack} aria-label="返回历史">
            <ArrowLeft size={17} />
          </button>
          <div>
            <strong>配置 ClipNest</strong>
            <span>正在读取本地设置…</span>
          </div>
        </div>
      </div>
    );
  }

  const saveMaxItems = async () => {
    const nextValue = Number(maxItems);
    if (!Number.isFinite(nextValue)) {
      setMaxItems(String(settings.maxHistoryItems));
      return;
    }
    const nextSettings = await window.clipnest.updateSettings({ maxHistoryItems: nextValue });
    onSettingsChange(nextSettings);
    setMaxItems(String(nextSettings.maxHistoryItems));
    onNotice(`最多保存 ${nextSettings.maxHistoryItems} 条剪切内容`);
  };

  const toggleStartup = async () => {
    if (!settings.startupSupported) return;
    const nextSettings = await window.clipnest.updateSettings({
      startupEnabled: !settings.startupEnabled,
    });
    onSettingsChange(nextSettings);
    onNotice(nextSettings.startupEnabled ? "已开启开机自启" : "已关闭开机自启");
  };

  const chooseStorage = async () => {
    const nextSettings = await window.clipnest.chooseStorageDirectory();
    if (!nextSettings) return;
    onSettingsChange(nextSettings);
    onNotice("剪切板历史保存位置已更新");
  };

  const saveCloud = async () => {
    const patch: ClipnestSettingsPatch = {
      cloudEndpoint: cloudEndpoint.trim(),
      cloudProjectId: cloudProjectId.trim(),
    };
    if (cloudToken.trim()) patch.cloudAccessToken = cloudToken.trim();

    try {
      let nextSettings = await window.clipnest.updateSettings(patch);
      onSettingsChange(nextSettings);
      if (!nextSettings.cloudEnabled) {
        onNotice("云端存储已关闭");
        return;
      }
      nextSettings = await window.clipnest.syncCloud();
      onSettingsChange(nextSettings);
      onNotice(nextSettings.cloudSyncState === "synced" ? "云端同步成功" : (nextSettings.cloudError ?? "云端同步失败"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "云端配置失败");
    }
  };

  const toggleCloud = async () => {
    try {
      const nextSettings = await window.clipnest.updateSettings({ cloudEnabled: !settings.cloudEnabled });
      onSettingsChange(nextSettings);
      if (nextSettings.cloudEnabled) {
        const syncedSettings = await window.clipnest.syncCloud();
        onSettingsChange(syncedSettings);
        onNotice(syncedSettings.cloudSyncState === "synced" ? "云端存储已开启" : (syncedSettings.cloudError ?? "云端同步失败"));
      } else {
        onNotice("云端存储已关闭");
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "云端设置失败");
    }
  };

  const syncCloudNow = async () => {
    try {
      const nextSettings = await window.clipnest.syncCloud();
      onSettingsChange(nextSettings);
      onNotice(nextSettings.cloudSyncState === "synced" ? "云端同步成功" : (nextSettings.cloudError ?? "云端同步失败"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "云端同步失败");
    }
  };

  const checkUpdates = async () => {
    const nextInfo = await window.clipnest.checkForUpdates();
    if (nextInfo.state === "available") onNotice(`发现新版本 v${nextInfo.latestVersion}`);
    else if (nextInfo.state === "up-to-date") onNotice("当前已是最新版本");
    else if (nextInfo.error) onNotice(nextInfo.error);
  };

  const downloadUpdate = async () => {
    const nextInfo = await window.clipnest.downloadUpdate();
    if (nextInfo.state === "error" && nextInfo.error) onNotice(nextInfo.error);
  };

  const installUpdate = async () => {
    await window.clipnest.installUpdate();
  };

  const cloudStatus = settings.cloudSyncState === "syncing"
    ? "正在同步…"
    : settings.cloudSyncState === "synced"
      ? `已同步${settings.cloudLastSyncAt ? ` · ${new Date(settings.cloudLastSyncAt).toLocaleString("zh-CN")}` : ""}`
      : settings.cloudSyncState === "error"
        ? (settings.cloudError ?? "同步失败")
        : settings.cloudEnabled
          ? "等待同步"
          : "未启用";

  const cloudEndpointUsesHttp = /^http:\/\/(?!localhost(?::|\/)|127\.0\.0\.1(?::|\/)|\[?::1\]?(?::|\/))/i.test(
    cloudEndpoint.trim(),
  );

  const updateStatus = updateInfo?.state === "checking"
    ? "正在检查版本…"
    : updateInfo?.state === "available"
      ? `发现 v${updateInfo.latestVersion}`
      : updateInfo?.state === "downloading"
        ? `正在下载 ${updateInfo.downloadProgress}%`
        : updateInfo?.state === "downloaded"
          ? "更新已下载"
          : updateInfo?.state === "up-to-date"
            ? "已是最新版本"
            : updateInfo?.state === "error"
              ? (updateInfo.error ?? "检查失败")
              : "尚未检查";

  return (
    <div className="settings-page">
      <header className="settings-header drag-region">
        <button className="settings-back no-drag" onClick={onBack} aria-label="返回历史">
          <ArrowLeft size={17} />
        </button>
        <div>
          <strong>配置 ClipNest</strong>
          <span>让剪切板按照你的习惯工作</span>
        </div>
        <div className="settings-header-mark"><SlidersHorizontal size={17} /></div>
      </header>

      <div className="settings-scroll">
        <section className="settings-intro">
          <div className="settings-intro-icon"><HardDrive size={23} /></div>
          <div>
            <div className="eyebrow">LOCAL FIRST</div>
            <h1>你的内容，留在你的设备上。</h1>
            <p>调整启动方式、保存位置和历史容量。常用内容会被保护，不会被自动清理。</p>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <Power size={16} />
            <div><strong>启动与常驻</strong><span>打开电脑后，ClipNest 是否在后台待命</span></div>
          </div>
          <button
            className={`settings-row settings-toggle-row ${settings.startupEnabled ? "enabled" : ""}`}
            onClick={() => void toggleStartup()}
            disabled={!settings.startupSupported}
            role="switch"
            aria-checked={settings.startupEnabled}
          >
            <div className="settings-row-copy">
              <strong>Windows 开机自启</strong>
              <span>{settings.startupSupported ? "启动后只驻留托盘，不会自动弹出面板" : "仅 Windows 正式打包版本支持此选项"}</span>
            </div>
            <span className="settings-switch"><span /></span>
          </button>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <HardDrive size={16} />
            <div><strong>历史保存</strong><span>本地文件位置和容量上限</span></div>
          </div>
          <div className="settings-row storage-row">
            <div className="settings-row-copy">
              <strong>剪切内容保存位置</strong>
              <span title={settings.storageDirectory}>{shortenPath(settings.storageDirectory)}</span>
            </div>
            <button className="settings-action" onClick={() => void chooseStorage()}>
              <FolderOpen size={14} /> 选择文件夹
            </button>
          </div>
          <div className="settings-row quantity-row">
            <div className="settings-row-copy">
              <strong>最大保存数量</strong>
              <span>普通内容超过上限后，按时间从旧到新清理；常用内容不受影响</span>
            </div>
            <div className="number-control">
              <input
                type="number"
                min={20}
                max={2000}
                step={10}
                value={maxItems}
                onChange={(event) => setMaxItems(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void saveMaxItems(); }}
                aria-label="最大保存数量"
              />
              <button className="settings-action compact" onClick={() => void saveMaxItems()}>
                <Save size={13} /> 保存
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section settings-protection">
          <div className="settings-section-title">
            <Heart size={16} />
            <div><strong>常用内容保护</strong><span>在历史卡片点击心形/固定按钮即可标记</span></div>
          </div>
          <div className="settings-protection-note">
            <ShieldCheck size={18} />
            <span><b>常用</b> 标签会让内容跳过自动清理和“清除非收藏历史”；取消常用后才可以删除。</span>
            <Check size={17} />
          </div>
        </section>

        <section className="settings-section cloud-section">
          <div className="settings-section-title">
            <Cloud size={16} />
            <div><strong>云端存储</strong><span>项目隔离、端到端加密后同步到你的服务器</span></div>
          </div>
          <button
            className={`settings-row settings-toggle-row ${settings.cloudEnabled ? "enabled" : ""}`}
            onClick={() => void toggleCloud()}
            role="switch"
            aria-checked={settings.cloudEnabled}
          >
            <div className="settings-row-copy">
              <strong>启用云端同步</strong>
              <span>{cloudStatus}</span>
            </div>
            <span className="settings-switch"><span /></span>
          </button>
          <div className="cloud-form">
            {cloudEndpointUsesHttp && (
              <div className="cloud-security-note">
                当前使用 HTTP：历史内容仍会在本地加密后上传，但项目令牌不应在公网明文传输。正式使用请改成 HTTPS 地址。
              </div>
            )}
            <label className="settings-field">
              <span>云端地址</span>
              <input value={cloudEndpoint} onChange={(event) => setCloudEndpoint(event.target.value)} placeholder="http://服务器地址:19132" />
            </label>
            <label className="settings-field">
              <span>项目标识</span>
              <input value={cloudProjectId} onChange={(event) => setCloudProjectId(event.target.value)} placeholder="clipnest-windows" />
            </label>
            <label className="settings-field">
              <span>项目令牌</span>
              <input type="password" value={cloudToken} onChange={(event) => setCloudToken(event.target.value)} placeholder={settings.cloudConfigured ? "已配置，留空保持" : "粘贴项目令牌"} autoComplete="off" />
            </label>
            <div className="cloud-actions">
              <button className="settings-action" onClick={() => void saveCloud()}><Save size={13} /> 保存并同步</button>
              <button className="settings-action compact" onClick={() => void syncCloudNow()}><RefreshCw size={13} /> 立即同步</button>
            </div>
          </div>
        </section>

        <section className="settings-section update-section">
          <div className="settings-section-title">
            <Download size={16} />
            <div><strong>版本与升级</strong><span>检测更新说明，下载后重启完成升级</span></div>
          </div>
          <div className="settings-row update-row">
            <div className="settings-row-copy">
              <strong>当前版本 v{updateInfo?.currentVersion ?? "—"}</strong>
              <span>{updateStatus}</span>
            </div>
            {updateInfo?.state === "available" ? (
              <button className="settings-action" onClick={() => void downloadUpdate()}><Download size={13} /> 一键升级</button>
            ) : updateInfo?.state === "downloaded" ? (
              <button className="settings-action" onClick={() => void installUpdate()}><RefreshCw size={13} /> 立即重启</button>
            ) : (
              <button className="settings-action" onClick={() => void checkUpdates()} disabled={updateInfo?.state === "checking"}>
                <RefreshCw size={13} /> 检查更新
              </button>
            )}
          </div>
          {updateInfo?.state === "downloading" && <div className="update-progress"><span style={{ width: `${updateInfo.downloadProgress}%` }} /></div>}
          {updateInfo?.releaseNotes && updateInfo.state === "available" && (
            <div className="update-notes">
              <div className="update-notes-heading">{updateInfo.releaseName ?? `v${updateInfo.latestVersion}`}</div>
              <pre>{updateInfo.releaseNotes}</pre>
              {updateInfo.releaseUrl && <a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={11} /> 查看完整更新说明</a>}
            </div>
          )}
        </section>

        <footer className="settings-footer">ClipNest · 本地优先 · Windows x64</footer>
      </div>
    </div>
  );
}
