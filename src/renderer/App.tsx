import {
  Check,
  Circle,
  FileText,
  Heart,
  Image as ImageIcon,
  Layers3,
  Link2,
  Pencil,
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
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ClipboardItem, ClipboardType, ClipnestSettings, UpdateInfo } from "../shared/types";
import type { NativeTriggerKey } from "../shared/native-contracts";
import SettingsPage from "./SettingsPage";

type Filter = "all" | "favorite" | ClipboardType;
type ViewMode = "history" | "settings";

const filters: Array<{
  id: Filter;
  label: string;
  icon: typeof Layers3;
}> = [
  { id: "all", label: "历史", icon: Layers3 },
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
  scrollToStart: () => void;
}

interface VirtualHistoryGridProps {
  items: ClipboardItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCopy: (item: ClipboardItem) => void;
  onDelete: (item: ClipboardItem) => void;
  onPin: (item: ClipboardItem) => void;
  onEdit: (item: ClipboardItem, content: string) => void;
}

const GRID_GAP = 16;
const GRID_CARD_WIDTH = 220;
const GRID_CARD_HEIGHT = 232;
const GRID_ITEM_SIZE = GRID_CARD_WIDTH + GRID_GAP;

const VirtualHistoryGrid = forwardRef<VirtualHistoryGridHandle, VirtualHistoryGridProps>(
  function VirtualHistoryGrid({ items, selectedId, onSelect, onCopy, onDelete, onPin, onEdit }, ref) {
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
      scrollToStart: () => virtualizer.scrollToOffset(0),
    }), [virtualizer]);

    const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
      const element = event.currentTarget;
      if (element.scrollWidth <= element.clientWidth) return;
      const rawDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
      if (!rawDelta) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      event.preventDefault();
      element.scrollLeft += rawDelta * unit;
    };

    const virtualItems = virtualizer.getVirtualItems();
    return (
      <div className="grid-shell">
        <section
          className="paste-grid virtual-grid"
          role="listbox"
          aria-label="剪切板历史"
          ref={scrollRef}
          onWheel={handleWheel}
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
                    onEdit={(content) => onEdit(item, content)}
                  />
                </div>
              );
            })}
          </div>
        </section>
        <div className="grid-hint"><kbd>←</kbd><kbd>→</kbd> 选择 <span>·</span> <kbd>↵</kbd> 粘贴到原输入位置</div>
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
  const [preparingImageRequest, setPreparingImageRequest] = useState<object | null>(null);
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const [panelShowVersion, setPanelShowVersion] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const virtualGridRef = useRef<VirtualHistoryGridHandle>(null);
  const pendingWakeRequestId = useRef<string | null>(null);
  const activePanelGeneration = useRef<string | null>(null);
  const activeCopyIntent = useRef<{ generation: string | null; token: object } | null>(null);
  const searchComposing = useRef(false);
  const searchNavigationActive = useRef(false);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "favorite" ? item.pinned : item.type === activeFilter);
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      const searchableContent = item.type === "image" ? item.preview : item.content;
      const searchableText = `${searchableContent} ${(item.tags ?? []).join(" ")}`.toLowerCase();
      return searchableText.includes(normalizedQuery);
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
    async (item: ClipboardItem | null, triggerKeys: readonly NativeTriggerKey[] = []) => {
      if (!item) return;
      const requestGeneration = activePanelGeneration.current;
      if (activeCopyIntent.current?.generation === requestGeneration) return;
      const requestToken = {};
      activeCopyIntent.current = { generation: requestGeneration, token: requestToken };
      if (item.type === "image") setPreparingImageRequest(requestToken);
      try {
        const result = await window.clipnest.copyItem(item.id, triggerKeys);
        if (requestGeneration !== activePanelGeneration.current) return;
        switch (result.status) {
          case "input_submitted":
            showNotice("已发送粘贴快捷键");
            break;
          case "copied_only":
            showNotice("已复制，请手动粘贴");
            break;
          case "cancelled":
            showNotice("操作已取消");
            break;
          case "blocked":
            showNotice("当前无法复制或自动粘贴");
            break;
          case "not_found":
            showNotice("内容已不存在");
            break;
          case "unknown":
            showNotice("操作结果未知，请检查目标窗口，勿重复触发");
            break;
        }
      } catch {
        if (requestGeneration === activePanelGeneration.current) showNotice("复制失败");
      } finally {
        if (activeCopyIntent.current?.token === requestToken) activeCopyIntent.current = null;
        setPreparingImageRequest((current) => current === requestToken ? null : current);
      }
    },
    [showNotice],
  );

  const editItem = useCallback(async (item: ClipboardItem, content: string) => {
    try {
      await window.clipnest.editItem(item.id, content);
      showNotice("常用内容已更新");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "常用内容更新失败");
    }
  }, [showNotice]);

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
        setInitialDataLoaded(true);
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
    return window.clipnest.onPanelShown((requestId, generation) => {
      setSelectedId(null);
      if (activePanelGeneration.current !== generation) {
        activeCopyIntent.current = null;
        searchNavigationActive.current = false;
        searchComposing.current = false;
        setPreparingImageRequest(null);
      }
      activePanelGeneration.current = generation;
      pendingWakeRequestId.current = requestId;
      setPanelShowVersion((version) => version + 1);
    });
  }, []);

  useEffect(() => {
    if (!panelShowVersion || viewMode !== "history") return;
    const requestId = pendingWakeRequestId.current;
    if (requestId && !initialDataLoaded) return;
    const frame = window.requestAnimationFrame(() => {
      virtualGridRef.current?.scrollToStart();
      searchRef.current?.focus();
      if (pendingWakeRequestId.current && document.activeElement === searchRef.current) {
        const actionableRequestId = pendingWakeRequestId.current;
        window.clipnest.reportPanelActionable(actionableRequestId);
        pendingWakeRequestId.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDataLoaded, panelShowVersion, viewMode]);

  useEffect(() => {
    virtualGridRef.current?.scrollToStart();
  }, [activeFilter, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const isInput = activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA";
      const isSearchInput = activeElement === searchRef.current;
      const isComposing = event.isComposing || searchComposing.current;

      if (event.key === "Escape") {
        if (isComposing || activeElement?.tagName === "TEXTAREA") return;
        event.preventDefault();
        if (viewMode === "settings") {
          setViewMode("history");
        } else {
          void window.clipnest.hidePanel();
        }
        return;
      }
      if (isComposing) return;
      if (viewMode !== "history") return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (isSearchInput && (event.key === "ArrowDown" || (event.key === "ArrowUp" && searchNavigationActive.current))) {
        event.preventDefault();
        if (!filteredItems.length) return;
        const currentIndex = filteredItems.findIndex((item) => item.id === selectedItem?.id);
        const nextIndex = !searchNavigationActive.current
          ? 0
          : (Math.max(0, currentIndex) + (event.key === "ArrowUp" ? -1 : 1) + filteredItems.length) % filteredItems.length;
        searchNavigationActive.current = true;
        setSelectedId(filteredItems[nextIndex].id);
        virtualGridRef.current?.scrollToIndex(nextIndex);
        return;
      }

      if (isSearchInput && event.key === "Enter") {
        if (isComposing) return;
        event.preventDefault();
        if (event.repeat) return;
        void copyItem(selectedItem, ["Enter"]);
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

      if (event.key === "Enter") {
        if (isComposing) return;
        event.preventDefault();
        if (event.repeat) return;
        void copyItem(selectedItem, ["Enter"]);
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
            <div className="paste-toolbar no-drag">
              <div className="search-box">
                <Search size={17} strokeWidth={2} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    searchNavigationActive.current = false;
                    if (event.target.value !== query) setSelectedId(null);
                    setQuery(event.target.value);
                  }}
                  onCompositionStart={() => { searchComposing.current = true; }}
                  onCompositionEnd={() => { searchComposing.current = false; }}
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
            </div>
            <div className="view-actions no-drag">
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
            <button className="more-button no-drag" onClick={() => setViewMode("settings")} aria-label="打开设置" title="设置">
              <Settings2 size={17} />
            </button>
            <button className="more-button close-panel-button no-drag" onClick={() => void window.clipnest.hidePanel()} aria-label="关闭面板" title="关闭面板（Esc）">
              <X size={18} />
            </button>
          </header>

          <main className="paste-content">
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
                onEdit={(item, content) => void editItem(item, content)}
              />
            )}
          </main>
        </>
      )}

      {preparingImageRequest ? (
        <div className="toast" role="status" aria-live="polite"><Circle size={15} /> 正在准备图片…</div>
      ) : notice && <div className="toast"><Check size={15} /> {notice}</div>}
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
  onEdit,
}: {
  item: ClipboardItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onPin: () => void;
  onEdit: (content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);

  useEffect(() => {
    if (!editing) setDraft(item.content);
  }, [editing, item.content]);

  const saveDraft = () => {
    if (item.type === "image" || !draft.trim()) return;
    onEdit(draft);
    setEditing(false);
  };

  return (
    <article
      className={`history-card type-${item.type} ${selected ? "selected" : ""} ${item.pinned ? "is-favorite" : ""} ${editing ? "is-editing" : ""}`}
      role="option"
      aria-selected={selected}
      onClick={() => {
        if (editing) return;
        onSelect();
        onCopy();
      }}
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
        {editing ? (
          <div className="card-editor" onClick={(event) => event.stopPropagation()}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  saveDraft();
                }
              }}
              autoFocus
              aria-label="编辑常用内容"
            />
            <div className="card-editor-actions">
              <button type="button" onClick={() => setEditing(false)}>取消</button>
              <button type="button" className="primary" onClick={saveDraft}>保存</button>
            </div>
          </div>
        ) : item.type === "image" ? (
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
        {item.pinned && item.type !== "image" && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
            aria-label="编辑常用内容"
          >
            <Pencil size={13} />
          </button>
        )}
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
