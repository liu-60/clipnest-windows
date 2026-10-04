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
    let realWorkerDecodeCount = 0;
    let context;
    let visible = true;
    let nextIdentity = 0;
    let helperExited = false;
    const clockOrigin = performance.now();
    const bridge = {
      getMonotonicTickMs: () => Math.floor(10_000 + performance.now() - clockOrigin),
      getClipboardSequenceNumber: () => 41,
      getProcessIdentity(pid) { return { pid, processCreatedAt: "2200" }; },
      getForegroundWindow: () => HOST,
      allowSetForegroundWindow: (pid) => pid === 22,
      areKeysReleased: () => true,
    };

    const imagePreparationService = new ImagePreparationService({
      workerFactory: () => {
        const realWorker = createUtilityProcessImageWorker();
        return {
          async decode(input, signal) {
            realWorkerDecodeCount += 1;
            events.push("worker-decode-start");
            let decoded;
            try {
              decoded = await realWorker.decode(input, signal);
            } catch (error) {
              events.push("worker-decode-failed");
              if (realWorkerDecodeCount === 1) realWorkerDecodeFinished.reject(error);
              else realWorkerDecodeFailure.resolve(error);
              throw error;
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
          assert.equal(command.contentType, "image");
          assert.equal(command.totalBytes, 48);
          assert.ok(command.inlineBase64, "the small production DIB should use the inline helper payload");
          const dib = Buffer.from(command.inlineBase64, "base64");
          assert.equal(dib.readUInt32LE(0), 40);
          assert.equal(dib.readInt32LE(4), 2);
          assert.equal(dib.readInt32LE(8), -1, "the DIB retains the original one-row image dimensions");
          assert.deepEqual([...dib.subarray(40)], [137, 147, 247, 255, 240, 100, 5, 255]);
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

    const selectionMonitor = {
      cutoff: new Promise(() => {}),
      waitForPreparation: async () => ({ kind: "continue", operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS }),
      cancel() { events.push("selection-monitor-cancelled"); },
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
      startSelectionKeyReleaseMonitor: () => selectionMonitor,
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
      process.stdout.write("PASS: production image selection/provider path covered real utilityProcess success and decode failure; helper, clipboard, panel, and input boundaries were faked\n");
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
