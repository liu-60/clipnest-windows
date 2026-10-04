const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { ClipboardWriteFence, NativeHelperClient } = require("../../../dist-electron/main/native/helper-client.js");

const target = { hwnd: "100", pid: 11, processCreatedAt: "1100" };

class FakeChild extends EventEmitter {
  constructor(pid = 22) {
    super();
    this.pid = pid;
    this.killed = false;
    this.writes = [];
    this.stdin = new EventEmitter();
    this.stdin.writableLength = 0;
    this.stdin.write = (value, callback) => {
      this.writes.push(value);
      callback?.();
      return true;
    };
    this.stdout = new EventEmitter();
  }

  kill() {
    this.killed = true;
    return true;
  }

  requestAt(index = this.writes.length - 1) {
    return JSON.parse(this.writes[index].trim());
  }

  emitResult(value) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  }
}

function ready(pid = 22, instance = "instance-a") {
  return {
    v: 1,
    requestId: "startup",
    generation: "startup",
    helperInstanceId: instance,
    status: "ready",
    durationMs: 0,
    helperPid: pid,
    helperProcessCreatedAt: "2200",
  };
}

function result(request, status, fields = {}) {
  return {
    v: 1,
    requestId: request.requestId,
    generation: request.generation,
    helperInstanceId: request.helperInstanceId,
    status,
    durationMs: 0,
    ...fields,
  };
}

function makeClient(child, options = {}) {
  const client = new NativeHelperClient({
    spawnHelper: () => child,
    acceptReady: options.acceptReady ?? (() => true),
    createRequestId: (() => {
      let next = 0;
      return () => `req-${++next}`;
    })(),
    onCurrentResult: options.onCurrentResult,
    onProcessExit: options.onProcessExit,
  });
  return client;
}

async function start(client, child, readyResult = ready()) {
  const pending = client.start("C:\\test\\clipnest-helper.exe");
  child.emitResult(readyResult);
  return pending;
}

test("clipboard write fence blocks until helper exit is confirmed", () => {
  const fence = new ClipboardWriteFence();
  fence.blockUntilHelperExit();
  assert.equal(fence.isBlocked, true);
  assert.throws(() => fence.assertWriteAllowed(), /helper_side_effect_unresolved/);
  fence.confirmHelperExit();
  assert.equal(fence.isBlocked, false);
  assert.doesNotThrow(() => fence.assertWriteAllowed());
});

test("READY is accepted only when the child PID and host authorization gate agree", async () => {
  const wrongPidChild = new FakeChild(23);
  const wrongPidClient = makeClient(wrongPidChild);
  await assert.rejects(start(wrongPidClient, wrongPidChild, ready(22)), /helper_ready_identity_mismatch/);
  assert.equal(wrongPidChild.killed, true);

  const deniedChild = new FakeChild(22);
  const deniedClient = makeClient(deniedChild, { acceptReady: () => false });
  await assert.rejects(start(deniedClient, deniedChild), /helper_ready_identity_mismatch/);
  assert.equal(deniedChild.killed, true);
});

test("throwing READY authorization callback rejects startup without escaping stdout handler", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { acceptReady: () => { throw new Error("bridge_failure"); } });
  const startup = client.start("C:\\test\\clipnest-helper.exe");

  assert.doesNotThrow(() => child.emitResult(ready()));
  await assert.rejects(startup, /helper_ready_identity_mismatch/);
  assert.equal(client.state, "unavailable");
  assert.equal(child.killed, true);
});

test("request envelope is generated after caller fields and exact correlated ACK settles the promise", async () => {
  const child = new FakeChild();
  const seen = [];
  const client = makeClient(child, { onCurrentResult: (value) => seen.push(value) });
  await start(client, child);
  client.beginPanelGeneration("panel-1");

  const pending = client.request({ kind: "capture", requestId: "spoof", generation: "spoof", helperInstanceId: "spoof", v: 9 }, "panel-1");
  const request = child.requestAt();
  assert.equal(request.requestId, "req-1");
  assert.equal(request.generation, "panel-1");
  assert.equal(request.helperInstanceId, "instance-a");
  assert.equal(request.v, 1);
  child.emitResult(result(request, "captured", { target }));
  assert.equal((await pending).status, "captured");
  assert.equal(client.acceptedHelperGeneration, "panel-1");
  assert.equal(seen.length, 1);
});

