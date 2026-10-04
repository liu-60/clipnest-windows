const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { NativeHelperClient } = require("../../../../dist-electron/main/native/helper-client.js");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 22;
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
}

test("P10 unknown paste outcome is not resent after helper disconnect", async () => {
  const child = new FakeChild();
  let requestNumber = 0;
  const client = new NativeHelperClient({
    spawnHelper: () => child,
    acceptReady: () => true,
    createRequestId: () => "request-" + (++requestNumber),
    readyTimeoutMs: 1_000,
  });
  const ready = client.start("C:\\test\\clipnest-helper.exe");
  child.stdout.emit("data", Buffer.from(JSON.stringify({
    v: 1,
    requestId: "startup",
    generation: "startup",
    helperInstanceId: "instance-a",
    status: "ready",
    durationMs: 0,
    helperPid: 22,
    helperProcessCreatedAt: "2200",
  }) + "\n", "utf8"));
  await ready;
  client.beginPanelGeneration("panel-1");

  const paste = client.request({
    kind: "paste",
    jobId: "job-1",
    prepareToken: "prepare-1",
    hostWindow: { hwnd: "100", pid: 11, processCreatedAt: "1100" },
    target: { hwnd: "200", pid: 33, processCreatedAt: "3300" },
    expectedClipboardSequence: "42",
    triggerKeys: [],
  }, "panel-1");
  assert.equal(child.writes.length, 1);

  child.emit("exit", 1, null);
  await assert.rejects(paste, /helper_process_exited/);
  assert.equal(client.state, "unavailable");
  assert.equal(child.writes.length, 1);
  assert.equal(child.killed, false);
});