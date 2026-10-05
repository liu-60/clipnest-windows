const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");

const { HostAuthorizationGate, captureClipboardBaseline } = require("../../../dist-electron/main/native/host-authorization.js");
const {
  raceSelectionPreparation,
  selectionHelperDeadlineAtCommit,
  startSelectionKeyReleaseMonitor,
  SELECTION_KEY_RELEASE_WINDOW_MS,
} = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");

const mainPath = path.resolve(__dirname, "../../../src/main/main.ts");
const mainSource = fs.readFileSync(mainPath, "utf8");
const parsedMain = ts.createSourceFile(mainPath, mainSource, ts.ScriptTarget.Latest, true);
const testedFunctionNames = [
  "copySelectedItem",
  "decodeNativeClipboardImage",
  "makeNativePasteJob",
  "isCurrentNativePasteJob",
  "hidePanel",
  "parseNativeTriggerKeys",
  "resultForNativeStatus",
  "finishSelectionMetrics",
];
const testedSource = testedFunctionNames.map((name) => {
  const declaration = parsedMain.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `the production ${name} function must exist`);
  return declaration.getText(parsedMain);
}).join("\n\n");
const compiledMain = ts.transpileModule(testedSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const HOST = Object.freeze({ hwnd: "100", pid: 11, processCreatedAt: "1100" });
const TARGET = Object.freeze({ hwnd: "200", pid: 33, processCreatedAt: "3300" });
const GENERATION = "image-failure-panel";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeHarness({
  itemType = "image",
  snapshotError = null,
  authorizationAllowed = true,
  helperState = "ready",
  sequenceNumber = 41,
  snapshotDelayMs = 0,
  monotonicTickValues = null,
  performanceNowMs = null,
  performanceNowValues = null,
  decodeImageDuringSnapshot = false,
} = {}) {
  const events = [];
  const effects = {
    snapshotCalls: 0,
    helperPreparationCalls: 0,
    nativeClipboardWrites: 0,
    electronFallbackWrites: 0,
    pasteRequests: 0,
    panelHides: 0,
    authorizationChecks: 0,
    cancellations: 0,
    imagePreparationCalls: 0,
    imagePreparationDeadlineAt: null,
  };
  const requests = [];
  const cancellations = [];
  const performanceNowSamples = [];
  const monotonicTickSamples = [];
  const content = itemType === "image"
    ? "data:image/png;base64,AA=="
    : "保留当前内容";
  const item = { id: "image-item", type: itemType, content, preview: "预览" };
  let visible = true;
  let context;
  let nextId = 0;
  let monotonicTickReadCount = 0;
  let performanceNowReadCount = 0;
  const elapsedMs = () => performance.now() - startedAt;
  const startedAt = performance.now();
  const bridge = {
    getMonotonicTickMs: () => {
      if (monotonicTickValues) {
        const index = Math.min(monotonicTickReadCount++, monotonicTickValues.length - 1);
        const value = monotonicTickValues[index];
        monotonicTickSamples.push(value);
        return value;
      }
      return Math.floor(10_000 + elapsedMs());
    },
    getClipboardSequenceNumber: () => sequenceNumber,
    getProcessIdentity(pid) { return { pid, processCreatedAt: "2200" }; },
    getForegroundWindow: () => HOST,
    allowSetForegroundWindow() {
      effects.authorizationChecks += 1;
      return authorizationAllowed;
    },
    areKeysReleased: () => true,
  };
  const client = {
    state: helperState,
    currentPanelGeneration: GENERATION,
    acceptedHelperGeneration: GENERATION,
    async request(command) {
      requests.push(command);
      events.push(`helper-${command.kind}`);
      if (command.kind === "cancel") {
        return { status: "cancelled", jobId: command.jobId, workerQuiescent: true };
      }
      if (command.kind === "commit_write") {
        effects.nativeClipboardWrites += 1;
        return { status: "clipboard_written", jobId: command.jobId, clipboardSequence: "42" };
      }
      assert.equal(command.kind, "paste");
      effects.pasteRequests += 1;
      return { status: "input_submitted", jobId: command.jobId, target: command.target };
    },
  };
  const monitor = {
    cutoff: new Promise(() => {}),
    waitForPreparation: async () => ({ kind: "continue", operationBudgetMs: 500 }),
    cancel() { events.push("monitor-cancelled"); },
  };
  const readPerformanceNow = () => {
    const value = performanceNowValues
      ? performanceNowValues[Math.min(performanceNowReadCount++, performanceNowValues.length - 1)]
      : performanceNowMs;
    performanceNowSamples.push(value);
    return value;
  };

  context = vm.createContext({
    Error,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    clearInterval,
    randomUUID: () => `test-${++nextId}`,
    performance: performanceNowMs === null && performanceNowValues === null
      ? performance
      : { now: readPerformanceNow },
    metrics: { mark: (_requestId, name) => events.push(`metric-${name}`), finish() {}, flush: async () => {} },
    benchmarkMode: false,
    process: { argv: [] },
    history: [item],
    mainWindow: {
      webContents: { id: 7 },
      isDestroyed: () => false,
      isVisible: () => visible,
      hide() { visible = false; effects.panelHides += 1; events.push("panel-hide"); },
    },
    panelGeneration: GENERATION,
    panelTarget: TARGET,
    pendingPanelGeneration: null,
    panelAnimationTimer: null,
    openingGuardTimer: null,
    openingGuardUntil: 0,
    nativePasteJob: null,
    helperClipboardFence: { isBlocked: false },
    win32HostBridge: bridge,
    helperClient: client,
    helperReady: { status: "ready", helperPid: 22, helperProcessCreatedAt: "2200", helperInstanceId: "helper-test" },
    hostAuthorizationGate: new HostAuthorizationGate(),
    captureClipboardBaseline,
    raceSelectionPreparation,
    selectionHelperDeadlineAtCommit,
    startSelectionKeyReleaseMonitor: () => monitor,
    SELECTION_KEY_RELEASE_WINDOW_MS,
    IMAGE_LIMITS: { contentPrepareTimeoutMs: 3_000 },
    inspectImageSource: () => ({ format: "png", width: 1, height: 1 }),
    createHash: () => ({ update() { return this; }, digest: () => "synthetic-image-sha256" }),
    imagePreparationService: {
      async prepare(_input, options) {
        effects.imagePreparationCalls += 1;
        effects.imagePreparationDeadlineAt = options.deadlineAt;
        return { image: { width: 1, height: 1, pixels: Uint8Array.of(10, 20, 30, 255) } };
      },
    },
    nativeContentProvider: {
      async snapshot() {
        effects.snapshotCalls += 1;
        events.push("snapshot");
        if (snapshotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
        if (snapshotError) throw new Error(snapshotError);
        if (decodeImageDuringSnapshot) {
          await context.decodeNativeClipboardImage(item.content, Buffer.from([1]));
        }
        return { itemRef: item.id, itemVersion: "version-1" };
      },
      isCurrent: () => true,
      release: () => events.push("snapshot-release"),
    },
    async sendNativeContent(job) {
      effects.helperPreparationCalls += 1;
      job.helperClient = client;
      job.registrationAttempted = true;
      job.registered = true;
      return { status: "prepared", jobId: job.jobId, prepareToken: "prepare-test" };
    },
    async cancelNativePasteJob(job) {
      effects.cancellations += 1;
      job.cancelled = true;
      job.imageDecodeController.abort();
      const cancellation = { jobId: job.jobId, registrationAttempted: job.registrationAttempted };
      cancellation.completion = (async () => {
        const ack = await client.request({ kind: "cancel", jobId: job.jobId }, GENERATION);
        if ((ack.status !== "cancelled" && ack.status !== "too_late") ||
            ack.jobId !== job.jobId || ack.workerQuiescent !== true) return false;
        if (job.snapshot) context.nativeContentProvider.release(job.snapshot, job.jobId, job.objectToken);
        if (context.nativePasteJob === job) context.nativePasteJob = null;
        job.cancellationQuiescent = true;
        job.resolveTerminal();
        return true;
      })();
      cancellations.push(cancellation);
      return cancellation.completion;
    },
    getMainWindowTarget: () => HOST,
    writeItemToElectronClipboard() {
      effects.electronFallbackWrites += 1;
      events.push("electron-clipboard-fallback");
    },
    clipboardSequenceGate: { markProcessed: (sequence) => assert.equal(sequence, 42) },
    resultForNativeStatus: (result) => ({ status: "blocked", reasonCode: result.reasonCode ?? result.status }),
    showPanel: () => { visible = true; events.push("panel-show"); },
  });

  vm.runInContext(compiledMain, context, { filename: mainPath });
  return {
    events,
    effects,
    item,
    requests,
    cancellations,
    clockSamples: { performanceNow: performanceNowSamples, monotonicTicks: monotonicTickSamples },
    waitForCancellations: async () => Promise.all(cancellations.map((cancellation) => cancellation.completion)),
    isVisible: () => visible,
    select: () => context.copySelectedItem(7, true, item.id, [], GENERATION, "image-failure-test"),
  };
}

test("image preparation capacity failure leaves clipboard and panel untouched", async () => {
  const harness = makeHarness({ snapshotError: "image_worker_capacity_exceeded" });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "image_worker_capacity_exceeded",
  });
  assert.equal(harness.effects.snapshotCalls, 1);
  assert.equal(harness.effects.helperPreparationCalls, 0, "failed image preparation never registers helper content");
  assert.equal(harness.effects.nativeClipboardWrites, 0, "failed preparation never reaches helper commit_write");
  assert.equal(harness.effects.electronFallbackWrites, 0, "failed preparation never bypasses the worker with Electron clipboard");
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.item.content, "data:image/png;base64,AA==", "the retained image remains available");
  assert.deepEqual(harness.requests, []);
});

