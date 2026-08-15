import {
  ArrowLeft,
  Check,
  FolderOpen,
  HardDrive,
  Heart,
  Power,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ClipnestSettings } from "../shared/types";

interface SettingsPageProps {
  settings: ClipnestSettings | null;
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
  onBack,
  onSettingsChange,
  onNotice,
}: SettingsPageProps) {
  const [maxItems, setMaxItems] = useState("");

  useEffect(() => {
    if (settings) setMaxItems(String(settings.maxHistoryItems));
  }, [settings]);

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

        <footer className="settings-footer">ClipNest · 本地优先 · Windows x64</footer>
      </div>
    </div>
  );
}
