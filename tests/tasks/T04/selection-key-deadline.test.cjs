const assert = require("node:assert/strict");
const test = require("node:test");
const {
  raceSelectionPreparation,
  selectionHelperDeadlineAtCommit,
  startSelectionKeyReleaseMonitor,
  SELECTION_KEY_RELEASE_WINDOW_MS,
} = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");
const { IMAGE_LIMITS } = require("../../../dist-electron/main/clipboard/image-preparation.js");

function createFakeClock() {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();

  return {
    get now() { return now; },
    get pendingTimers() { return timers.size; },
    schedule(callback, delayMs) {
      const id = ++nextTimerId;
      timers.set(id, { dueAt: now + delayMs, callback });
      return () => timers.delete(id);
    },
    jumpTo(target) {
      now = target;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        next[1].callback();
      }
    },
    advanceTo(target) {
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runFakeSelection({ preparationMs, keysReleasedAt }) {
  const clock = createFakeClock();
  const effects = { clipboardWrites: 0, panelHides: 0, inputSubmissions: 0 };
  const keysReleased = () => keysReleasedAt(clock.now);
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: SELECTION_KEY_RELEASE_WINDOW_MS,
    selectionDeadlineTickMs: SELECTION_KEY_RELEASE_WINDOW_MS,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased,
    schedule: clock.schedule,
  });

  // The monitor begins before preparation and observes the original cutoff.
  clock.advanceTo(preparationMs);
  let decision = await monitor.waitForPreparation();
  if (decision.kind === "continue" && keysReleased() !== true) {
    decision = { kind: "blocked", reasonCode: "key_held" };
  }
  if (decision.kind === "continue") {
    effects.clipboardWrites += 1;
    effects.panelHides += 1;
    effects.inputSubmissions += 1;
  }
  monitor.cancel();
  return { decision, effects, clock };
}

test("keys held at 500ms remain terminal after a 700ms release and 800ms preparation", async () => {
  const result = await runFakeSelection({ preparationMs: 800, keysReleasedAt: (now) => now >= 700 });
  assert.deepEqual(result.decision, { kind: "blocked", reasonCode: "key_held" });
  assert.deepEqual(result.effects, {
    clipboardWrites: 0,
    panelHides: 0,
    inputSubmissions: 0,
  });
  assert.equal(result.clock.pendingTimers, 0);
});

test("an early released state does not mask a re-press held at the 500ms cutoff", async () => {
  const result = await runFakeSelection({
    preparationMs: 800,
    keysReleasedAt: (now) => now < 400 || now >= 700,
  });
  assert.deepEqual(result.decision, { kind: "blocked", reasonCode: "key_held" });
  assert.deepEqual(result.effects, {
    clipboardWrites: 0,
    panelHides: 0,
    inputSubmissions: 0,
  });
  assert.equal(result.clock.pendingTimers, 0);
});

test("a poll delayed past both deadlines fails closed instead of trusting an old released sample", async () => {
  const clock = createFakeClock();
  const effects = { clipboardWrites: 0, panelHides: 0, inputSubmissions: 0 };
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: 500,
    selectionDeadlineTickMs: 500,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased: () => clock.now < 400 || clock.now >= 700,
    schedule: clock.schedule,
  });
  clock.jumpTo(700);
  const decision = await monitor.waitForPreparation();
  clock.jumpTo(800);
  if (decision.kind === "continue") {
    effects.clipboardWrites += 1;
    effects.panelHides += 1;
    effects.inputSubmissions += 1;
  }
  assert.deepEqual(decision, { kind: "blocked", reasonCode: "key_state_unavailable" });
  assert.deepEqual(effects, {
    clipboardWrites: 0,
    panelHides: 0,
    inputSubmissions: 0,
  });
  assert.equal(clock.pendingTimers, 0);
  monitor.cancel();
});

test("keys released before 500ms allow preparation to finish at 2500ms", async () => {
  const preparationMs = 2_500;
  assert.ok(preparationMs > SELECTION_KEY_RELEASE_WINDOW_MS);
  assert.ok(preparationMs < IMAGE_LIMITS.contentPrepareTimeoutMs);

  const result = await runFakeSelection({ preparationMs, keysReleasedAt: (now) => now >= 490 });
  assert.deepEqual(result.decision, {
    kind: "continue",
    operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS,
  });
  assert.deepEqual(result.effects, {
    clipboardWrites: 1,
    panelHides: 1,
    inputSubmissions: 1,
  });
  assert.equal(result.clock.pendingTimers, 0);
});