test("image snapshot read failure preserves the retained source and has zero external side effects", async () => {
  const harness = makeHarness({ snapshotError: "content_item_not_found" });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "content_item_not_found",
  });
  assert.equal(harness.effects.snapshotCalls, 1);
  assert.equal(harness.effects.helperPreparationCalls, 0, "a failed snapshot never registers helper content");
  assert.equal(harness.effects.nativeClipboardWrites, 0, "a failed snapshot never reaches helper commit_write");
  assert.equal(harness.effects.electronFallbackWrites, 0, "a failed image read never uses Electron clipboard fallback");
  assert.equal(harness.effects.pasteRequests, 0, "a failed image read never sends input");
  assert.equal(harness.effects.panelHides, 0, "a failed image read leaves the panel open");
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.item.content, "data:image/png;base64,AA==", "the retained image source remains available");
  assert.equal(harness.item.preview, "预览", "the retained image preview remains available");
  assert.deepEqual(harness.requests, [], "no helper command is sent after a failed image read");
});

test("image BGRA conversion that crosses the selection deadline blocks helper registration", async () => {
  const harness = makeHarness({
    decodeImageDuringSnapshot: true,
    performanceNowValues: [0, 0, 2_999, 3_001],
  });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "image_prepare_timeout",
  });
  assert.equal(harness.effects.imagePreparationCalls, 1);
  assert.equal(harness.effects.imagePreparationDeadlineAt, 3_000,
    "image decoding receives the original selection-start deadline");
  assert.deepEqual(harness.clockSamples.performanceNow, [0, 0, 2_999, 3_001],
    "service completion is before cutoff and BGRA conversion finishes after it");
  assert.equal(harness.effects.snapshotCalls, 1);
  assert.equal(harness.effects.helperPreparationCalls, 0, "late BGRA conversion prevents helper registration");
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.deepEqual(harness.requests, []);
});

