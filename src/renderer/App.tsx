import {
  Check,
  Circle,
  FileText,
  Heart,
  Image as ImageIcon,
  Layers3,
  Link2,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ClipboardItem, ClipboardType, ClipnestSettings, UpdateInfo } from "../shared/types";
import SettingsPage from "./SettingsPage";

type Filter = "all" | "favorite" | ClipboardType;
type ViewMode = "history" | "settings";

const filters: Array<{
  id: Filter;
  label: string;
  icon: typeof Layers3;
}> = [
  { id: "all", label: "全部历史", icon: Layers3 },
  { id: "favorite", label: "常用", icon: Heart },
  { id: "text", label: "文本", icon: FileText },
  { id: "link", label: "链接", icon: Link2 },
  { id: "image", label: "图片", icon: ImageIcon },
];

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(type: ClipboardType): string {
  if (type === "image") return "图片";
  if (type === "link") return "链接";
  return "文本";
}

function TypeIcon({ type, size = 16 }: { type: ClipboardType; size?: number }) {
  if (type === "image") return <ImageIcon size={size} strokeWidth={1.8} />;
  if (type === "link") return <Link2 size={size} strokeWidth={1.8} />;
  return <FileText size={size} strokeWidth={1.8} />;
}

export interface VirtualHistoryGridHandle {
  scrollToIndex: (index: number) => void;
}

interface VirtualHistoryGridProps {
  items: ClipboardItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCopy: (item: ClipboardItem) => void;
  onDelete: (item: ClipboardItem) => void;
  onPin: (item: ClipboardItem) => void;
}

const GRID_GAP = 14;
const GRID_CARD_WIDTH = 205;
const GRID_CARD_HEIGHT = 260;
const GRID_ITEM_SIZE = GRID_CARD_WIDTH + GRID_GAP;

const VirtualHistoryGrid = forwardRef<VirtualHistoryGridHandle, VirtualHistoryGridProps>(
  function VirtualHistoryGrid({ items, selectedId, onSelect, onCopy, onDelete, onPin }, ref) {
    const scrollRef = useRef<HTMLElement | null>(null);
    const virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => GRID_ITEM_SIZE,
      overscan: 4,
      horizontal: true,
      getItemKey: (index) => items[index]?.id ?? index,
    });

    useImperativeHandle(ref, () => ({
      scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    }), [virtualizer]);

    useEffect(() => {
      if (!selectedId) return;
      const index = items.findIndex((item) => item.id === selectedId);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
    }, [items, selectedId, virtualizer]);

    const virtualItems = virtualizer.getVirtualItems();
    return (
      <div className="grid-shell">
        <section
          className="paste-grid virtual-grid"
          role="listbox"
          aria-label="剪切板历史"
          ref={scrollRef}
        >
          <div
            className="virtual-grid-spacer"
            style={{ width: virtualizer.getTotalSize(), height: GRID_CARD_HEIGHT }}
          >
            {virtualItems.map((virtualItem) => {
              const item = items[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  className="virtual-card"
                  key={item.id}
                  style={{
                    width: GRID_CARD_WIDTH,
                    height: GRID_CARD_HEIGHT,
                    transform: `translateX(${virtualItem.start}px)`,
                  }}
                >
                  <HistoryCard
                    item={item}
                    index={virtualItem.index}
                    selected={item.id === selectedId}
                    onSelect={() => onSelect(item.id)}
                    onCopy={() => onCopy(item)}
                    onDelete={() => onDelete(item)}
                    onPin={() => onPin(item)}
                  />
                </div>
              );
            })}
          </div>
        </section>
        <div className="grid-hint"><kbd>↑</kbd><kbd>↓</kbd> 选择 <span>·</span> <kbd>↵</kbd> 复制</div>
      </div>
    );
  },
);

