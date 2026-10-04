const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const appPath = path.resolve(__dirname, "../../../src/renderer/App.tsx");
const appSource = fs.readFileSync(appPath, "utf8");
const compiledApp = ts.transpileModule(appSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function makeHarness(history) {
  const fibers = new Map();
  const scrollCalls = [];
  const listeners = new Map();
  const copyCalls = [];
  const pendingCopies = [];
  const scrollOffsetCalls = [];
  const gridItemSize = 219;
  const gridViewportWidth = 219;
  let gridScrollOffset = 0;
  const noOp = () => () => {};
  const document = { activeElement: { tagName: "BODY" } };
  let currentFiber = null;
  let panelShown;
  let hiddenCount = 0;

  const sameDeps = (left, right) => left !== undefined && right !== undefined &&
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  function nextHook(kind, create) {
    assert.ok(currentFiber, `hook ${kind} must be called while rendering a component`);
    const index = currentFiber.index++;
    let slot = currentFiber.hooks[index];
    if (!slot) {
      slot = { kind, ...create() };
      currentFiber.hooks[index] = slot;
    } else {
      assert.equal(slot.kind, kind, `hook order changed at index ${index}`);
    }
    return slot;
  }

  const react = {
    forwardRef(render) {
      const forwarded = (props, ref) => render(props, ref);
      forwarded.displayName = render.name;
      return forwarded;
    },
    useState(initialValue) {
      const slot = nextHook("state", () => ({
        value: typeof initialValue === "function" ? initialValue() : initialValue,
        setter: null,
      }));
      if (!slot.setter) {
        slot.setter = (nextValue) => {
          slot.value = typeof nextValue === "function" ? nextValue(slot.value) : nextValue;
        };
      }
      return [slot.value, slot.setter];
    },
    useRef(initialValue) {
      return nextHook("ref", () => ({ value: { current: initialValue } })).value;
    },
    useMemo(factory, deps) {
      const slot = nextHook("memo", () => ({ value: undefined, deps: undefined }));
      if (!sameDeps(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
      }
      return slot.value;
    },
    useCallback(callback, deps) {
      const slot = nextHook("memo", () => ({ value: undefined, deps: undefined }));
      if (!sameDeps(slot.deps, deps)) {
        slot.value = callback;
        slot.deps = deps;
      }
      return slot.value;
    },
    useEffect(create, deps) {
      const slot = nextHook("effect", () => ({ deps: undefined, cleanup: undefined, pending: null }));
      if (deps === undefined || !sameDeps(slot.deps, deps)) slot.pending = { create, deps };
    },
    useImperativeHandle(ref, create, deps) {
      const slot = nextHook("imperative", () => ({ deps: undefined }));
      if (deps === undefined || !sameDeps(slot.deps, deps)) {
        if (ref) ref.current = create();
        slot.deps = deps;
      }
    },
  };

  function commitEffects(fiber) {
    for (const slot of fiber.hooks) {
      if (slot?.kind !== "effect" || !slot.pending) continue;
      slot.cleanup?.();
      slot.deps = slot.pending.deps;
      slot.cleanup = slot.pending.create();
      slot.pending = null;
    }
  }

  function render(component, props = {}, ref, identity = component) {
    let fiber = fibers.get(identity);
    if (!fiber) {
      fiber = { hooks: [], index: 0 };
      fibers.set(identity, fiber);
    }
    const previousFiber = currentFiber;
    fiber.index = 0;
    currentFiber = fiber;
    let tree;
    try {
      tree = component(props, ref);
    } finally {
      currentFiber = previousFiber;
    }
    commitEffects(fiber);
    return tree;
  }

  const jsxRuntime = {
    Fragment: Symbol.for("test.fragment"),
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  };

  const clipnest = {
    getHistory: async () => history,
    getSettings: async () => ({}),
    getUpdateInfo: async () => null,
    onHistoryUpdated: noOp,
    onSettingsUpdated: noOp,
    onUpdateState: noOp,
    onNavigateSettings: noOp,
    onPanelShown(callback) { panelShown = callback; return () => { panelShown = undefined; }; },
    reportPanelActionable: noOp,
    copyItem(...args) {
      copyCalls.push(args);
      const request = deferred();
      pendingCopies.push(request);
      return request.promise;
    },
    hidePanel() { hiddenCount += 1; },
    deleteItem: noOp,
    editItem: noOp,
    togglePinItem: noOp,
    clearHistory: noOp,
  };

  const window = {
    clipnest,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame: noOp,
    setTimeout: () => 1,
    clearTimeout: noOp,
  };

  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "react") return react;
      if (request === "react/jsx-runtime") return jsxRuntime;
      if (request === "@tanstack/react-virtual") {
        return {
          useVirtualizer(options) {
            return {
              getVirtualItems: () => {
                if (!options.count) return [];
                const firstVisibleIndex = Math.floor(gridScrollOffset / gridItemSize);
                const lastVisibleIndex = Math.min(
                  options.count - 1,
                  Math.floor((gridScrollOffset + gridViewportWidth - 1) / gridItemSize),
                );
                const firstRenderedIndex = Math.max(0, firstVisibleIndex - options.overscan);
                const lastRenderedIndex = Math.min(options.count - 1, lastVisibleIndex + options.overscan);
                return Array.from({ length: lastRenderedIndex - firstRenderedIndex + 1 }, (_, offset) => {
                  const index = firstRenderedIndex + offset;
                  return { index, start: index * gridItemSize, key: options.getItemKey(index) };
                });
              },
              getTotalSize: () => options.count * gridItemSize,
              scrollToIndex: (index, { align } = {}) => {
                scrollCalls.push(index);
                const start = index * gridItemSize;
                const end = start + gridItemSize;
                if (align === "auto") {
                  if (start < gridScrollOffset) gridScrollOffset = start;
                  else if (end > gridScrollOffset + gridViewportWidth) gridScrollOffset = end - gridViewportWidth;
                }
                gridScrollOffset = Math.max(0, Math.min(
                  gridScrollOffset,
                  Math.max(0, options.count * gridItemSize - gridViewportWidth),
                ));
              },
              scrollToOffset: (offset) => {
                scrollOffsetCalls.push(offset);
                gridScrollOffset = Math.max(0, Math.min(
                  offset,
                  Math.max(0, options.count * gridItemSize - gridViewportWidth),
                ));
              },
            };
          },
        };
      }
      if (request === "lucide-react") {
        return new Proxy({}, { get: (_target, name) => {
          const Icon = () => null;
          Object.defineProperty(Icon, "name", { value: String(name) });
          return Icon;
        } });
      }
      if (request === "./SettingsPage") return { __esModule: true, default: () => null };
      return originalLoad.call(this, request, parent, isMain);
    };
    const appModule = new Module(appPath);
    appModule.filename = appPath;
    appModule.paths = Module._nodeModulePaths(path.dirname(appPath));
    appModule._compile(compiledApp, appPath);
    global.window = window;
    global.document = document;
    const App = appModule.exports.default;
    return {
      App,
      render,
      document,
      window,
      listeners,
      scrollCalls,
      scrollOffsetCalls,
      copyCalls,
      pendingCopies,
      visibleItemIds(items) {
        const firstVisibleIndex = Math.floor(gridScrollOffset / gridItemSize);
        const lastVisibleIndex = Math.min(
          items.length - 1,
          Math.floor((gridScrollOffset + gridViewportWidth - 1) / gridItemSize),
        );
        return items.slice(firstVisibleIndex, lastVisibleIndex + 1).map((entry) => entry.id);
      },
      get gridScrollOffset() { return gridScrollOffset; },
      renderApp: () => render(App),
      get panelShown() { return panelShown; },
      get hiddenCount() { return hiddenCount; },
    };
  } finally {
    Module._load = originalLoad;
  }
}