test("image snapshot work that crosses the selection deadline releases the snapshot before helper registration", async () => {
  const harness = makeHarness({
    decodeImageDuringSnapshot: true,
    performanceNowValues: [0, 0, 2_998, 2_999, 3_001],
  });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "image_prepare_timeout",
  });
  assert.equal(harness.effects.imagePreparationCalls, 1);
  assert.equal(harness.effects.imagePreparationDeadlineAt, 3_000);
  assert.deepEqual(harness.clockSamples.performanceNow, [0, 0, 2_998, 2_999, 3_001],
    "service completion and BGRA conversion finish before cutoff; later snapshot work crosses it");
  assert.equal(harness.effects.helperPreparationCalls, 0, "late snapshot completion prevents helper registration");
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.ok(harness.events.includes("snapshot-release"), "the completed but late snapshot is released");
  assert.equal(harness.isVisible(), true);
  assert.deepEqual(harness.requests, []);
});

test("image selection fails closed when the helper is unavailable before preparation", async () => {
  const harness = makeHarness({ helperState: "unavailable" });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "native_helper_unavailable",
  });
  assert.equal(harness.effects.snapshotCalls, 0);
  assert.equal(harness.effects.helperPreparationCalls, 0);
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.item.content, "data:image/png;base64,AA==");
  assert.deepEqual(harness.requests, []);
});

test("image selection fails closed when its clipboard sequence baseline is unavailable", async () => {
  const harness = makeHarness({ sequenceNumber: 0 });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "clipboard_sequence_unavailable",
  });
  assert.equal(harness.effects.snapshotCalls, 0);
  assert.equal(harness.effects.helperPreparationCalls, 0);
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.item.content, "data:image/png;base64,AA==");
  assert.deepEqual(harness.requests, []);
});

