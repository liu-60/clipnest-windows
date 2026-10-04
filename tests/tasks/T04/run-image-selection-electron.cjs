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
    const releasedCutoffResponseCaptured = deferred();
    const releasedCutoffDecodeRejected = deferred();
    const releasedCutoffWorkerExited = deferred();
    const releaseCutoffWorkerResponse = deferred();
    const heldWorkerResponses = new Map([
      [3, { name: "cancel", captured: cancellationResponseCaptured, rejected: cancellationDecodeRejected, exited: cancellationWorkerExited }],
      [4, { name: "timeout", captured: timeoutResponseCaptured, rejected: timeoutDecodeRejected, exited: timeoutWorkerExited }],
      [5, { name: "held-cutoff", captured: heldCutoffResponseCaptured, rejected: heldCutoffDecodeRejected, exited: heldCutoffWorkerExited }],
      [6, { name: "released-cutoff", captured: releasedCutoffResponseCaptured, rejected: releasedCutoffDecodeRejected, exited: releasedCutoffWorkerExited, release: releaseCutoffWorkerResponse }],
    ]);
    let realWorkerDecodeCount = 0;
    let context;
    let visible = true;
    let keyStateReleased = true;
    let keyStateReadCount = 0;
    let helperRegisterCount = 0;
    let nextIdentity = 0;
    let helperExited = false;
    let monitorMode = "production";
    const selectionMonitors = [];
    const selectionMonitorDiagnostics = [];
    const monitorEvidence = {
      scheduler: "production default setTimeout on Electron main event loop",
      monotonicClock: "same node:perf_hooks performance.now source for VM and bridge ticks",
    };
    const bridge = {
      getMonotonicTickMs: () => Math.floor(performance.now()),
      getClipboardSequenceNumber: () => 41,
      getProcessIdentity(pid) { return { pid, processCreatedAt: "2200" }; },
      getForegroundWindow: () => HOST,
      allowSetForegroundWindow: (pid) => pid === 22,
      areKeysReleased: () => { keyStateReadCount += 1; return keyStateReleased; },
    };

    const imagePreparationService = new ImagePreparationService({
      workerFactory: () => {
        const realWorker = createUtilityProcessImageWorker();
        return {
          async decode(input, signal) {
            const decodeIndex = ++realWorkerDecodeCount;
            events.push(`worker-decode-start-${decodeIndex}`);
            const heldResponse = heldWorkerResponses.get(decodeIndex);
            const originalOnMessage = heldResponse ? realWorker.onMessage : null;
            if (heldResponse) {
              assert.equal(typeof originalOnMessage, "function", "the integration gate wraps the real worker response handler");
              realWorker.onMessage = (raw) => {
                if (raw && raw.requestId === input.jobId) {
                  events.push(`worker-response-held-${heldResponse.name}`);
                  heldResponse.captured.resolve({ requestId: raw.requestId, type: raw.type });
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
              child.once("exit", () => {
                events.push(`worker-process-exit-${heldResponse.name}`);
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
              else heldResponse?.rejected.resolve(error);
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
      if (monitorMode === "pending") {
        return {
          cutoff: new Promise(() => {}),
          waitForPreparation: async () => ({ kind: "continue", operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS }),
          cancel() {},
        };
      }
      // Use the production default setTimeout scheduler and the same monotonic
      // performance clock that copySelectedItem captured at selection start.
      const diagnostic = {
        deadlineAt: input.selectionDeadlineAt,
        deadlineTickMs: input.selectionDeadlineTickMs,
        keySamples: [],
      };
      selectionMonitorDiagnostics.push(diagnostic);
      const monitor = startSelectionKeyReleaseMonitor({
        ...input,
        keysReleased: () => {
          const released = input.keysReleased();
          diagnostic.keySamples.push({ at: performance.now(), tickMs: Math.floor(performance.now()), released });
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
      performance,
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
      assert.equal(cancellationReply.requestId, "image-3");
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
      assert.equal(history[2], cancellationItem);
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

      keyStateReleased = true;
      // Cancellation retired the previous process, so leave room for a cold
      // utilityProcess startup before the test-only deadline begins to win.
      context.IMAGE_LIMITS = Object.freeze({ ...IMAGE_LIMITS, contentPrepareTimeoutMs: 8_000 });
      // Keep the existing 8000ms image-service timeout scenario isolated from
      // the 500ms monitor; the production default timer is exercised below by
      // the dedicated held/released cutoff integrations.
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

      phase = "wait for real worker response held for preparation timeout";
      const timeoutReply = await waitWithin(
        timeoutResponseCaptured.promise,
        5_000,
        "the real utilityProcess must reply before the preparation timeout expires",
      );
      assert.equal(timeoutReply.requestId, "image-4");
      assert.equal(timeoutReply.type, "decoded", "timeout gates a successful response emitted by the real decoder");
      assert.equal(selectionSettled, false, "the production selection remains pending with a real worker response gated");
      phase = "wait for production image preparation timeout";
      assert.deepEqual(await waitWithin(timedOutSelection, 12_000, "the production selection timeout must settle"), {
        status: "blocked",
        reasonCode: "image_prepare_timeout",
      });
      const timeoutError = await waitWithin(
        timeoutDecodeRejected.promise,
        2_000,
        "the real worker request must reject after the service deadline expires",
      );
      assert.equal(timeoutError.message, "image_prepare_timeout");
      await waitWithin(timeoutWorkerExited.promise, 5_000, "the timed-out real utilityProcess must be retired and exit");
      assert.equal(requests.length, requestsBeforeTimeout, "timeout before snapshot completion never registers content with the helper");
      assert.deepEqual(effects, effectsBeforeTimeout, "preparation timeout has no clipboard, paste, fallback, or panel effects");
      assert.equal(visible, true, "timed-out selection leaves the panel visible");
      assert.equal(timeoutItem.content, timeoutContent);
      assert.equal(timeoutItem.preview, timeoutPreview);
      assert.equal(history[3], timeoutItem);
      assert.equal(imagePreparationService.getCacheStats().entries, 1, "timed-out decode creates no cache entry");
      assert.equal(imagePreparationService.getCacheStats().bytes, 8);
      assert.ok(events.includes("worker-response-held-timeout"));
      assert.ok(events.includes("worker-process-exit-timeout"));
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      assert.equal(selectionSettled, true);
      monitorMode = "production";

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
        "the real utilityProcess must emit its decoded response before the fake key cutoff",
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
        .filter((sample) => sample.at < heldCutoffDiagnostic.deadlineAt && sample.tickMs < heldCutoffDiagnostic.deadlineTickMs)
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

      const releasedCutoffPixels = Buffer.from([70, 180, 15, 255, 10, 30, 225, 192]);
      const releasedCutoffPng = PNG.sync.write({ width: 2, height: 1, data: releasedCutoffPixels });
      const releasedCutoffItem = {
        id: "worker-integration-released-cutoff-image",
        type: "image",
        content: `data:image/png;base64,${releasedCutoffPng.toString("base64")}`,
        preview: "截止时已松开按键的图片预览",
      };
      const releasedCutoffContent = releasedCutoffItem.content;
      history.push(releasedCutoffItem);
      keyStateReleased = true;
      helperExited = false;
      visible = true;
      context.panelGeneration = GENERATION;
      context.panelTarget = TARGET;
      context.pendingPanelGeneration = null;
      context.openingGuardUntil = 0;
      const requestsBeforeReleasedCutoff = requests.length;
      const effectsBeforeReleasedCutoff = { ...effects };
      selectionSettled = false;
      const releasedCutoffStartedAt = performance.now();
      const releasedCutoffSelection = context.copySelectedItem(7, true, releasedCutoffItem.id, [], GENERATION, "image-released-cutoff")
        .then((result) => { selectionSettled = true; return plain(result); });

      phase = "wait for real worker response held at the released-key cutoff";
      const releasedCutoffReply = await waitWithin(
        releasedCutoffResponseCaptured.promise,
        5_000,
        "the real utilityProcess must emit its decoded response before the released-key cutoff",
      );
      assert.equal(releasedCutoffReply.requestId, "image-6");
      assert.equal(releasedCutoffReply.type, "decoded");
      assert.equal(selectionSettled, false, "released-at-cutoff starts with production image preparation pending");
      assert.equal(requests.length, requestsBeforeReleasedCutoff, "no helper registration occurs before gated preparation completes");
      const releasedCutoffMonitor = selectionMonitors.at(-1);
      const releasedCutoffDiagnostic = selectionMonitorDiagnostics.at(-1);
      const releasedCutoffDecision = await waitWithin(
        releasedCutoffMonitor.cutoff,
        1_500,
        "the production default scheduler must reach its real 500ms released-key cutoff",
      );
      const releasedCutoffElapsedMs = performance.now() - releasedCutoffStartedAt;
      assert.ok(releasedCutoffElapsedMs >= SELECTION_KEY_RELEASE_WINDOW_MS - 10, "released cutoff elapsed against the real monotonic clock");
      monitorEvidence.releasedCutoffElapsedMs = Math.round(releasedCutoffElapsedMs * 100) / 100;
      const releasedSample = [...releasedCutoffDiagnostic.keySamples]
        .filter((sample) => sample.at < releasedCutoffDiagnostic.deadlineAt && sample.tickMs < releasedCutoffDiagnostic.deadlineTickMs)
        .at(-1);
      monitorEvidence.releasedCutoffTimerLateAtMs = Math.round((performance.now() - releasedCutoffDiagnostic.deadlineAt) * 100) / 100;
      monitorEvidence.releasedCutoffLastPreCutoffSampleAgeMs = releasedSample
        ? Math.round((releasedCutoffDiagnostic.deadlineAt - releasedSample.at) * 100) / 100
        : null;
      monitorEvidence.releasedCutoffLastPreCutoffSampleAgeTickMs = releasedSample
        ? releasedCutoffDiagnostic.deadlineTickMs - releasedSample.tickMs
        : null;
      monitorEvidence.releasedCutoffDecision = releasedCutoffDecision;
      assert.ok(
        (releasedCutoffDecision.kind === "continue" && releasedCutoffDecision.operationBudgetMs === SELECTION_KEY_RELEASE_WINDOW_MS) ||
        (releasedCutoffDecision.kind === "blocked" && releasedCutoffDecision.reasonCode === "key_state_unavailable"),
        "a late production timer must fail closed; otherwise a released key continues",
      );
      let zeroBudgetCommit = null;
      if (releasedCutoffDecision.kind === "continue") {
        assert.equal(selectionSettled, false, "released-at-cutoff keeps waiting for the gated image preparation");
        assert.equal(requests.length, requestsBeforeReleasedCutoff, "the helper is untouched while released preparation remains pending");
        assert.deepEqual(effects, effectsBeforeReleasedCutoff);
        assert.ok(!events.includes("worker-decode-failed-released-cutoff"), "the released cutoff does not abort the pending worker response");
        assert.ok(!events.includes("worker-process-exit-released-cutoff"), "the released cutoff keeps the worker alive");

        releaseCutoffWorkerResponse.resolve();
        phase = "wait for released-cutoff preparation and continuation";
        assert.deepEqual(await waitWithin(releasedCutoffSelection, 5_000, "released-at-cutoff selection must continue after preparation"), {
          status: "input_submitted",
        });
        assert.equal(selectionSettled, true);
        assert.equal(imagePreparationService.getCacheStats().entries, 2, "released preparation completes and admits its decoded cache entry");
        assert.equal(imagePreparationService.getCacheStats().bytes, 16);
        assert.equal(releasedCutoffItem.content, releasedCutoffContent);
        assert.deepEqual(requests.slice(requestsBeforeReleasedCutoff).map((request) => request.kind), [
          "register_content", "prepare", "commit_write", "paste",
        ]);
        zeroBudgetCommit = requests.slice(requestsBeforeReleasedCutoff).find((request) => request.kind === "commit_write");
        assert.equal(zeroBudgetCommit.selectionBudgetMs, 0, "main passes zero after preparation completes at the original cutoff");
        assert.equal("selectionDeadlineTickMs" in zeroBudgetCommit, false, "an expired cutoff does not restart its absolute deadline");
        assert.equal(requests.slice(requestsBeforeReleasedCutoff).some((request) => request.kind === "cancel"), false,
          "released-at-cutoff continuation does not invoke helper cancellation");
        assert.deepEqual({
          clipboardCommits: effects.clipboardCommits - effectsBeforeReleasedCutoff.clipboardCommits,
          pasteRequests: effects.pasteRequests - effectsBeforeReleasedCutoff.pasteRequests,
          fallbackWrites: effects.fallbackWrites - effectsBeforeReleasedCutoff.fallbackWrites,
          panelHides: effects.panelHides - effectsBeforeReleasedCutoff.panelHides,
        }, { clipboardCommits: 1, pasteRequests: 1, fallbackWrites: 0, panelHides: 1 },
        "only fake protocol/window boundaries acknowledge the eventual continuation");
        assert.ok(events.includes("worker-response-released-released-cutoff"));
        assert.ok(!events.includes("worker-decode-failed-released-cutoff"));
      } else {
        phase = "wait for real-timer late-cutoff fail-closed cancellation";
        assert.deepEqual(await waitWithin(releasedCutoffSelection, 2_000, "late released cutoff must fail closed"), {
          status: "blocked",
          reasonCode: "key_state_unavailable",
        });
        const releasedCutoffError = await waitWithin(
          releasedCutoffDecodeRejected.promise,
          2_000,
          "late released cutoff must abort its pending real worker request",
        );
        assert.equal(releasedCutoffError.message, "image_cancelled");
        await waitWithin(releasedCutoffWorkerExited.promise, 5_000, "late released cutoff must retire its utilityProcess");
        assert.equal(requests.length, requestsBeforeReleasedCutoff, "late cutoff fails closed before helper registration");
        assert.deepEqual(effects, effectsBeforeReleasedCutoff);
        assert.equal(imagePreparationService.getCacheStats().entries, 1);
        assert.equal(imagePreparationService.getCacheStats().bytes, 8);
        assert.equal(releasedCutoffItem.content, releasedCutoffContent);
      }
      monitorEvidence.releasedCutoffContinued = releasedCutoffDecision.kind === "continue";
      const keyReadsAfterReleasedCompletion = keyStateReadCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(keyStateReadCount, keyReadsAfterReleasedCompletion, "terminal completion leaves no real selection-monitor poll scheduled");
      monitorEvidence.keyReadsAfterReleasedCompletionWait = keyStateReadCount - keyReadsAfterReleasedCompletion;
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      process.stdout.write(`${JSON.stringify({
        result: monitorEvidence.releasedCutoffContinued ? "PASS" : "PASS_WITH_LIMITATIONS",
        platform: `${process.platform}-${process.arch}`,
        electron: process.versions.electron,
        electronProcessType: process.type,
        utilityProcessDecodeCount: realWorkerDecodeCount,
        productionMonitor: monitorEvidence,
        releasedCutoffSelectionBudgetMs: zeroBudgetCommit?.selectionBudgetMs ?? null,
        helperClipboardPanelAndInputBoundaries: "faked",
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
      })}\n`);
    } finally {
      releasePreparationResponse.resolve();
      await selection.catch(() => undefined);
      await imagePreparationService.dispose();
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
