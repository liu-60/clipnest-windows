const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");

const { captureClipboardBaseline, HostAuthorizationGate } = require("../../../dist-electron/main/native/host-authorization.js");
const { raceSelectionPreparation, selectionHelperDeadlineAtCommit, startSelectionKeyReleaseMonitor, SELECTION_KEY_RELEASE_WINDOW_MS } = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");

const mainPath = path.resolve(__dirname, "../../../src/main/main.ts");
const mainSource = fs.readFileSync(mainPath, "utf8");
const parsedMain = ts.createSourceFile(mainPath, mainSource, ts.ScriptTarget.Latest, true);
const testedFunctionNames = [
  "copySelectedItem", "makeNativePasteJob", "isCurrentNativePasteJob", "hidePanel", "parseNativeTriggerKeys",
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
const EXTERNAL = Object.freeze({ hwnd: "300", pid: 44, processCreatedAt: "4400" });
const GENERATION = "panel-1";

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Only OS/helper/content boundaries are simulated. Selection, key polling,
// authorization, job state, and panel hiding execute the production functions.
function makeHarness(options = {}) {
  const events = [];
  const requests = [];
  const pasteStarted = deferred();
  const effects = { clipboardWrites: 0, electronFallbackWrites: 0, inputSubmissions: 0, panelHides: 0, grants: 0, cancels: 0 };
  let visible = true;
  let nextIdentity = 0;
  let keyChecks = 0;
  let context;
  const clockOriginAt = performance.now();
  const elapsedMs = () => performance.now() - clockOriginAt;

  const bridge = {
    getMonotonicTickMs: () => Math.floor(10_000 + elapsedMs()),
    getClipboardSequenceNumber: () => 41,
    getProcessIdentity(pid) {
      events.push("helper-identity");
      return { pid, processCreatedAt: "2200" };
    },
    getForegroundWindow() {
      events.push("foreground-check");
      return options.foreground ?? HOST;
    },
    allowSetForegroundWindow(pid) {
      assert.equal(pid, 22);
      events.push("authorize");
      effects.grants += 1;
      return true;
    },
    areKeysReleased() {
      keyChecks += 1;
      events.push(`key-check-${keyChecks}`);
      if (options.keyStateUnavailable) return null;
      // The production monitor now samples both at selection start and after
      // preparation. Model a late modifier at the authorization boundary,
      // independently of how often that monitor has polled the OS bridge.
      return options.finalKeysReleased === false && effects.grants > 0 ? false : true;
    },
  };

  const harness = {
    events, effects, requests, pasteStarted: pasteStarted.promise,
    isVisible: () => visible,
    getContext: () => context,
    recordInput() {
      effects.inputSubmissions += 1;
      events.push("input-submitted");
    },
    async select(triggerKeys = []) {
      return plain(await context.copySelectedItem(7, true, "item-1", triggerKeys, GENERATION, "selection-1"));
    },
  };

  const client = {
    state: "ready", currentPanelGeneration: GENERATION, acceptedHelperGeneration: GENERATION,
    async request(command, generation) {
      requests.push(command);
      assert.equal(generation, GENERATION);
      events.push(`request-${command.kind}`);
      if (command.kind === "commit_write") {
        effects.clipboardWrites += 1;
        return { status: "clipboard_written", jobId: command.jobId, clipboardSequence: "42" };
      }
      assert.equal(command.kind, "paste");
      pasteStarted.resolve(command);
      // Model the original failure: hiding the host before dispatch loses the
      // foreground handoff, so this boundary refuses to inject any input.
      if (!visible) return { status: "cancelled", jobId: command.jobId, reasonCode: "host_hidden_before_handoff" };
      assert.equal(effects.grants, 1, "foreground authorization must precede paste");
      assert.ok(keyChecks >= 2, "release polling and the final key check must precede paste");
      assert.equal(context.nativePasteJob.pasteRequested, true, "blur must recognize the authorized focus handoff");
      await options.onPaste?.(command, harness);
      harness.recordInput();
      return { status: "input_submitted", jobId: command.jobId, target: command.target };
    },
  };

  context = vm.createContext({
    Error, AbortController, setTimeout, clearTimeout, clearInterval,
    randomUUID: () => `identity-${++nextIdentity}`,
    performance: { now: () => 1_000 + elapsedMs() },
    metrics: { mark: (_requestId, name) => events.push(`metric-${name}`) },
    finishSelectionMetrics: (_requestId, outcome) => events.push(`finished-${outcome}`),
    benchmarkMode: false,
    process: { argv: [] },
    history: [{ id: "item-1", type: "text", content: "光标中间插入", preview: "光标中间插入" }],
    mainWindow: {
      webContents: { id: 7 },
      isDestroyed: () => false,
      isVisible: () => visible,
      hide() { visible = false; effects.panelHides += 1; events.push("hide"); },
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
    helperReady: { status: "ready", helperPid: 22, helperProcessCreatedAt: "2200", helperInstanceId: "helper-1" },
    hostAuthorizationGate: new HostAuthorizationGate(),
    captureClipboardBaseline,
    raceSelectionPreparation,
    selectionHelperDeadlineAtCommit,
    startSelectionKeyReleaseMonitor,
    SELECTION_KEY_RELEASE_WINDOW_MS,
    IMAGE_LIMITS: { contentPrepareTimeoutMs: 3_000 },
    nativeContentProvider: {
      async snapshot() { events.push("snapshot"); return { itemRef: "item-1", itemVersion: "version-1" }; },
      isCurrent: () => true,
      release: () => events.push("release"),
    },
    async sendNativeContent(job) {
      job.registrationAttempted = true;
      job.registered = true;
      events.push("prepare");
      return { status: "prepared", jobId: job.jobId, prepareToken: "prepare-1" };
    },
    async cancelNativePasteJob(job) {
      effects.cancels += 1;
      events.push("cancel");
      job.cancelled = true;
      if (context.nativePasteJob === job) context.nativePasteJob = null;
      return true;
    },
    getMainWindowTarget: () => HOST,
    writeItemToElectronClipboard: () => { effects.electronFallbackWrites += 1; },
    clipboardSequenceGate: { markProcessed: (sequence) => assert.equal(sequence, 42) },
    resultForNativeStatus: (result) => ({ status: "blocked", reasonCode: result.reasonCode ?? result.status }),
    showPanel: () => { visible = true; events.push("show"); },
  });
  vm.runInContext(compiledMain, context, { filename: mainPath });
  return harness;
}

test("card click keeps the foreground host visible until a single native input acknowledgement", async () => {
  const completePaste = deferred();
  const harness = makeHarness({ onPaste: () => completePaste.promise });
  const selection = harness.select();
  const command = await harness.pasteStarted;

  assert.deepEqual(plain(command.target), TARGET);
  assert.deepEqual(plain(command.triggerKeys), []);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.effects.inputSubmissions, 0);
  assert.ok(harness.events.indexOf("authorize") < harness.events.indexOf("request-paste"));
  assert.ok(harness.events.indexOf("key-check-2") < harness.events.indexOf("request-paste"));

  completePaste.resolve();
  assert.deepEqual(await selection, { status: "input_submitted" });
  assert.equal(harness.effects.clipboardWrites, 1);
  assert.equal(harness.effects.inputSubmissions, 1);
  assert.equal(harness.effects.panelHides, 1);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.ok(harness.events.indexOf("input-submitted") < harness.events.indexOf("hide"));
  assert.equal(harness.getContext().panelGeneration, null);
});

test("a third foreground window denies authorization and causes zero paste/input requests", async () => {
  const harness = makeHarness({ foreground: EXTERNAL });
  assert.deepEqual(await harness.select(), { status: "copied_only", reasonCode: "host_not_foreground" });
  assert.equal(harness.effects.grants, 0);
  assert.equal(harness.requests.filter((request) => request.kind === "paste").length, 0);
  assert.equal(harness.effects.inputSubmissions, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.effects.cancels, 1);
});

test("a modifier pressed after authorization prevents paste dispatch and panel hiding", async () => {
  const harness = makeHarness({ finalKeysReleased: false });
  assert.deepEqual(await harness.select(), { status: "copied_only", reasonCode: "trigger_key_held" });
  assert.equal(harness.effects.grants, 1);
  assert.equal(harness.effects.clipboardWrites, 1);
  assert.equal(harness.requests.filter((request) => request.kind === "paste").length, 0);
  assert.equal(harness.effects.inputSubmissions, 0);
  assert.equal(harness.effects.panelHides, 0);
});

test("an unavailable key state blocks before clipboard commit and native paste dispatch", async () => {
  const harness = makeHarness({ keyStateUnavailable: true });
  assert.deepEqual(await harness.select(), { status: "blocked", reasonCode: "key_state_unavailable" });
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.effects.clipboardWrites, 0);
  assert.equal(harness.effects.electronFallbackWrites, 0);
  assert.equal(harness.effects.inputSubmissions, 0);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.effects.cancels, 1);
});