test("preparation can wait for a release observed before the original cutoff", async () => {
  const clock = createFakeClock();
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: 500,
    selectionDeadlineTickMs: 500,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased: () => clock.now >= 450,
    schedule: clock.schedule,
  });
  const pendingDecision = monitor.waitForPreparation();
  clock.advanceTo(450);
  assert.deepEqual(await pendingDecision, {
    kind: "continue",
    operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS,
  });
  monitor.cancel();
  assert.equal(clock.pendingTimers, 0);
});

test("selection cancellation resolves a pending wait and clears the monitor timer", async () => {
  const clock = createFakeClock();
  let current = true;
  const effects = { clipboardWrites: 0, panelHides: 0, inputSubmissions: 0 };
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: 500,
    selectionDeadlineTickMs: 500,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased: () => false,
    isCurrent: () => current,
    schedule: clock.schedule,
  });
  const pendingDecision = monitor.waitForPreparation();
  current = false;
  monitor.cancel();

  assert.deepEqual(await pendingDecision, { kind: "blocked", reasonCode: "selection_cancelled" });
  assert.deepEqual(effects, {
    clipboardWrites: 0,
    panelHides: 0,
    inputSubmissions: 0,
  });
  assert.equal(clock.pendingTimers, 0);
});

test("held at the 500ms cutoff cancels pending preparation and outranks its later timeout", async () => {
  const clock = createFakeClock();
  const pending = deferred();
  const effects = { clipboardWrites: 0, panelHides: 0, inputSubmissions: 0 };
  let cancelCount = 0;
  let helperRequests = 0;
  let preparationActive = true;
  const preparation = pending.promise.then(() => {
    helperRequests += 1; // The fake helper register request starts only after snapshot preparation resolves.
    return "prepared";
  }).finally(() => { preparationActive = false; });
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: 500,
    selectionDeadlineTickMs: 500,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased: () => false,
    schedule: clock.schedule,
  });
  const raced = raceSelectionPreparation({
    monitor,
    preparation,
    cancelPreparation: () => {
      cancelCount += 1;
      // Abort before snapshot completion; the fake's helper registration stage never starts.
      queueMicrotask(() => pending.reject(new Error("image_prepare_timeout")));
    },
  });

  clock.advanceTo(500);
  const result = await raced;
  await new Promise((resolve) => setImmediate(resolve));
  if (result.kind === "prepared") {
    effects.clipboardWrites += 1;
    effects.panelHides += 1;
    effects.inputSubmissions += 1;
  }
  assert.deepEqual(result, { kind: "blocked", decision: { kind: "blocked", reasonCode: "key_held" } });
  assert.equal(cancelCount, 1);
  assert.equal(helperRequests, 0);
  assert.equal(preparationActive, false, "the canceled preparation promise has settled before selection returns");
  assert.deepEqual(effects, { clipboardWrites: 0, panelHides: 0, inputSubmissions: 0 });
  assert.equal(clock.pendingTimers, 0);
  monitor.cancel();
});

test("a released cutoff keeps waiting for pending preparation and clears its timer", async () => {
  const clock = createFakeClock();
  const pending = deferred();
  let cancelCount = 0;
  const monitor = startSelectionKeyReleaseMonitor({
    selectionDeadlineAt: 500,
    selectionDeadlineTickMs: 500,
    nowAt: () => clock.now,
    nowTickMs: () => clock.now,
    keysReleased: () => clock.now >= 490,
    schedule: clock.schedule,
  });
  const raced = raceSelectionPreparation({
    monitor,
    preparation: pending.promise,
    cancelPreparation: () => { cancelCount += 1; },
  });

  clock.advanceTo(500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCount, 0, "released cutoff must not cancel still-pending preparation");
  assert.equal(clock.pendingTimers, 0, "the monitor timer is cleared at the absolute cutoff");
  pending.resolve("prepared-image");
  assert.deepEqual(await raced, { kind: "prepared", result: "prepared-image" });
  assert.equal(cancelCount, 0);
  monitor.cancel();
  assert.equal(clock.pendingTimers, 0);
});

test("the helper receives the absolute deadline only when commit starts before it", () => {
  assert.deepEqual(selectionHelperDeadlineAtCommit(490, 500), { kind: "include", deadlineTickMs: 500 });
  assert.deepEqual(selectionHelperDeadlineAtCommit(2_500, 500), { kind: "expired", selectionBudgetMs: 0 });
  assert.deepEqual(selectionHelperDeadlineAtCommit(null, 500), { kind: "unavailable" });
});