test("an expired high-resolution cutoff sends helper check-only when GetTickCount64 still lags", async () => {
  const harness = makeHarness({
    snapshotDelayMs: 510,
    monotonicTickValues: [10_496, 10_992],
  });

  await harness.select();
  const commit = harness.requests.find((request) => request.kind === "commit_write");
  assert.ok(commit, "the released selection reaches the native conditional-write gate");
  assert.equal(commit.selectionBudgetMs, 0, "an expired performance.now cutoff cannot restart a 500ms wait");
  assert.equal("selectionDeadlineTickMs" in commit, false, "the stale coarse tick is not sent as an unexpired deadline");
  assert.equal(harness.effects.pasteRequests, 1, "helper check-only retains the released-key success path");
});

test("an early coarse helper deadline fails closed and requests cancellation for the prepared job", async () => {
  const highResolutionNowMs = 1_000;
  const harness = makeHarness({
    performanceNowMs: highResolutionNowMs,
    monotonicTickValues: [10_000, 10_500],
  });

  assert.deepEqual(plain(await harness.select()), {
    status: "blocked",
    reasonCode: "selection_clock_unavailable",
  });
  const selectionStartedAtMs = harness.clockSamples.performanceNow[1];
  const helperCheckAtMs = harness.clockSamples.performanceNow.at(-1);
  assert.ok(helperCheckAtMs < selectionStartedAtMs + SELECTION_KEY_RELEASE_WINDOW_MS,
    "the actual main-orchestration helper check uses performance.now before the 500ms deadline");
  assert.deepEqual(harness.clockSamples.monotonicTicks, [10_000, 10_500],
    "the helper's coarse clock advances to the original cutoff first");
  assert.equal(harness.effects.snapshotCalls, 1, "the main route reaches the helper-deadline decision after snapshot");
  assert.equal(harness.effects.helperPreparationCalls, 1, "the job is registered and prepared before the coarse-clock check");
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.deepEqual(harness.requests.map((request) => request.kind), ["cancel"],
    "the fake helper boundary receives only cancellation, without commit_write or paste");

  assert.equal(harness.cancellations.length, 1);
  const [cancellation] = harness.cancellations;
  assert.equal(harness.requests[0].jobId, cancellation.jobId, "cancel targets the prepared job ID");
  assert.equal(cancellation.registrationAttempted, true);
  // The harness fakes helper quiescence to settle cleanup; only the cancel
  // request and main-process side effects are evidence from this VM test.
  await harness.waitForCancellations();
  assert.equal(harness.effects.cancellations, 1);
});

test("non-image preparation errors keep the existing copy-only fallback", async () => {
  const harness = makeHarness({ itemType: "text", snapshotError: "content_snapshot_unavailable" });

  assert.deepEqual(plain(await harness.select()), {
    status: "copied_only",
    reasonCode: "content_snapshot_unavailable",
  });
  assert.equal(harness.effects.electronFallbackWrites, 1);
  assert.equal(harness.effects.nativeClipboardWrites, 0);
  assert.equal(harness.effects.pasteRequests, 0);
  assert.equal(harness.effects.panelHides, 1);
  assert.equal(harness.item.content, "保留当前内容");
});

test("non-image selections keep copy-only fallback when helper or sequence is unavailable", async () => {
  for (const [options, reasonCode] of [
    [{ helperState: "unavailable" }, "native_helper_unavailable"],
    [{ sequenceNumber: 0 }, "clipboard_sequence_unavailable"],
  ]) {
    const harness = makeHarness({ itemType: "text", ...options });

    assert.deepEqual(plain(await harness.select()), { status: "copied_only", reasonCode });
    assert.equal(harness.effects.electronFallbackWrites, 1);
    assert.equal(harness.effects.nativeClipboardWrites, 0);
    assert.equal(harness.effects.pasteRequests, 0);
    assert.equal(harness.effects.panelHides, 1);
    assert.equal(harness.item.content, "保留当前内容");
    assert.deepEqual(harness.requests, []);
  }
});

test("helper authorization denial keeps the existing image copy-only degradation", async () => {
  const harness = makeHarness({ authorizationAllowed: false });

  assert.deepEqual(plain(await harness.select()), {
    status: "copied_only",
    reasonCode: "authorization_denied",
  });
  assert.equal(harness.effects.nativeClipboardWrites, 1, "the authorized copy step completed before paste authorization");
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.authorizationChecks, 1);
  assert.equal(harness.effects.pasteRequests, 0, "permission denial never sends input");
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.item.content, "data:image/png;base64,AA==", "the original image remains in history");
  assert.equal(harness.item.preview, "预览", "the original preview remains available");
});