test("P13 opening N+1 isolates delayed N ACKs and uses a new request ID after quiescence", async () => {
  const child = new FakeChild();
  const observed = [];
  const client = makeClient(child, { onCurrentResult: (value) => observed.push(value) });
  await start(client, child);

  client.beginPanelGeneration("panel-N");
  const registerPromise = client.request({
    kind: "register_content",
    jobId: "job-N",
    objectToken: "object-N",
    itemRef: "item-N",
    expectedItemVersion: "version-N",
    contentType: "text",
    totalBytes: 0,
    totalHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    inlineBase64: "",
  }, "panel-N");
  const registerRequest = child.requestAt();
  child.emitResult(result(registerRequest, "content_registered", { jobId: "job-N", objectToken: "object-N" }));
  await registerPromise;
  assert.equal(client.activeJobCount, 1);

  const lateNPromise = client.request({ kind: "capture" }, "panel-N");
  const lateNRequest = child.requestAt();
  client.beginPanelGeneration("panel-N-plus-1");
  assert.equal(client.currentPanelGeneration, "panel-N-plus-1");

  const earlyN1Promise = client.request({ kind: "capture" }, "panel-N-plus-1");
  const earlyN1Request = child.requestAt();
  child.emitResult(result(earlyN1Request, "busy", {
    reasonCode: "generation_transition_pending",
  }));
  assert.equal((await earlyN1Promise).reasonCode, "generation_transition_pending");
  assert.equal(client.acceptedHelperGeneration, "panel-N");

  child.emitResult(result(lateNRequest, "captured", { target }));
  assert.equal((await lateNPromise).status, "captured");
  assert.deepEqual(observed.map((value) => value.generation), ["panel-N", "panel-N-plus-1"]);
  assert.equal(client.currentPanelGeneration, "panel-N-plus-1");

  const terminal = result(registerRequest, "job_finished", { jobId: "job-N", workerQuiescent: true });
  child.emitResult(terminal);
  assert.equal(client.activeJobCount, 0);

  const retried = client.request({ kind: "capture" }, "panel-N-plus-1");
  const retryRequest = child.requestAt();
  assert.notEqual(retryRequest.requestId, earlyN1Request.requestId);
  let retrySettled = false;
  void retried.then(() => { retrySettled = true; });
  child.emitResult(result(lateNRequest, "captured", { target }));
  await Promise.resolve();
  assert.equal(retrySettled, false);
  child.emitResult(result(retryRequest, "captured", { target }));
  assert.equal((await retried).status, "captured");
  assert.equal(client.acceptedHelperGeneration, "panel-N-plus-1");
  assert.equal(observed.at(-1).requestId, retryRequest.requestId);
});

test("stale generation and malformed output never resend a request", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await start(client, child);
  client.beginPanelGeneration("panel-old");
  const oldPending = client.request({ kind: "capture" }, "panel-old");
  const oldRequest = child.requestAt();
  child.emitResult(result(oldRequest, "captured", { target }));
  await oldPending;
  client.beginPanelGeneration("panel-new");
  await assert.rejects(client.request({ kind: "capture" }, "panel-old"), /stale_generation/);
  assert.equal(child.writes.length, 1);

  const pending = client.request({ kind: "capture" }, "panel-new", { timeoutMs: 1_000 });
  const countBeforeBadResult = child.writes.length;
  const request = child.requestAt();
  child.emitResult(result(request, "ready", { helperPid: 22, helperProcessCreatedAt: "2200" }));
  await assert.rejects(pending, /helper_instance_changed/);
  assert.equal(client.state, "unavailable");
  assert.equal(child.writes.length, countBeforeBadResult);
  assert.equal(child.killed, true);
});

test("cancel deadline failure disables the client and does not retry input", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await start(client, child);
  client.beginPanelGeneration("panel-1");
  const pending = client.request({ kind: "cancel", jobId: "job-1" }, "panel-1", { timeoutMs: 10 });
  assert.equal(child.writes.length, 1);
  await assert.rejects(pending, /helper_request_timeout/);
  assert.equal(client.state, "unavailable");
  assert.equal(child.writes.length, 1);
  assert.equal(child.killed, true);
});

test("cancel requires an active job ID and cancelled or too_late ACK must carry that same ID", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await start(client, child);
  client.beginPanelGeneration("panel-1");

  await assert.rejects(client.request({ kind: "cancel" }, "panel-1"), /cancel_job_id_required/);
  assert.equal(child.writes.length, 0);

  const missingId = client.request({ kind: "cancel", jobId: "job-1" }, "panel-1");
  const missingIdRequest = child.requestAt();
  child.emitResult(result(missingIdRequest, "cancelled", { workerQuiescent: true }));
  await assert.rejects(missingId, /helper_cancel_correlation_invalid/);
  assert.equal(client.state, "unavailable");
  assert.equal(child.killed, true);

  const wrongChild = new FakeChild();
  const wrongClient = makeClient(wrongChild);
  await start(wrongClient, wrongChild);
  wrongClient.beginPanelGeneration("panel-2");
  const wrongId = wrongClient.request({ kind: "cancel", jobId: "job-2" }, "panel-2");
  const wrongIdRequest = wrongChild.requestAt();
  wrongChild.emitResult(result(wrongIdRequest, "too_late", { jobId: "other-job", workerQuiescent: false }));
  await assert.rejects(wrongId, /helper_result_correlation_invalid/);
  assert.equal(wrongClient.state, "unavailable");
});

test("throwing result observer rejects the correlated request and disables the client", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { onCurrentResult: () => { throw new Error("observer_failure"); } });
  await start(client, child);
  client.beginPanelGeneration("panel-1");

  const pending = client.request({ kind: "capture" }, "panel-1");
  const request = child.requestAt();
  assert.doesNotThrow(() => child.emitResult(result(request, "captured", { target })));
  await assert.rejects(pending, /helper_observer_failed/);
  assert.equal(client.pendingRequestCount, 0);
  assert.equal(client.state, "unavailable");
  assert.equal(child.killed, true);
});

test("terminateAndWait requires a real child exit before confirming shutdown", async () => {
  const child = new FakeChild();
  let exitNotifications = 0;
  const client = makeClient(child, { onProcessExit: () => { exitNotifications += 1; } });
  await start(client, child);

  const stopped = client.terminateAndWait(100);
  assert.equal(child.killed, true);
  let settled = false;
  void stopped.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  child.emit("exit", 0, null);
  assert.equal(await stopped, true);
  assert.equal(client.hasExited, true);
  assert.equal(exitNotifications, 1);
});

test("terminateAndWait reports an unconfirmed exit after its bounded wait", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await start(client, child);

  assert.equal(await client.terminateAndWait(1), false);
  assert.equal(child.killed, true);
  child.emit("exit", 0, null);
  assert.equal(await client.terminateAndWait(1), true);
});