function findNode(root, predicate) {
  if (!root || typeof root !== "object") return null;
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if ("type" in root && predicate(root)) return root;
  return findNode(root.props?.children, predicate);
}

function textContent(root) {
  if (typeof root === "string" || typeof root === "number") return String(root);
  if (Array.isArray(root)) return root.map(textContent).join("");
  return root?.props ? textContent(root.props.children) : "";
}

function attachSearch(harness, tree) {
  const input = findNode(tree, (element) => element.props?.["aria-label"] === "搜索剪切板历史");
  assert.ok(input, "search input is rendered");
  const ref = input.props.ref;
  if (ref) {
    if (!ref.current || ref.current.tagName !== "INPUT") {
      ref.current = {
        tagName: "INPUT",
        focus() { harness.document.activeElement = this; },
      };
    }
  }
  return input;
}

function mountGrid(harness, tree) {
  const grid = findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid");
  assert.ok(grid, "history grid is rendered");
  return harness.render(grid.type, grid.props, grid.props.ref);
}

function findCard(harness, tree, itemId) {
  const gridTree = mountGrid(harness, tree);
  return findNode(gridTree, (element) => element.type?.name === "HistoryCard" && element.props.item.id === itemId);
}

function keyEvent(key, options = {}) {
  return {
    key,
    repeat: options.repeat ?? false,
    isComposing: options.isComposing ?? false,
    ctrlKey: false,
    metaKey: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

function dispatchKey(harness, event) {
  const listener = harness.listeners.get("keydown");
  assert.ok(listener, "global key listener is registered");
  listener(event);
  return event;
}

async function startApp(history) {
  const harness = makeHarness(history);
  harness.renderApp();
  await Promise.resolve();
  await Promise.resolve();
  let tree = harness.renderApp();
  attachSearch(harness, tree);
  harness.panelShown?.("wake-request", "generation-1");
  tree = harness.renderApp();
  attachSearch(harness, tree);
  return { harness, tree };
}

function item(id, createdAt = 1, type = "text") {
  return {
    id,
    type,
    content: `content-${id}`,
    preview: `content-${id}`,
    byteSize: 10,
    createdAt,
    pinned: false,
    tags: [],
  };
}

test("search Down enters result navigation; Enter executes the selected item once", async () => {
  const { harness, tree: initialTree } = await startApp([item("first"), item("second", 2)]);
  const search = attachSearch(harness, initialTree);
  mountGrid(harness, initialTree);
  harness.document.activeElement = search.props.ref.current;

  const firstDown = dispatchKey(harness, keyEvent("ArrowDown"));
  assert.equal(firstDown.prevented, true);
  let tree = harness.renderApp();
  attachSearch(harness, tree);
  assert.equal(findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid").props.selectedId, "first");

  const secondDown = dispatchKey(harness, keyEvent("ArrowDown"));
  assert.equal(secondDown.prevented, true);
  tree = harness.renderApp();
  attachSearch(harness, tree);
  assert.equal(findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid").props.selectedId, "second");
  assert.ok(harness.scrollCalls.includes(0));
  assert.ok(harness.scrollCalls.includes(1));

  const left = dispatchKey(harness, keyEvent("ArrowLeft"));
  assert.equal(left.prevented, false, "left arrow keeps native input caret behavior");
  const enter = dispatchKey(harness, keyEvent("Enter"));
  assert.equal(enter.prevented, true);
  assert.equal(harness.copyCalls.length, 1);
  assert.equal(harness.copyCalls[0][0], "second");
  harness.pendingCopies[0].resolve({ status: "copied_only" });
});

test("IME, repeat Enter, and an in-flight copy cannot start duplicate work or hide the panel", async () => {
  const { harness, tree } = await startApp([item("first")]);
  const search = attachSearch(harness, tree);
  harness.document.activeElement = search.props.ref.current;
  search.props.onCompositionStart();

  const composingEnter = dispatchKey(harness, keyEvent("Enter"));
  const composingEscape = dispatchKey(harness, keyEvent("Escape"));
  assert.equal(composingEnter.prevented, false);
  assert.equal(composingEscape.prevented, false);
  assert.equal(harness.copyCalls.length, 0);
  assert.equal(harness.hiddenCount, 0);

  search.props.onCompositionEnd();
  const repeatedEnter = dispatchKey(harness, keyEvent("Enter", { repeat: true }));
  assert.equal(repeatedEnter.prevented, true);
  assert.equal(harness.copyCalls.length, 0);

  dispatchKey(harness, keyEvent("Enter"));
  dispatchKey(harness, keyEvent("Enter"));
  assert.equal(harness.copyCalls.length, 1, "a busy generation accepts only one active copy intent");
  harness.pendingCopies[0].resolve({ status: "copied_only" });
});

test("single card click selects and executes; delayed old-generation ACK cannot release a newer job", async () => {
  const { harness, tree: initialTree } = await startApp([item("first"), item("second", 2)]);
  const cardElement = findCard(harness, initialTree, "second");
  const card = harness.render(cardElement.type, cardElement.props, undefined, "second");
  const article = findNode(card, (element) => element.type === "article");
  assert.ok(article);
  assert.equal(article.props.onDoubleClick, undefined, "there is no extra double-click execution handler");

  article.props.onClick();
  assert.equal(harness.copyCalls.length, 1);
  assert.equal(harness.copyCalls[0][0], "second");
  article.props.onClick();
  assert.equal(harness.copyCalls.length, 1, "the active job blocks a duplicate click while busy");

  let tree = harness.renderApp();
  attachSearch(harness, tree);
  assert.equal(findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid").props.selectedId, "second");

  harness.panelShown?.("wake-request-2", "generation-2");
  tree = harness.renderApp();
  const search = attachSearch(harness, tree);
  harness.document.activeElement = search.props.ref.current;
  dispatchKey(harness, keyEvent("Enter"));
  assert.equal(harness.copyCalls.length, 2);

  harness.pendingCopies[0].resolve({ status: "copied_only" });
  await Promise.resolve();
  await Promise.resolve();
  tree = harness.renderApp();
  assert.equal(findNode(tree, (element) => element.props?.className === "toast"), null, "generation 1 ACK does not show a notice in generation 2");
  dispatchKey(harness, keyEvent("Enter"));
  assert.equal(harness.copyCalls.length, 2, "generation 1 finally handler does not release generation 2 busy state");

  harness.pendingCopies[1].resolve({ status: "copied_only" });
  await Promise.resolve();
  await Promise.resolve();
  tree = harness.renderApp();
  const toast = findNode(tree, (element) => element.props?.className === "toast");
  assert.match(textContent(toast), /已复制，请手动粘贴/);
});

test("image preparation status stays visible for delayed IPC and clears on completion", async () => {
  const { harness, tree: initialTree } = await startApp([item("image-1", 1, "image")]);
  const search = attachSearch(harness, initialTree);
  harness.document.activeElement = search.props.ref.current;

  dispatchKey(harness, keyEvent("Enter"));
  let tree = harness.renderApp();
  let status = findNode(tree, (element) => element.props?.role === "status");
  assert.match(textContent(status), /正在准备图片/);
  assert.equal(harness.copyCalls.length, 1, "the renderer waits on a fake delayed IPC response");

  harness.pendingCopies[0].resolve({ status: "copied_only" });
  await Promise.resolve();
  await Promise.resolve();
  tree = harness.renderApp();
  status = findNode(tree, (element) => element.props?.role === "status");
  assert.equal(status, null, "preparing status disappears when the matching IPC promise completes");
  const resultNotice = findNode(tree, (element) => element.props?.className === "toast");
  assert.match(textContent(resultNotice), /已复制，请手动粘贴/);

  dispatchKey(harness, keyEvent("Enter"));
  tree = harness.renderApp();
  status = findNode(tree, (element) => element.props?.role === "status");
  assert.match(textContent(status), /正在准备图片/);
  harness.panelShown?.("wake-request-2", "generation-2");
  tree = harness.renderApp();
  assert.equal(findNode(tree, (element) => element.props?.role === "status"), null, "a new panel generation clears the old preparation status");

  harness.pendingCopies[1].resolve({ status: "blocked" });
  await Promise.resolve();
  await Promise.resolve();
  tree = harness.renderApp();
  const afterStaleImageAck = findNode(tree, (element) => element.props?.className === "toast");
  assert.match(textContent(afterStaleImageAck), /已复制，请手动粘贴/, "the stale image result cannot replace the new generation notice");
});

test("a changed query resets selection to its first result even when the old selection still matches", async () => {
  const results = Array.from({ length: 6 }, (_, index) => item(`match-${index + 1}`, index + 1));
  const { harness, tree: initialTree } = await startApp(results);
  let search = attachSearch(harness, initialTree);
  mountGrid(harness, initialTree);
  harness.document.activeElement = search.props.ref.current;

  let tree = initialTree;
  for (let index = 0; index < results.length; index += 1) {
    dispatchKey(harness, keyEvent("ArrowDown"));
    tree = harness.renderApp();
    search = attachSearch(harness, tree);
  }
  const oldGrid = findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid");
  assert.equal(oldGrid.props.selectedId, "match-6");
  assert.equal(harness.visibleItemIds(oldGrid.props.items)[0], "match-6", "the prior selection has been scrolled into the simulated viewport");
  assert.equal(harness.gridScrollOffset, 5 * 219);

  search.props.onChange({ target: { value: "content" } });
  tree = harness.renderApp();
  const grid = findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid");
  assert.deepEqual(grid.props.items.map((entry) => entry.id), results.map((entry) => entry.id));
  assert.equal(grid.props.selectedId, "match-1");
  assert.deepEqual(harness.visibleItemIds(grid.props.items), ["match-1"], "the first result is inside the simulated viewport after search changes");
  assert.equal(harness.gridScrollOffset, 0, "query-change effect aligns the result list at its start");
  assert.ok(harness.scrollOffsetCalls.includes(0), "query-change effect asks the grid virtualizer to scroll to offset zero");
  const visibleGrid = mountGrid(harness, tree);
  const firstCard = findNode(visibleGrid, (element) => element.type?.name === "HistoryCard" && element.props.item.id === "match-1");
  assert.ok(firstCard, "the first result is rendered in the visible card set");
  assert.equal(firstCard.props.selected, true, "the first visible result carries selected state");
});

test("empty queries skip body reads and image search continues to use preview", async () => {
  let textBodyReads = 0;
  let imageContentReads = 0;
  const firstText = {
    id: "text-one", type: "text", preview: "ordinary one", byteSize: 8, createdAt: 1, pinned: false, tags: [],
    get content() { textBodyReads += 1; return "ordinary text one"; },
  };
  const secondText = {
    id: "text-two", type: "text", preview: "ordinary two", byteSize: 8, createdAt: 2, pinned: false, tags: [],
    get content() { textBodyReads += 1; return "ordinary text two"; },
  };
  const image = {
    id: "image-preview", type: "image", preview: "needle in image preview", byteSize: 8, createdAt: 3, pinned: false, tags: [],
    get content() { imageContentReads += 1; return "unused-image-data"; },
  };

  const { harness, tree: initialTree } = await startApp([firstText, secondText, image]);
  assert.equal(textBodyReads, 0, "empty query does not inspect text bodies");
  assert.equal(imageContentReads, 0, "empty query does not inspect image content");

  const search = attachSearch(harness, initialTree);
  search.props.onChange({ target: { value: "needle" } });
  const tree = harness.renderApp();
  const grid = findNode(tree, (element) => element.type?.displayName === "VirtualHistoryGrid");
  assert.deepEqual(grid.props.items.map((entry) => entry.id), ["image-preview"]);
  assert.equal(imageContentReads, 0, "image filtering reads preview rather than image content");
  assert.ok(textBodyReads > 0, "non-empty text search checks text bodies");
});
