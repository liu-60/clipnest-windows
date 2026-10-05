// Production image selection/provider path with a real Electron utility worker.
// It creates no BrowserWindow and never reads/writes the OS clipboard or sends input.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    cwd: path.resolve(__dirname, "../../.."), env, stdio: "inherit", timeout: 30_000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require("electron");
  const { PNG } = require("pngjs");
  const { NativeContentProvider } = require("../../../dist-electron/main/native/content-provider.js");
  const { createWin32HostBridge } = require("../../../dist-electron/main/native/win32-host-bridge.js");
  const {
    IMAGE_LIMITS,
    ImagePreparationService,
    inspectImageSource,
  } = require("../../../dist-electron/main/clipboard/image-preparation.js");
  const { createUtilityProcessImageWorker } = require("../../../dist-electron/main/clipboard/image-worker.js");
  const { HostAuthorizationGate, captureClipboardBaseline } = require("../../../dist-electron/main/native/host-authorization.js");
  const {
    raceSelectionPreparation,
    selectionHelperDeadlineAtCommit,
    startSelectionKeyReleaseMonitor,
    SELECTION_KEY_RELEASE_WINDOW_MS,
  } = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");

  const HOST = Object.freeze({ hwnd: "100", pid: 11, processCreatedAt: "1100" });
  const TARGET = Object.freeze({ hwnd: "200", pid: 33, processCreatedAt: "3300" });
  const GENERATION = "image-worker-integration";

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
  }

  async function waitWithin(promise, milliseconds, message) {
    const timeout = deferred();
    const timer = setTimeout(() => timeout.resolve({ timedOut: true }), milliseconds);
    try {
      const result = await Promise.race([
        promise.then((value) => ({ timedOut: false, value })),
        timeout.promise,
      ]);
      assert.equal(result.timedOut, false, message);
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function extractProductionFunctions() {
    const mainPath = path.resolve(__dirname, "../../../src/main/main.ts");
    const source = fs.readFileSync(mainPath, "utf8");
    const parsed = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true);
    const names = [
      "decodeNativeClipboardImage",
      "makeNativePasteJob",
      "isCurrentNativePasteJob",
      "sendNativeContent",
      "parseNativeTriggerKeys",
      "resultForNativeStatus",
      "finishSelectionMetrics",
      "cancelNativePasteJob",
      "copySelectedItem",
    ];
    const declarations = names.map((name) => {
      const declaration = parsed.statements.find((node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(declaration, `production function ${name} must exist`);
      return declaration.getText(parsed);
    });
    return ts.transpileModule(declarations.join("\n\n"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  let phase = "initialize";

  async function run() {
    assert.equal(BrowserWindow.getAllWindows().length, 0, "the integration probe must not create a BrowserWindow");
    const nativeClock = createWin32HostBridge();
    const sourcePixels = Buffer.from([240, 40, 20, 128, 5, 100, 240, 255]);
    const pngBytes = PNG.sync.write({ width: 2, height: 1, data: sourcePixels });
    const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
    const item = { id: "worker-integration-image", type: "image", content: dataUrl, preview: "原始图片预览" };
    const history = [item];
    const originalContent = item.content;
    const originalPreview = item.preview;
    const events = [];
    const requests = [];
    const effects = { clipboardCommits: 0, pasteRequests: 0, fallbackWrites: 0, panelHides: 0 };
    const realWorkerDecodeFinished = deferred();
    const realWorkerDecodeFailure = deferred();
    const releasePreparationResponse = deferred();
    const cancellationResponseCaptured = deferred();
    const cancellationDecodeRejected = deferred();
    const cancellationWorkerExited = deferred();
    const timeoutResponseCaptured = deferred();
    const timeoutDecodeRejected = deferred();
    const timeoutWorkerExited = deferred();
    const heldCutoffResponseCaptured = deferred();
    const heldCutoffDecodeRejected = deferred();
    const heldCutoffWorkerExited = deferred();
    const heldWorkerResponses = new Map([
      [3, { name: "timeout", captured: timeoutResponseCaptured, rejected: timeoutDecodeRejected, exited: timeoutWorkerExited }],
      [4, { name: "cancel", captured: cancellationResponseCaptured, rejected: cancellationDecodeRejected, exited: cancellationWorkerExited }],
      [5, { name: "held-cutoff", captured: heldCutoffResponseCaptured, rejected: heldCutoffDecodeRejected, exited: heldCutoffWorkerExited }],
    ]);
    let realWorkerDecodeCount = 0;
    let realWorkerFactoryCount = 0;
    let context;
    let visible = true;
    let keyStateReleased = true;
    let keyStateReadCount = 0;
    let helperRegisterCount = 0;
    let nextIdentity = 0;
    let helperExited = false;
    let monitorMode = "production";
    let vmPerformanceNowOverride = null;
    let vmMonotonicTickOverride = null;
    const selectionMonitors = [];
    const selectionMonitorDiagnostics = [];
    const monitorEvidence = {
      scheduler: "production default setTimeout on Electron main event loop",
      monotonicClock: "production Win32HostBridge GetTickCount64 for helper deadline; node:perf_hooks performance.now for the monitor cutoff and sample ages",
    };
    const bridge = {
      getMonotonicTickMs: () => vmMonotonicTickOverride ?? nativeClock.getMonotonicTickMs(),
      getClipboardSequenceNumber: () => 41,
      getProcessIdentity(pid) { return { pid, processCreatedAt: "2200" }; },
      getForegroundWindow: () => HOST,
      allowSetForegroundWindow: (pid) => pid === 22,
      areKeysReleased: () => { keyStateReadCount += 1; return keyStateReleased; },
    };

    const imagePreparationService = new ImagePreparationService({
      workerFactory: () => {
        const workerInstance = ++realWorkerFactoryCount;
        events.push(`worker-factory-${workerInstance}`);
        const realWorker = createUtilityProcessImageWorker();
        return {
          async decode(input, signal) {
            const decodeIndex = ++realWorkerDecodeCount;
            events.push(`worker-decode-start-${decodeIndex}`);
            const heldResponse = heldWorkerResponses.get(decodeIndex);
            const originalOnMessage = heldResponse ? realWorker.onMessage : null;
            if (heldResponse) {
              heldResponse.workerInstance = workerInstance;
              assert.equal(typeof originalOnMessage, "function", "the integration gate wraps the real worker response handler");
              realWorker.onMessage = (raw) => {
                if (raw && raw.requestId === input.jobId) {
                  events.push(`worker-response-held-${heldResponse.name}`);
                  heldResponse.responseObservedAtMs = performance.now();
                  heldResponse.captured.resolve({ requestId: raw.requestId, type: raw.type, observedAtMs: heldResponse.responseObservedAtMs });
                  if (heldResponse.release) {
                    heldResponse.release.promise.then(() => {
                      events.push(`worker-response-released-${heldResponse.name}`);
                      originalOnMessage.call(realWorker, raw);
                    });
                  }
                  return;
                }
                originalOnMessage.call(realWorker, raw);
              };
            }
            const decodePromise = realWorker.decode(input, signal);
            if (heldResponse) {
              const child = realWorker.child;
              assert.ok(child, "a real Electron utilityProcess must exist before the held response is observed");
              heldResponse.child = child;
              heldResponse.utilityProcessPid = child.pid;
              child.once("exit", () => {
                events.push(`worker-process-exit-${heldResponse.name}`);
                heldResponse.exitObservedAtMs = performance.now();
                heldResponse.exited.resolve();
              });
            }
            let decoded;
            try {
              decoded = await decodePromise;
            } catch (error) {
              events.push("worker-decode-failed", `worker-decode-failed-${heldResponse?.name ?? decodeIndex}`);
              if (decodeIndex === 1) realWorkerDecodeFinished.reject(error);
              else if (decodeIndex === 2) realWorkerDecodeFailure.resolve(error);
              else if (heldResponse) {
                heldResponse.rejectionObservedAtMs = performance.now();
                heldResponse.rejected.resolve(error);
              }
              throw error;
            } finally {
              if (originalOnMessage) realWorker.onMessage = originalOnMessage;
            }
            events.push("worker-decode-finished");
            realWorkerDecodeFinished.resolve();
            // Hold only the response delivery so a setImmediate can prove the
            // Electron main event loop remains live while selection is pending.
            await releasePreparationResponse.promise;
            return decoded;
          },
          dispose: () => realWorker.dispose(),
        };
      },
    });

    const provider = new NativeContentProvider({
      lookupCurrentItem: (itemRef) => history.find((candidate) => candidate.id === itemRef),
      isTrustedSender: (senderId) => senderId === 7,
      decodeImage: (url, bytes) => {
        events.push("provider-decode-start");
        return context.decodeNativeClipboardImage(url, bytes);
      },
    });

    const client = {
      state: "ready",
      currentPanelGeneration: GENERATION,
      acceptedHelperGeneration: GENERATION,
      get hasExited() { return helperExited; },
      async request(command, generation) {
        assert.equal(generation, GENERATION);
        requests.push(command);
        events.push(`helper-${command.kind}`);
        if (command.kind === "register_content") {
          helperRegisterCount += 1;
          assert.equal(command.contentType, "image");
          assert.equal(command.totalBytes, 48);
          assert.ok(command.inlineBase64, "the small production DIB should use the inline helper payload");
          const dib = Buffer.from(command.inlineBase64, "base64");
          assert.equal(dib.readUInt32LE(0), 40);
          assert.equal(dib.readInt32LE(4), 2);
          assert.equal(dib.readInt32LE(8), -1, "the DIB retains the original one-row image dimensions");
          assert.equal(dib.length, 48);
          if (helperRegisterCount === 1) {
            assert.deepEqual([...dib.subarray(40)], [137, 147, 247, 255, 240, 100, 5, 255]);
          }
          assert.equal(command.totalHash, createHash("sha256").update(dib).digest("hex"));
          return { status: "content_registered", jobId: command.jobId };
        }
        if (command.kind === "prepare") {
          return { status: "prepared", jobId: command.jobId, prepareToken: "prepare-image-test" };
        }
        if (command.kind === "commit_write") {
          if (monitorMode === "deterministicZeroBudget") {
            assert.equal(command.selectionBudgetMs, 0);
            assert.equal("selectionDeadlineTickMs" in command, false);
            // This fake terminal signal lets production finally release its
            // snapshot. It is not evidence about native helper lifecycle.
            helperExited = true;
            return { status: "blocked", reasonCode: "key_state_unavailable", jobId: command.jobId };
          }
          effects.clipboardCommits += 1;
          return { status: "clipboard_written", jobId: command.jobId, clipboardSequence: "42" };
        }
        if (command.kind === "paste") {
          effects.pasteRequests += 1;
          helperExited = true;
          return { status: "input_submitted", jobId: command.jobId, target: command.target };
        }
        throw new Error(`unexpected fake helper command: ${command.kind}`);
      },
    };

    const startIntegratedSelectionMonitor = (input) => {
      const diagnostic = {
        selectionStartedAtMs: input.selectionDeadlineAt - SELECTION_KEY_RELEASE_WINDOW_MS,
        selectionDeadlineAt: input.selectionDeadlineAt,
        selectionDeadlineTickMs: input.selectionDeadlineTickMs,
        deadlineAt: input.selectionDeadlineAt,
        deadlineTickMs: input.selectionDeadlineTickMs,
        monitorMode,
        keySamples: [],
      };
      selectionMonitorDiagnostics.push(diagnostic);
      if (monitorMode === "deterministicZeroBudget") {
        return {
          cutoff: new Promise(() => {}),
          waitForPreparation: async () => ({ kind: "continue", operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS }),
          cancel() {},
        };
      }
      if (monitorMode === "pending") {
        return {
          cutoff: new Promise(() => {}),
          waitForPreparation: async () => ({ kind: "continue", operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS }),
          cancel() {},
        };
      }
      // Use the production default setTimeout scheduler and the same monotonic
      // performance clock that copySelectedItem captured at selection start.
      const monitor = startSelectionKeyReleaseMonitor({
        ...input,
        keysReleased: () => {
          const released = input.keysReleased();
          diagnostic.keySamples.push({ at: performance.now(), tickMs: nativeClock.getMonotonicTickMs(), released });
          return released;
        },
      });
      selectionMonitors.push(monitor);
      return monitor;
    };
    context = vm.createContext({
      Error,
      AbortController,
      Buffer,
      Uint8Array,
      setTimeout,
      clearTimeout,
      clearInterval,
      randomUUID: () => `integration-${++nextIdentity}`,
      performance: { now: () => vmPerformanceNowOverride ?? performance.now() },
      createHash,
      metrics: {
        mark: (_requestId, name) => events.push(`metric-${name}`),
        finish: (_requestId, outcome) => events.push(`finish-${outcome}`),
        flush: async () => {},
      },
      benchmarkMode: false,
      process: { argv: [] },
      history,
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
      helperReady: { status: "ready", helperPid: 22, helperProcessCreatedAt: "2200", helperInstanceId: "fake-helper" },
      hostAuthorizationGate: new HostAuthorizationGate(),
      captureClipboardBaseline,
      raceSelectionPreparation,
      selectionHelperDeadlineAtCommit,
      startSelectionKeyReleaseMonitor: startIntegratedSelectionMonitor,
      SELECTION_KEY_RELEASE_WINDOW_MS,
      IMAGE_LIMITS,
      imagePreparationService,
      inspectImageSource,
      nativeContentProvider: provider,
      getMainWindowTarget: () => HOST,
      writeItemToElectronClipboard: () => { effects.fallbackWrites += 1; },
      clipboardSequenceGate: { markProcessed: (sequence) => assert.equal(sequence, 42) },
      hidePanel() { visible = false; effects.panelHides += 1; events.push("panel-hide"); },
      showPanel: () => { visible = true; events.push("panel-show"); },
    });
    vm.runInContext(extractProductionFunctions(), context, { filename: path.resolve(__dirname, "../../../src/main/main.ts") });

    let selectionSettled = false;
    events.push("selection-start");
    const selection = context.copySelectedItem(7, true, item.id, [], GENERATION, "image-worker-integration")
      .then((result) => { selectionSettled = true; return plain(result); });
    try {
      phase = "wait for first real worker decode";
      await realWorkerDecodeFinished.promise;
      assert.equal(selectionSettled, false, "selection remains pending while the real worker result is held at the test gate");
      assert.equal(realWorkerDecodeCount, 1, "a cache miss invokes exactly one real utility worker decode");
      assert.equal(imagePreparationService.getCacheStats().entries, 0, "the cache miss was not already satisfied");
      let eventLoopAdvanced = false;
      setImmediate(() => { eventLoopAdvanced = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(eventLoopAdvanced, true, "Electron main event loop processed setImmediate during pending image preparation");
      assert.equal(selectionSettled, false);
      assert.equal(item.content, originalContent);
      assert.equal(item.preview, originalPreview);

      releasePreparationResponse.resolve();
      phase = "wait for first selection to finish";
      assert.deepEqual(await selection, { status: "input_submitted" });
      assert.equal(imagePreparationService.getCacheStats().entries, 1);
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.equal(item.content, originalContent, "selection does not replace the retained full-resolution source");
      assert.equal(item.preview, originalPreview, "selection does not replace the original preview");
      assert.equal(history[0], item);
      assert.deepEqual(requests.map((request) => request.kind), ["register_content", "prepare", "commit_write", "paste"]);
      assert.equal(effects.clipboardCommits, 1, "the fake helper recorded the protocol commit only");
      assert.equal(effects.pasteRequests, 1, "the fake helper recorded the protocol paste only");
      assert.equal(effects.fallbackWrites, 0, "Electron clipboard fallback was not used");
      assert.equal(effects.panelHides, 1, "the fake panel boundary hid after the fake helper acknowledgement");
      assert.ok(events.indexOf("worker-decode-finished") < events.indexOf("helper-register_content"));
      assert.ok(events.indexOf("helper-register_content") < events.indexOf("helper-prepare"));
      assert.ok(events.indexOf("helper-prepare") < events.indexOf("helper-commit_write"));
      assert.ok(events.indexOf("helper-commit_write") < events.indexOf("helper-paste"));
      assert.equal(BrowserWindow.getAllWindows().length, 0);

      const malformedPng = Buffer.from(pngBytes);
      malformedPng[41] ^= 0xff; // Corrupt IDAT data while preserving the PNG header and dimensions.
      const failedItem = {
        id: "worker-integration-invalid-image",
        type: "image",
        content: `data:image/png;base64,${malformedPng.toString("base64")}`,
        preview: "损坏图片原预览",
      };
      const failedItemContent = failedItem.content;
      const failedItemPreview = failedItem.preview;
      history.push(failedItem);
      helperExited = false;
      visible = true;
      context.panelGeneration = GENERATION;
      context.panelTarget = TARGET;
      context.pendingPanelGeneration = null;
      context.openingGuardUntil = 0;
      const requestsBeforeFailure = requests.length;
      const effectsBeforeFailure = { ...effects };
      selectionSettled = false;
      const failedSelection = context.copySelectedItem(7, true, failedItem.id, [], GENERATION, "image-worker-failure")
        .then((result) => { selectionSettled = true; return plain(result); });

      phase = "wait for real worker failure";
      const failureReachedWorker = await Promise.race([
        realWorkerDecodeFailure.promise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      const earlyFailureResult = failureReachedWorker ? null : await failedSelection;
      assert.equal(failureReachedWorker, true,
        `malformed image must reach the real worker; decodeCount=${realWorkerDecodeCount}, settled=${selectionSettled}, result=${JSON.stringify(earlyFailureResult)}, events=${events.join(",")}`);
      phase = "wait for fail-closed selection result";
      assert.deepEqual(await failedSelection, { status: "blocked", reasonCode: "image_png_crc_invalid" });
      assert.equal(realWorkerDecodeCount, 2, "the malformed image reaches the same real utility worker");
      assert.equal(requests.length, requestsBeforeFailure, "worker failure occurs before helper registration");
      assert.deepEqual(effects, effectsBeforeFailure, "worker failure causes no clipboard, paste, fallback, or panel side effects");
      assert.equal(visible, true, "the failed selection leaves the panel visible");
      assert.equal(failedItem.content, failedItemContent, "the malformed retained content is not replaced");
      assert.equal(failedItem.preview, failedItemPreview, "the retained preview is not replaced");
      assert.equal(history[1], failedItem);
      assert.equal(imagePreparationService.getCacheStats().entries, 1, "failed decode creates no additional cache entry");
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.ok(events.includes("worker-decode-failed"));
      assert.equal(selectionSettled, true);

      keyStateReleased = true;
      // This production 3000ms absolute timeout runs before cancellation retires
      // the already-warm worker. The pending monitor isolates this deadline from
      // the separately measured 500ms key-release cutoff.
      assert.equal(IMAGE_LIMITS.contentPrepareTimeoutMs, 3_000,
        "the image timeout probe must use the production 3000ms deadline without an override");
      monitorMode = "pending";
      const timeoutPixels = Buffer.from([90, 10, 230, 255, 5, 210, 70, 255]);
      const timeoutPng = PNG.sync.write({ width: 2, height: 1, data: timeoutPixels });
      const timeoutItem = {
        id: "worker-integration-timeout-image",
        type: "image",
        content: `data:image/png;base64,${timeoutPng.toString("base64")}`,
        preview: "超时时保留的图片预览",
      };
      const timeoutContent = timeoutItem.content;
      const timeoutPreview = timeoutItem.preview;
      history.push(timeoutItem);
      helperExited = false;
      visible = true;
      context.panelGeneration = GENERATION;
      context.panelTarget = TARGET;
      context.pendingPanelGeneration = null;
      context.openingGuardUntil = 0;
      const requestsBeforeTimeout = requests.length;
      const effectsBeforeTimeout = { ...effects };
      selectionSettled = false;
      const timedOutSelection = context.copySelectedItem(7, true, timeoutItem.id, [], GENERATION, "image-worker-timeout")
        .then((result) => { selectionSettled = true; return plain(result); });
      const timeoutDiagnostic = selectionMonitorDiagnostics.at(-1);
      assert.ok(timeoutDiagnostic, "the production selection start timestamp is captured from its key deadline");
      const timeoutSelectionStartedAtMs = timeoutDiagnostic.selectionStartedAtMs;
      const timeoutAbsoluteDeadlineAtMs = timeoutSelectionStartedAtMs + IMAGE_LIMITS.contentPrepareTimeoutMs;
      assert.equal(timeoutDiagnostic.selectionDeadlineAt - timeoutSelectionStartedAtMs, SELECTION_KEY_RELEASE_WINDOW_MS,
        "selection start is derived from the production monitor deadline created in copySelectedItem");

      phase = "wait for real worker response held for preparation timeout";
      const timeoutReply = await waitWithin(
        timeoutResponseCaptured.promise,
        5_000,
        "the real utilityProcess must reply before the preparation timeout expires",
      );
      assert.equal(timeoutReply.requestId, "image-3");
      assert.equal(timeoutReply.type, "decoded", "timeout gates a successful response emitted by the real decoder");
      assert.equal(selectionSettled, false, "the production selection remains pending with a real worker response gated");
      const timeoutWorker = heldWorkerResponses.get(3);
      assert.equal(timeoutWorker.workerInstance, 1, "timeout uses the utility worker warmed by the successful and malformed-image scenarios");
      assert.equal(realWorkerFactoryCount, 1, "no cold worker was created for the timeout scenario");
      assert.ok(Number.isSafeInteger(timeoutWorker.utilityProcessPid) && timeoutWorker.utilityProcessPid > 0,
        "timeout gate records the real warm utilityProcess PID");
      assert.ok(timeoutReply.observedAtMs < timeoutAbsoluteDeadlineAtMs,
        "the real decoder emitted its successful response before the selection's absolute 3000ms deadline");
      phase = "wait for production image preparation timeout";
      const timeoutResult = await waitWithin(timedOutSelection, 7_000, "the production selection timeout must settle");
      const timeoutSelectionSettledAtMs = performance.now();
      const timeoutSelectionElapsedMs = timeoutSelectionSettledAtMs - timeoutSelectionStartedAtMs;
      assert.deepEqual(timeoutResult, {
        status: "blocked",
        reasonCode: "image_prepare_timeout",
      });
      assert.ok(timeoutSelectionElapsedMs >= IMAGE_LIMITS.contentPrepareTimeoutMs - 100,
        `selection timeout must wait for its production absolute deadline; elapsed=${timeoutSelectionElapsedMs.toFixed(2)}ms`);
      assert.ok(timeoutSelectionElapsedMs < 6_000,
        `selection timeout must remain near the production 3000ms deadline; elapsed=${timeoutSelectionElapsedMs.toFixed(2)}ms`);
      assert.ok(timeoutSelectionSettledAtMs - timeoutReply.observedAtMs >= 2_500,
        "the already-decoded real response remains gated for the production timeout interval");
      const timeoutError = await waitWithin(
        timeoutDecodeRejected.promise,
        2_000,
        "the real worker request must reject after the service deadline expires",
      );
      assert.equal(timeoutError.message, "image_prepare_timeout");
      await waitWithin(timeoutWorkerExited.promise, 5_000, "the timed-out real utilityProcess must be retired and exit");
      assert.ok(timeoutWorker.rejectionObservedAtMs >= timeoutAbsoluteDeadlineAtMs - 100,
        "the real worker request is aborted only when the production absolute deadline expires");
      assert.ok(timeoutWorker.exitObservedAtMs >= timeoutSelectionStartedAtMs + IMAGE_LIMITS.contentPrepareTimeoutMs - 100,
        "the real utilityProcess exit follows expiration of the production preparation deadline");
      assert.equal(requests.length, requestsBeforeTimeout, "timeout before snapshot completion never registers content with the helper");
      assert.deepEqual(effects, effectsBeforeTimeout, "preparation timeout has no clipboard, paste, fallback, or panel effects");
      assert.equal(visible, true, "timed-out selection leaves the panel visible");
      assert.equal(timeoutItem.content, timeoutContent);
      assert.equal(timeoutItem.preview, timeoutPreview);
      assert.equal(history[2], timeoutItem);
      assert.equal(imagePreparationService.getCacheStats().entries, 1, "timed-out decode creates no cache entry");
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.ok(events.includes("worker-response-held-timeout"));
      assert.ok(events.includes("worker-process-exit-timeout"));
      assert.ok(!events.includes("worker-response-released-timeout"), "the harness gate never delivers the decoded response after timeout");
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      assert.equal(selectionSettled, true);
      monitorEvidence.productionImagePreparationTimeout = {
        configuredDeadlineMs: IMAGE_LIMITS.contentPrepareTimeoutMs,
        deadlineAnchor: "copySelectedItem selectionStartedAt; timestamp derived from the production selectionDeadlineAt minus its 500ms key-release window",
        selectionStartedAtMs: Math.round(timeoutSelectionStartedAtMs * 100) / 100,
        absoluteDeadlineAtMs: Math.round(timeoutAbsoluteDeadlineAtMs * 100) / 100,
        workerFactoryCount: realWorkerFactoryCount,
        workerInstance: timeoutWorker.workerInstance,
        realUtilityProcessPid: timeoutWorker.utilityProcessPid,
        decodedResponseType: timeoutReply.type,
        decodedResponseElapsedMs: Math.round((timeoutReply.observedAtMs - timeoutSelectionStartedAtMs) * 100) / 100,
        selectionSettledElapsedMs: Math.round(timeoutSelectionElapsedMs * 100) / 100,
        responseGateHeldMs: Math.round((timeoutSelectionSettledAtMs - timeoutReply.observedAtMs) * 100) / 100,
        workerAbortElapsedMs: Math.round((timeoutWorker.rejectionObservedAtMs - timeoutSelectionStartedAtMs) * 100) / 100,
        workerExitElapsedMs: Math.round((timeoutWorker.exitObservedAtMs - timeoutSelectionStartedAtMs) * 100) / 100,
        selectionResult: timeoutResult,
        workerDecodeRejection: timeoutError.message,
        realUtilityProcessExitObserved: true,
        helperRequestsAdded: requests.length - requestsBeforeTimeout,
        clipboardPasteFallbackAndPanelEffectsAdded: Object.fromEntries(
          Object.keys(effects).map((key) => [key, effects[key] - effectsBeforeTimeout[key]]),
        ),
        retainedOriginalAndPreviewUnchanged: timeoutItem.content === timeoutContent && timeoutItem.preview === timeoutPreview,
        decodedCacheEntriesAfterScenario: imagePreparationService.getCacheStats().entries,
        responseReleasedAfterTimeout: events.includes("worker-response-released-timeout"),
        monitorIsolation: "test-only pending cutoff stub; production 500ms key monitor is measured in separate scenarios",
      };
      monitorMode = "production";
      keyStateReleased = false;
      const cancellationPixels = Buffer.from([20, 80, 160, 255, 170, 60, 30, 128]);
      const cancellationPng = PNG.sync.write({ width: 2, height: 1, data: cancellationPixels });
      const cancellationItem = {
        id: "worker-integration-cancelled-image",
        type: "image",
        content: `data:image/png;base64,${cancellationPng.toString("base64")}`,
        preview: "取消时保留的图片预览",
      };
      const cancellationContent = cancellationItem.content;
      const cancellationPreview = cancellationItem.preview;
      history.push(cancellationItem);
      const requestsBeforeCancellation = requests.length;
      const effectsBeforeCancellation = { ...effects };
      selectionSettled = false;
      const cancelledSelection = context.copySelectedItem(7, true, cancellationItem.id, [], GENERATION, "image-worker-cancel")
        .then((result) => { selectionSettled = true; return plain(result); });

      phase = "wait for real worker response held for selection cancellation";
      const cancellationReply = await waitWithin(
        cancellationResponseCaptured.promise,
        5_000,
        "the real utilityProcess must reply before the cancellation gate is released",
      );
      assert.equal(cancellationReply.requestId, "image-4");
      assert.equal(cancellationReply.type, "decoded", "cancellation gates a successful response emitted by the real decoder");
      assert.equal(selectionSettled, false, "the production selection remains pending while its real worker response is gated");
      const cancellationMonitor = selectionMonitors.at(-1);
      assert.ok(cancellationMonitor, "the production key-release monitor must be installed for the selection");
      const keyReadsBeforePoll = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(keyStateReadCount > keyReadsBeforePoll, "the production default timer performs a real event-loop key-state poll");
      monitorEvidence.cancellationPollReads = keyStateReadCount - keyReadsBeforePoll;
      const jobToCancel = context.nativePasteJob;
      const cancellationQuiescent = context.cancelNativePasteJob(jobToCancel);
      phase = "wait for production selection cancellation";
      const cancellationResult = await cancelledSelection;
      assert.deepEqual(cancellationResult, { status: "cancelled", reasonCode: "selection_cancelled" },
        `cancellation must win the preparation race; events=${events.join(",")}`);
      assert.equal(await waitWithin(cancellationQuiescent, 2_000, "production cancellation cleanup must settle"), true);
      assert.deepEqual(await waitWithin(cancellationMonitor.cutoff, 100, "cancellation must settle the production monitor"), {
        kind: "blocked",
        reasonCode: "selection_cancelled",
      });
      const cancellationError = await waitWithin(
        cancellationDecodeRejected.promise,
        2_000,
        "the real worker request must reject after production cancellation",
      );
      assert.equal(cancellationError.message, "image_cancelled");
      await waitWithin(cancellationWorkerExited.promise, 5_000, "the cancelled real utilityProcess must exit");
      assert.equal(requests.length, requestsBeforeCancellation, "cancellation before snapshot completion never registers content with the helper");
      assert.deepEqual(effects, effectsBeforeCancellation, "selection cancellation has no clipboard, paste, fallback, or panel effects");
      assert.equal(visible, true, "cancelled selection leaves the panel visible");
      assert.equal(cancellationItem.content, cancellationContent);
      assert.equal(cancellationItem.preview, cancellationPreview);
      assert.equal(history[3], cancellationItem);
      assert.equal(imagePreparationService.getCacheStats().entries, 1, "cancelled decode creates no cache entry");
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.ok(events.includes("worker-response-held-cancel"));
      assert.ok(events.includes("worker-process-exit-cancel"));
      const keyReadsAfterCancellation = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(keyStateReadCount, keyReadsAfterCancellation, "production cancellation clears the real polling timer");
      monitorEvidence.keyReadsAfterCancellationWait = keyStateReadCount - keyReadsAfterCancellation;
      assert.equal(context.nativePasteJob, null, "quiescent pre-registration cancellation retires the selection job");
      assert.equal(BrowserWindow.getAllWindows().length, 0);


      const heldCutoffPixels = Buffer.from([30, 130, 210, 255, 220, 70, 10, 255]);
      const heldCutoffPng = PNG.sync.write({ width: 2, height: 1, data: heldCutoffPixels });
      const heldCutoffItem = {
        id: "worker-integration-held-cutoff-image",
        type: "image",
        content: `data:image/png;base64,${heldCutoffPng.toString("base64")}`,
        preview: "截止时仍按住按键的图片预览",
      };
      const heldCutoffContent = heldCutoffItem.content;
      history.push(heldCutoffItem);
      keyStateReleased = false;
      helperExited = false;
      visible = true;
      context.panelGeneration = GENERATION;
      context.panelTarget = TARGET;
      context.pendingPanelGeneration = null;
      context.openingGuardUntil = 0;
      const requestsBeforeHeldCutoff = requests.length;
      const registerCountBeforeHeldCutoff = helperRegisterCount;
      const effectsBeforeHeldCutoff = { ...effects };
      selectionSettled = false;
      const heldCutoffStartedAt = performance.now();
      const heldCutoffSelection = context.copySelectedItem(7, true, heldCutoffItem.id, [], GENERATION, "image-held-cutoff")
        .then((result) => { selectionSettled = true; return plain(result); });

      phase = "wait for real worker response held at the key cutoff";
      const heldCutoffReply = await waitWithin(
        heldCutoffResponseCaptured.promise,
        5_000,
        `the real utilityProcess must emit its decoded response before the fake key cutoff; decodeCount=${realWorkerDecodeCount}, factories=${realWorkerFactoryCount}, workerEvents=${events.filter((event) => event.includes("worker-")).join(",")}`,
      );
      assert.equal(heldCutoffReply.requestId, "image-5");
      assert.equal(heldCutoffReply.type, "decoded");
      assert.equal(selectionSettled, false, "held-at-cutoff starts with production image preparation pending");
      assert.equal(requests.length, requestsBeforeHeldCutoff, "no helper registration occurs while snapshot preparation is pending");
      const heldCutoffMonitor = selectionMonitors.at(-1);
      const heldCutoffDiagnostic = selectionMonitorDiagnostics.at(-1);
      const heldCutoffDecision = await waitWithin(
        heldCutoffMonitor.cutoff,
        1_500,
        "the production default scheduler must reach its real 500ms held-key cutoff",
      );
      const heldCutoffElapsedMs = performance.now() - heldCutoffStartedAt;
      assert.ok(heldCutoffElapsedMs >= SELECTION_KEY_RELEASE_WINDOW_MS - 10, "held cutoff elapsed against the real monotonic clock");
      monitorEvidence.heldCutoffElapsedMs = Math.round(heldCutoffElapsedMs * 100) / 100;
      const heldSample = [...heldCutoffDiagnostic.keySamples]
        .filter((sample) => sample.at < heldCutoffDiagnostic.deadlineAt)
        .at(-1);
      monitorEvidence.heldCutoffTimerLateAtMs = Math.round((performance.now() - heldCutoffDiagnostic.deadlineAt) * 100) / 100;
      monitorEvidence.heldCutoffLastPreCutoffSampleAgeMs = heldSample
        ? Math.round((heldCutoffDiagnostic.deadlineAt - heldSample.at) * 100) / 100
        : null;
      monitorEvidence.heldCutoffLastPreCutoffSampleAgeTickMs = heldSample
        ? heldCutoffDiagnostic.deadlineTickMs - heldSample.tickMs
        : null;
      assert.equal(heldCutoffDecision.kind, "blocked");
      assert.ok(["key_held", "key_state_unavailable"].includes(heldCutoffDecision.reasonCode));
      monitorEvidence.heldCutoffDecision = heldCutoffDecision;
      phase = "wait for held-key cutoff cancellation and utilityProcess retirement";
      assert.deepEqual(await waitWithin(heldCutoffSelection, 2_000, "held-at-cutoff selection must settle"), {
        status: "blocked",
        reasonCode: heldCutoffDecision.reasonCode,
      });
      const heldCutoffError = await waitWithin(
        heldCutoffDecodeRejected.promise,
        2_000,
        "held-at-cutoff must abort the pending real worker request",
      );
      assert.equal(heldCutoffError.message, "image_cancelled");
      await waitWithin(heldCutoffWorkerExited.promise, 5_000, "held-at-cutoff must retire the real utilityProcess");
      const keyReadsAfterHeldCutoff = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(keyStateReadCount, keyReadsAfterHeldCutoff, "the held terminal cutoff leaves no real polling timer");
      assert.equal(requests.length, requestsBeforeHeldCutoff, "held-at-cutoff never registers content with the helper");
      assert.equal(helperRegisterCount, registerCountBeforeHeldCutoff);
      assert.deepEqual(effects, effectsBeforeHeldCutoff, "held-at-cutoff has no clipboard, paste, fallback or panel effects");
      assert.equal(heldCutoffItem.content, heldCutoffContent);
      assert.equal(visible, true);
      assert.equal(imagePreparationService.getCacheStats().entries, 1);
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.ok(events.includes("worker-response-held-held-cutoff"));
      assert.ok(events.includes("worker-process-exit-held-cutoff"));

      keyStateReleased = true;
      const MAX_RELEASED_CUTOFF_ATTEMPTS = 12;
      const releasedCutoffAttempts = [];
      let successfulReleasedCutoffAttempt = null;
      for (let attemptNumber = 1; attemptNumber <= MAX_RELEASED_CUTOFF_ATTEMPTS; attemptNumber += 1) {
        const decodeIndex = realWorkerDecodeCount + 1;
        const attemptName = `released-cutoff-${attemptNumber}`;
        const attemptWorker = {
          name: attemptName,
          captured: deferred(),
          rejected: deferred(),
          exited: deferred(),
          release: deferred(),
        };
        heldWorkerResponses.set(decodeIndex, attemptWorker);

        // Vary synthetic pixels so each retry is a cache miss and reaches a
        // fresh real utilityProcess decode after a fail-closed attempt retires.
        const attemptPixels = Buffer.from([
          70 + attemptNumber, 180, 15, 255,
          10, 30 + attemptNumber, 225, 192,
        ]);
        const attemptPng = PNG.sync.write({ width: 2, height: 1, data: attemptPixels });
        const releasedCutoffItem = {
          id: `worker-integration-${attemptName}-image`,
          type: "image",
          content: `data:image/png;base64,${attemptPng.toString("base64")}`,
          preview: `截止时已松开按键的合成图片 ${attemptNumber}`,
        };
        const releasedCutoffContent = releasedCutoffItem.content;
        const releasedCutoffPreview = releasedCutoffItem.preview;
        history.push(releasedCutoffItem);
        helperExited = false;
        visible = true;
        context.panelGeneration = GENERATION;
        context.panelTarget = TARGET;
        context.pendingPanelGeneration = null;
        context.openingGuardUntil = 0;
        const requestsBeforeAttempt = requests.length;
        const effectsBeforeAttempt = { ...effects };
        selectionSettled = false;
        const releasedCutoffStartedAt = performance.now();
        const releasedCutoffSelection = context.copySelectedItem(
          7,
          true,
          releasedCutoffItem.id,
          [],
          GENERATION,
          `image-released-cutoff-${attemptNumber}`,
        ).then((result) => { selectionSettled = true; return plain(result); });

        phase = `wait for real utilityProcess response on released cutoff attempt ${attemptNumber}`;
        const releasedCutoffReply = await waitWithin(
          attemptWorker.captured.promise,
          5_000,
          `attempt ${attemptNumber}: real utilityProcess must decode before the released-key cutoff`,
        );
        assert.equal(releasedCutoffReply.requestId, `image-${decodeIndex}`);
        assert.equal(releasedCutoffReply.type, "decoded");
        assert.equal(selectionSettled, false, "released-at-cutoff preparation remains pending at the response gate");
        assert.equal(requests.length, requestsBeforeAttempt, "no helper request occurs before gated preparation completes");

        const releasedCutoffMonitor = selectionMonitors.at(-1);
        const releasedCutoffDiagnostic = selectionMonitorDiagnostics.at(-1);
        const releasedCutoffDecision = await waitWithin(
          releasedCutoffMonitor.cutoff,
          1_500,
          `attempt ${attemptNumber}: production default scheduler must reach the real 500ms cutoff`,
        );
        const decisionObservedAtMs = performance.now();
        const releasedCutoffElapsedMs = decisionObservedAtMs - releasedCutoffStartedAt;
        const releasedCutoffTimerLateAtMs = decisionObservedAtMs - releasedCutoffDiagnostic.deadlineAt;
        assert.ok(releasedCutoffElapsedMs >= SELECTION_KEY_RELEASE_WINDOW_MS - 10,
          "released cutoff elapsed against the real monotonic clock");
        const releasedSample = [...releasedCutoffDiagnostic.keySamples]
          .filter((sample) => sample.at < releasedCutoffDiagnostic.deadlineAt)
          .at(-1);
        const releasedCutoffLastPreCutoffSampleAgeMs = releasedSample
          ? releasedCutoffDiagnostic.deadlineAt - releasedSample.at
          : null;
        const releasedCutoffLastPreCutoffSampleAgeTickMs = releasedSample
          ? releasedCutoffDiagnostic.deadlineTickMs - releasedSample.tickMs
          : null;
        const attemptEvidence = {
          attempt: attemptNumber,
          decodeIndex,
          decision: releasedCutoffDecision,
          cutoffElapsedMs: Math.round(releasedCutoffElapsedMs * 100) / 100,
          timerLateAtMs: Math.round(releasedCutoffTimerLateAtMs * 100) / 100,
          lastPreCutoffSampleAgeMs: releasedCutoffLastPreCutoffSampleAgeMs === null
            ? null
            : Math.round(releasedCutoffLastPreCutoffSampleAgeMs * 100) / 100,
          lastPreCutoffSampleAgeTickMs: releasedCutoffLastPreCutoffSampleAgeTickMs,
        };
        assert.ok(
          (releasedCutoffDecision.kind === "continue" && releasedCutoffDecision.operationBudgetMs === SELECTION_KEY_RELEASE_WINDOW_MS) ||
          (releasedCutoffDecision.kind === "blocked" && releasedCutoffDecision.reasonCode === "key_state_unavailable"),
          `attempt ${attemptNumber}: released adapter must continue within tolerance or fail closed as unavailable`,
        );

        // A cutoff decision alone must not touch helper/clipboard/panel/input
        // boundaries while the decoded worker response is still withheld.
        assert.equal(selectionSettled, false, "selection remains pending until this attempt's worker response is released");
        assert.equal(requests.length, requestsBeforeAttempt, "no commit, cancel, or other helper request occurs while worker is pending");
        assert.deepEqual(effects, effectsBeforeAttempt, "no fake clipboard, paste, fallback, or panel effect occurs while worker is pending");
        assert.ok(!events.includes(`worker-process-exit-${attemptName}`), "the utilityProcess remains live while preparation is pending");

        if (releasedCutoffDecision.kind === "continue") {
          assert.ok(releasedCutoffTimerLateAtMs >= 0 && releasedCutoffTimerLateAtMs <= 5,
            `attempt ${attemptNumber}: continuation must be observed within the fixed 5ms cutoff tolerance; late=${releasedCutoffTimerLateAtMs.toFixed(2)}ms`);
          assert.ok(releasedCutoffLastPreCutoffSampleAgeMs !== null && releasedCutoffLastPreCutoffSampleAgeMs >= 0 && releasedCutoffLastPreCutoffSampleAgeMs <= 5,
            `attempt ${attemptNumber}: continuing sample must be no older than 5ms; age=${releasedCutoffLastPreCutoffSampleAgeMs}`);
          assert.ok(!events.includes(`worker-decode-failed-${attemptName}`), "released cutoff must not cancel the pending worker");

          attemptWorker.release.resolve();
          phase = `wait for production zero-budget commit on released cutoff attempt ${attemptNumber}`;
          assert.deepEqual(await waitWithin(releasedCutoffSelection, 5_000,
            `attempt ${attemptNumber}: released-at-cutoff selection must continue after worker completion`), {
            status: "input_submitted",
          });
          assert.equal(selectionSettled, true);
          assert.equal(releasedCutoffItem.content, releasedCutoffContent, "the retained synthetic original remains unchanged");
          assert.equal(releasedCutoffItem.preview, releasedCutoffPreview);
          const attemptRequests = requests.slice(requestsBeforeAttempt);
          assert.deepEqual(attemptRequests.map((request) => request.kind), [
            "register_content", "prepare", "commit_write", "paste",
          ]);
          const zeroBudgetCommit = attemptRequests.find((request) => request.kind === "commit_write");
          assert.equal(zeroBudgetCommit.selectionBudgetMs, 0,
            "production main orchestration sends check-only zero budget after the original cutoff");
          assert.equal("selectionDeadlineTickMs" in zeroBudgetCommit, false,
            "production main orchestration omits the expired absolute helper deadline");
          assert.equal(attemptRequests.some((request) => request.kind === "cancel"), false,
            "released cutoff does not send helper cancellation");
          assert.deepEqual({
            clipboardCommits: effects.clipboardCommits - effectsBeforeAttempt.clipboardCommits,
            pasteRequests: effects.pasteRequests - effectsBeforeAttempt.pasteRequests,
            fallbackWrites: effects.fallbackWrites - effectsBeforeAttempt.fallbackWrites,
            panelHides: effects.panelHides - effectsBeforeAttempt.panelHides,
          }, { clipboardCommits: 1, pasteRequests: 1, fallbackWrites: 0, panelHides: 1 },
          "only fake protocol/window boundaries acknowledge continuation");
          assert.ok(events.includes(`worker-response-released-${attemptName}`));
          assert.ok(!events.includes(`worker-decode-failed-${attemptName}`));
          attemptEvidence.status = "OBSERVED";
          attemptEvidence.commitWrite = {
            selectionBudgetMs: zeroBudgetCommit.selectionBudgetMs,
            includedSelectionDeadlineTickMs: "selectionDeadlineTickMs" in zeroBudgetCommit,
            helperKinds: attemptRequests.map((request) => request.kind),
          };
          successfulReleasedCutoffAttempt = attemptEvidence;
          releasedCutoffAttempts.push(attemptEvidence);
          break;
        }

        phase = `wait for fail-closed worker retirement on released cutoff attempt ${attemptNumber}`;
        assert.deepEqual(await waitWithin(releasedCutoffSelection, 2_000,
          `attempt ${attemptNumber}: late released cutoff must fail closed`), {
          status: "blocked",
          reasonCode: "key_state_unavailable",
        });
        const releasedCutoffError = await waitWithin(
          attemptWorker.rejected.promise,
          2_000,
          `attempt ${attemptNumber}: late cutoff must abort its pending utilityProcess request`,
        );
        assert.equal(releasedCutoffError.message, "image_cancelled");
        await waitWithin(attemptWorker.exited.promise, 5_000,
          `attempt ${attemptNumber}: late cutoff must retire the real utilityProcess`);
        assert.equal(requests.length, requestsBeforeAttempt, "late cutoff fails closed before helper registration/commit/cancel");
        assert.deepEqual(effects, effectsBeforeAttempt, "late cutoff has no clipboard, paste, fallback, or panel effects");
        assert.equal(imagePreparationService.getCacheStats().entries, 1, "blocked cutoff creates no decoded cache entry");
        assert.equal(imagePreparationService.getCacheStats().bytes, 8);
        assert.equal(releasedCutoffItem.content, releasedCutoffContent);
        assert.ok(events.includes(`worker-process-exit-${attemptName}`));
        attemptEvidence.status = "NOT_OBSERVED_LATE_FAIL_CLOSED";
        releasedCutoffAttempts.push(attemptEvidence);
        heldWorkerResponses.delete(decodeIndex);
      }

      monitorEvidence.releasedCutoffProbe = {
        status: successfulReleasedCutoffAttempt ? "OBSERVED" : "NOT_OBSERVED",
        maxAttempts: MAX_RELEASED_CUTOFF_ATTEMPTS,
        attemptsRun: releasedCutoffAttempts.length,
        fixedTimerToleranceMs: 5,
        fixedFreshSampleToleranceMs: 5,
        attempts: releasedCutoffAttempts,
        successfulAttempt: successfulReleasedCutoffAttempt,
      };
      monitorEvidence.releasedCutoffContinued = successfulReleasedCutoffAttempt !== null;
      const keyReadsAfterReleasedCompletion = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(keyStateReadCount, keyReadsAfterReleasedCompletion, "terminal completion leaves no real selection-monitor poll scheduled");
      monitorEvidence.keyReadsAfterReleasedCompletionWait = keyStateReadCount - keyReadsAfterReleasedCompletion;

      assert.equal(context.nativePasteJob, null, "the bounded real-timer attempts leave no active fake job before the deterministic integration");
      const zeroBudgetDecodeIndex = realWorkerDecodeCount + 1;
      const zeroBudgetWorker = {
        name: "deterministic-zero-budget",
        captured: deferred(),
        rejected: deferred(),
        exited: deferred(),
        release: deferred(),
      };
      heldWorkerResponses.set(zeroBudgetDecodeIndex, zeroBudgetWorker);
      const zeroBudgetPixels = Buffer.from([17, 44, 219, 255, 202, 93, 11, 128]);
      const zeroBudgetPng = PNG.sync.write({ width: 2, height: 1, data: zeroBudgetPixels });
      const zeroBudgetItem = {
        id: "worker-integration-deterministic-zero-budget-image",
        type: "image",
        content: `data:image/png;base64,${zeroBudgetPng.toString("base64")}`,
        preview: "确定性零预算原始预览",
      };
      const zeroBudgetContent = zeroBudgetItem.content;
      const zeroBudgetPreview = zeroBudgetItem.preview;
      history.push(zeroBudgetItem);
      monitorMode = "deterministicZeroBudget";
      keyStateReleased = true;
      helperExited = false;
      visible = true;
      context.panelGeneration = GENERATION;
      context.panelTarget = TARGET;
      context.pendingPanelGeneration = null;
      context.openingGuardUntil = 0;
      const requestsBeforeZeroBudget = requests.length;
      const effectsBeforeZeroBudget = { ...effects };
      const keyReadsBeforeZeroBudget = keyStateReadCount;
      selectionSettled = false;
      let zeroBudgetSelection = null;
      try {
        phase = "wait for real worker response held by deterministic zero-budget integration";
        zeroBudgetSelection = context.copySelectedItem(
          7,
          true,
          zeroBudgetItem.id,
          [],
          GENERATION,
          "image-deterministic-zero-budget",
        ).then((result) => { selectionSettled = true; return plain(result); });

        const zeroBudgetReply = await waitWithin(
          zeroBudgetWorker.captured.promise,
          5_000,
          "the real utilityProcess must decode before the deterministic zero-budget clock advance",
        );
        assert.equal(zeroBudgetReply.requestId, `image-${zeroBudgetDecodeIndex}`);
        assert.equal(zeroBudgetReply.type, "decoded");
        assert.ok(zeroBudgetWorker.child, "the production worker gate must be attached to a real Electron utilityProcess");
        assert.equal(selectionSettled, false, "production selection remains pending while the real response is held");
        assert.equal(requests.length, requestsBeforeZeroBudget, "no helper request precedes worker response release");
        assert.deepEqual(effects, effectsBeforeZeroBudget, "no side-effect boundary changes while the real response is held");

        const zeroBudgetDiagnostic = selectionMonitorDiagnostics.at(-1);
        assert.equal(zeroBudgetDiagnostic.monitorMode, "deterministicZeroBudget");
        assert.ok(zeroBudgetReply.observedAtMs > 0, "the real worker response capture records its observation time");
        vmPerformanceNowOverride = zeroBudgetDiagnostic.selectionDeadlineAt + 1;
        vmMonotonicTickOverride = zeroBudgetDiagnostic.selectionDeadlineTickMs - 1;
        assert.equal(vmPerformanceNowOverride, zeroBudgetDiagnostic.selectionDeadlineAt + 1,
          "after the real response is held, the injected high-resolution clock is one millisecond past the original cutoff");
        assert.equal(vmMonotonicTickOverride, zeroBudgetDiagnostic.selectionDeadlineTickMs - 1,
          "after the real response is held, the injected coarse tick remains one tick before the helper deadline");
        zeroBudgetWorker.release.resolve();
        phase = "wait for production zero-budget request through real utilityProcess and fake helper";
        assert.deepEqual(await waitWithin(
          zeroBudgetSelection,
          5_000,
          "the production selection must finish after the real worker response is released",
        ), { status: "blocked", reasonCode: "key_state_unavailable" });

        const zeroBudgetRequests = requests.slice(requestsBeforeZeroBudget);
        assert.deepEqual(zeroBudgetRequests.map((request) => request.kind), [
          "register_content", "prepare", "commit_write",
        ]);
        const zeroBudgetCommit = zeroBudgetRequests.at(-1);
        assert.equal(zeroBudgetCommit.selectionBudgetMs, 0);
        assert.equal("selectionDeadlineTickMs" in zeroBudgetCommit, false);
        assert.equal(zeroBudgetRequests.some((request) => request.kind === "paste" || request.kind === "cancel"), false);
        assert.deepEqual(effects, effectsBeforeZeroBudget,
          "fake blocked commit causes no clipboard, paste, fallback or panel effect");
        assert.equal(keyStateReadCount - keyReadsBeforeZeroBudget, 1,
          "only production's pre-commit check uses the fake key-state adapter; the fake monitor does not poll");
        assert.equal(visible, true, "blocked selection keeps the panel visible");
        assert.equal(zeroBudgetItem.content, zeroBudgetContent, "the retained original image is unchanged");
        assert.equal(zeroBudgetItem.preview, zeroBudgetPreview, "the retained preview is unchanged");
        assert.equal(history.at(-1), zeroBudgetItem);
        assert.equal(helperExited, true, "the fake terminal signal lets production finally release the prepared snapshot");
        assert.equal(context.nativePasteJob, null, "production finally retires the zero-budget fake job");
        assert.ok(events.includes("worker-response-released-deterministic-zero-budget"));
        assert.ok(!events.includes("worker-decode-failed-deterministic-zero-budget"));
        assert.equal(BrowserWindow.getAllWindows().length, 0);

        monitorEvidence.deterministicZeroBudgetMainWorkerIntegration = {
          status: "OBSERVED",
          mode: "fake monitor with injected VM clocks; production Electron main selection and real utilityProcess PNG decode",
          deadline: {
            highResolutionNowMs: vmPerformanceNowOverride,
            originalDeadlineAtMs: zeroBudgetDiagnostic.selectionDeadlineAt,
            helperTickMs: vmMonotonicTickOverride,
            originalHelperDeadlineTickMs: zeroBudgetDiagnostic.selectionDeadlineTickMs,
          },
          utilityProcess: {
            pid: Number.isInteger(zeroBudgetWorker.utilityProcessPid) ? zeroBudgetWorker.utilityProcessPid : null,
            pidReportedByElectron: Number.isInteger(zeroBudgetWorker.utilityProcessPid),
            decodeIndex: zeroBudgetDecodeIndex,
            responseType: zeroBudgetReply.type,
            responseObservedAtMs: zeroBudgetReply.observedAtMs,
            clockOverrideAppliedAfterResponseCapture: true,
          },
          commitWrite: {
            selectionBudgetMs: zeroBudgetCommit.selectionBudgetMs,
            includedSelectionDeadlineTickMs: "selectionDeadlineTickMs" in zeroBudgetCommit,
            helperKinds: zeroBudgetRequests.map((request) => request.kind),
          },
          fakeHelperResponse: "blocked/key_state_unavailable; harness-only terminal signal is not helper lifecycle evidence",
          fakeBoundaryEffects: {
            clipboardCommits: effects.clipboardCommits - effectsBeforeZeroBudget.clipboardCommits,
            pasteRequests: effects.pasteRequests - effectsBeforeZeroBudget.pasteRequests,
            fallbackWrites: effects.fallbackWrites - effectsBeforeZeroBudget.fallbackWrites,
            panelHides: effects.panelHides - effectsBeforeZeroBudget.panelHides,
          },
          fakeKeyStateAdapterReads: keyStateReadCount - keyReadsBeforeZeroBudget,
          originalContentAndPreviewUnchanged: zeroBudgetItem.content === zeroBudgetContent && zeroBudgetItem.preview === zeroBudgetPreview,
          browserWindowCreated: false,
          systemClipboardReadOrWritten: false,
          physicalInputSent: false,
          limitations: [
            "Does not observe a real timer cutoff, key transition, native helper lifecycle, or atomic clipboard/SendInput behavior.",
            "Does not close P1/I10/I11, P15, JPEG memory, visible paste, or T04 acceptance gates.",
          ],
        };
      } finally {
        zeroBudgetWorker.release.resolve();
        if (zeroBudgetSelection) {
          await waitWithin(
            zeroBudgetSelection.catch(() => undefined),
            5_000,
            "cleanup must settle the deterministic selection after releasing its worker gate",
          ).catch(() => undefined);
        }
      }
      const keyReadsAfterDeterministicScenario = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(keyStateReadCount, keyReadsAfterDeterministicScenario,
        "the deterministic fake monitor leaves no real key polling timer");
      monitorEvidence.keyReadsAfterDeterministicZeroBudgetWait = keyStateReadCount - keyReadsAfterDeterministicScenario;
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      const releasedCutoffProbeStatus = successfulReleasedCutoffAttempt ? "PASS_WITH_LIMITATIONS" : "PARTIAL";
      process.stdout.write(`${JSON.stringify({
        result: releasedCutoffProbeStatus,
        platform: `${process.platform}-${process.arch}`,
        electron: process.versions.electron,
        electronProcessType: process.type,
        utilityProcessDecodeCount: realWorkerDecodeCount,
        productionMonitor: monitorEvidence,
        releasedCutoffSelectionBudgetMs: successfulReleasedCutoffAttempt?.commitWrite.selectionBudgetMs ?? null,
        helperClipboardPanelAndInputBoundaries: "faked",
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
      })}\n`);
    } finally {
      releasePreparationResponse.resolve();
      await selection.catch(() => undefined);
      await imagePreparationService.dispose();
      nativeClock.close();
    }
  }

  const watchdog = setTimeout(() => {
    process.stderr.write(`image selection Electron integration timed out during ${phase}\n`);
    app.exit(1);
  }, 25_000);
  app.whenReady().then(run).then(() => {
    clearTimeout(watchdog);
    app.exit(0);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    clearTimeout(watchdog);
    app.exit(1);
  });
}