test("a lost native acknowledgement returns unknown without resending or copying again", async () => {
  const harness = makeHarness({
    onPaste(_command, current) {
      current.recordInput();
      current.getContext().helperClient.state = "unavailable";
      throw new Error("helper_process_exited");
    },
  });
  assert.deepEqual(await harness.select(), { status: "unknown", reasonCode: "helper_process_exited" });
  assert.equal(harness.requests.filter((request) => request.kind === "paste").length, 1);
  assert.equal(harness.effects.inputSubmissions, 1);
  assert.equal(harness.effects.clipboardWrites, 1);
  assert.equal(harness.effects.electronFallbackWrites, 0);
});

for (const replacementTarget of [null, EXTERNAL]) {
  test(`the acknowledged captured target survives a ${replacementTarget === null ? "cleared" : "replaced"} panel target during paste await`, async () => {
    const harness = makeHarness({
      onPaste(command, current) {
        assert.deepEqual(plain(command.target), TARGET);
        current.getContext().panelTarget = replacementTarget;
      },
    });
    assert.deepEqual(await harness.select(["Enter"]), { status: "input_submitted" });
    assert.equal(harness.effects.inputSubmissions, 1);
    assert.equal(harness.effects.panelHides, 1);
    assert.equal(harness.getContext().panelTarget, null);
  });
}

test("a late successful acknowledgement preserves a newly opened panel generation", async () => {
  const harness = makeHarness({
    onPaste(_command, current) {
      current.getContext().panelGeneration = "panel-2";
      current.getContext().panelTarget = EXTERNAL;
    },
  });
  assert.deepEqual(await harness.select(), { status: "input_submitted" });
  assert.equal(harness.effects.inputSubmissions, 1);
  assert.equal(harness.effects.panelHides, 0);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.getContext().panelGeneration, "panel-2");
  assert.deepEqual(plain(harness.getContext().panelTarget), EXTERNAL);
});