function App() {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [settings, setSettings] = useState<ClipnestSettings | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("history");
  const [activeFilter, setActiveFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const virtualGridRef = useRef<VirtualHistoryGridHandle>(null);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "favorite" ? item.pinned : item.type === activeFilter);
      const searchableContent = item.type === "image" ? item.preview : item.content;
      const searchableText = `${searchableContent} ${(item.tags ?? []).join(" ")}`.toLowerCase();
      return matchesFilter && (!normalizedQuery || searchableText.includes(normalizedQuery));
    });
  }, [activeFilter, items, query]);

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null,
    [filteredItems, selectedId],
  );

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1800);
  }, []);

  const copyItem = useCallback(
    async (item: ClipboardItem | null) => {
      if (!item) return;
      await window.clipnest.copyItem(item.id);
      showNotice("已复制，随时可以粘贴");
    },
    [showNotice],
  );

  useEffect(() => {
    void Promise.all([
      window.clipnest.getHistory(),
      window.clipnest.getSettings(),
      window.clipnest.getUpdateInfo(),
    ]).then(
      ([nextItems, nextSettings, nextUpdateInfo]) => {
        setItems(nextItems);
        setSettings(nextSettings);
        setUpdateInfo(nextUpdateInfo);
      },
    );
    const removeHistoryListener = window.clipnest.onHistoryUpdated((nextItems) => setItems(nextItems));
    const removeSettingsListener = window.clipnest.onSettingsUpdated((nextSettings) => setSettings(nextSettings));
    const removeUpdateListener = window.clipnest.onUpdateState((nextUpdateInfo) => setUpdateInfo(nextUpdateInfo));
    const removeNavigateListener = window.clipnest.onNavigateSettings(() => setViewMode("settings"));
    return () => {
      removeHistoryListener();
      removeSettingsListener();
      removeUpdateListener();
      removeNavigateListener();
    };
  }, []);

  useEffect(() => {
    if (!selectedItem) {
      setSelectedId(null);
    } else if (!filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(selectedItem.id);
    }
  }, [filteredItems, selectedId, selectedItem]);

  useEffect(() => {
    const cleanup = window.clipnest.onPanelShown(() => {
      if (viewMode !== "history") return;
      window.requestAnimationFrame(() => searchRef.current?.focus());
    });
    return cleanup;
  }, [viewMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const isInput = activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA";

      if (event.key === "Escape") {
        event.preventDefault();
        if (viewMode === "settings") {
          setViewMode("history");
        } else {
          void window.clipnest.hidePanel();
        }
        return;
      }
      if (viewMode !== "history") return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (isInput) return;

      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (!filteredItems.length) return;
        const currentIndex = Math.max(
          0,
          filteredItems.findIndex((item) => item.id === selectedItem?.id),
        );
        const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const nextIndex = (currentIndex + offset + filteredItems.length) % filteredItems.length;
        setSelectedId(filteredItems[nextIndex].id);
        virtualGridRef.current?.scrollToIndex(nextIndex);
        return;
      }

      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void copyItem(selectedItem);
        return;
      }

      if (event.key === "Delete" && !isInput && selectedItem) {
        event.preventDefault();
        if (selectedItem.pinned) {
          showNotice("常用内容已保护，请先取消常用标签");
        } else {
          void window.clipnest.deleteItem(selectedItem.id);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copyItem, filteredItems, selectedItem, showNotice, viewMode]);

  const countFor = (filter: Filter): number => {
    if (filter === "all") return items.length;
    if (filter === "favorite") return items.filter((item) => item.pinned).length;
    return items.filter((item) => item.type === filter).length;
  };

  const handleClear = async () => {
    await window.clipnest.clearHistory();
    showNotice("非收藏历史已清除");
  };

  const handleDelete = (item: ClipboardItem) => {
    if (item.pinned) {
      showNotice("常用内容已保护，请先取消常用标签");
      return;
    }
    void window.clipnest.deleteItem(item.id);
  };

  return (
    <div className="app-shell">
      {viewMode === "settings" ? (
        <SettingsPage
          settings={settings}
          updateInfo={updateInfo}
          onBack={() => setViewMode("history")}
          onSettingsChange={setSettings}
          onNotice={showNotice}
        />
      ) : (
        <>
          <header className="paste-topbar drag-region">
            <div className="window-controls no-drag" aria-label="窗口控制">
              <button
                className="traffic-light traffic-red"
                onClick={() => void window.clipnest.hidePanel()}
                aria-label="关闭面板"
              ><Circle size={13} fill="currentColor" strokeWidth={1.2} /></button>
              <span className="traffic-light traffic-yellow" aria-hidden="true"><Circle size={13} fill="currentColor" strokeWidth={1.2} /></span>
              <span className="traffic-light traffic-green" aria-hidden="true"><Circle size={13} fill="currentColor" strokeWidth={1.2} /></span>
            </div>

            <div className="paste-brand">
              <span className="brand-name">ClipNest</span>
              <span className="brand-subtitle">剪切板</span>
            </div>

            <div className="paste-toolbar no-drag">
              <div className="search-box">
                <Search size={17} strokeWidth={2} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索剪切板历史…"
                  aria-label="搜索剪切板历史"
                />
                {query && (
                  <button className="clear-search" onClick={() => setQuery("")} aria-label="清除搜索">
                    <X size={14} />
                  </button>
                )}
                <div className="key-hint"><kbd>Ctrl</kbd><kbd>K</kbd></div>
              </div>
              <div className="top-filter-stack">
                <button
                  className={`top-chip ${activeFilter === "all" ? "active" : ""}`}
                  onClick={() => setActiveFilter("all")}
                >
                  <Circle className="chip-dot neutral-dot" size={9} fill="currentColor" strokeWidth={0} />
                  剪切板历史记录
                  <span className="chip-count">{items.length}</span>
                </button>
                <button
                  className={`top-chip utility-chip ${activeFilter === "favorite" ? "active" : ""}`}
                  onClick={() => setActiveFilter("favorite")}
                >
                  <Heart className="chip-dot favorite-dot" size={11} fill="currentColor" strokeWidth={1.5} />
                  常用
                  <span className="chip-count">{countFor("favorite")}</span>
                </button>
              </div>
              <button
                className="plus-button"
                onClick={() => searchRef.current?.focus()}
                aria-label="搜索剪切板"
              >
                <Plus size={17} strokeWidth={1.8} />
              </button>
            </div>

            <button className="more-button no-drag" onClick={() => setViewMode("settings")} aria-label="打开设置">
              <Settings2 size={17} />
            </button>
          </header>

          <main className="paste-content">
            <div className="view-toolbar no-drag">
              <nav className="filter-pills" aria-label="剪切板分类">
                {filters.map((filter) => {
                  const Icon = filter.icon;
                  const isActive = activeFilter === filter.id;
                  return (
                    <button
                      key={filter.id}
                      className={`filter-button ${isActive ? "active" : ""}`}
                      onClick={() => setActiveFilter(filter.id)}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <Icon size={14} strokeWidth={isActive ? 2.1 : 1.8} fill={filter.id === "favorite" && isActive ? "currentColor" : "none"} />
                      <span>{filter.label}</span>
                      <span className="filter-count">{countFor(filter.id)}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="view-actions">
                <div className="listening-pill"><Circle className="pulse-dot" size={7} fill="currentColor" strokeWidth={0} /> 正在监听</div>
                <div className="view-count">
                  {query ? `匹配 ${filteredItems.length} 条` : `${filteredItems.length} 条记录`}
                </div>
                {items.some((item) => !item.pinned) && (
                  <button className="clear-button" onClick={() => void handleClear()}>
                    <Trash2 size={13} /> 清除非收藏
                  </button>
                )}
              </div>
            </div>

            {items.length === 0 ? (
              <EmptyState />
            ) : filteredItems.length === 0 ? (
              <div className="empty-filter-state">
                <div className="empty-filter-icon"><Search size={21} /></div>
                <h2>没有找到匹配内容</h2>
                <p>试试其他关键词，或者切换上方分类。</p>
                <button className="ghost-button" onClick={() => { setQuery(""); setActiveFilter("all"); }}>
                  显示全部历史
                </button>
              </div>
            ) : (
              <VirtualHistoryGrid
                ref={virtualGridRef}
                items={filteredItems}
                selectedId={selectedItem?.id ?? null}
                onSelect={setSelectedId}
                onCopy={(item) => void copyItem(item)}
                onDelete={handleDelete}
                onPin={(item) => void window.clipnest.togglePinItem(item.id)}
              />
            )}
          </main>
        </>
      )}

      {notice && <div className="toast"><Check size={15} /> {notice}</div>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Layers3 size={23} /></div>
      <h2>这里会收集你复制过的内容</h2>
      <p>复制文本、链接或图片，它们会自动出现在这里。<br />按下 <kbd>Ctrl ⇧ V</kbd>，随时打开 ClipNest。</p>
      <div className="empty-steps"><span>1</span><b>复制</b><span>2</span><b>呼出</b><span>3</span><b>选择</b></div>
    </div>
  );
}

function HistoryCard({
  item,
  index,
  selected,
  onSelect,
  onCopy,
  onDelete,
  onPin,
}: {
  item: ClipboardItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  return (
    <article
      className={`history-card type-${item.type} ${selected ? "selected" : ""} ${item.pinned ? "is-favorite" : ""}`}
      role="option"
      aria-selected={selected}
      onClick={() => {
        onSelect();
        onCopy();
      }}
      onDoubleClick={onCopy}
    >
      <div className={`paste-card-header type-${item.type}`}>
        <div className="card-header-copy">
          <strong>{typeLabel(item.type)}</strong>
          <span>{formatTime(item.createdAt)}</span>
        </div>
        <div className="card-header-actions">
          {item.pinned && <span className="favorite-tag"><Heart size={11} fill="currentColor" /> 常用</span>}
          <TypeIcon type={item.type} size={18} />
        </div>
      </div>
      <div className="card-content">
        {item.type === "image" ? (
          <div className="image-card-preview">
            <img src={item.content} alt={item.preview} loading="lazy" />
          </div>
        ) : item.type === "link" ? (
          <div className="text-card-preview link-preview">
            <Link2 size={14} />
            <span>{item.preview}</span>
          </div>
        ) : (
          <div className="text-card-preview">
            {item.preview}
          </div>
        )}
      </div>
      <div className="card-footer">
        <span>{item.type === "image" ? `${item.width ?? 0} × ${item.height ?? 0}` : formatBytes(item.byteSize)}</span>
        <span>{item.pinned ? "自动保护" : `#${String(index + 1).padStart(2, "0")}`}</span>
      </div>
      <div className="card-actions no-drag">
        <button onClick={(event) => { event.stopPropagation(); onPin(); }} className={item.pinned ? "is-pinned" : ""} aria-label={item.pinned ? "取消常用" : "标记为常用"}>
          <Heart size={14} fill={item.pinned ? "currentColor" : "none"} />
        </button>
        {!item.pinned && (
          <button onClick={(event) => { event.stopPropagation(); onDelete(); }} aria-label="删除">
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {selected && <div className="selected-bar" />}
    </article>
  );
}

export default App;
