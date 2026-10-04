const assert = require("node:assert/strict");
const test = require("node:test");

const { HostAuthorizationGate, captureClipboardBaseline } = require("../../../dist-electron/main/native/host-authorization.js");

const hostWindow = { hwnd: "100", pid: 11, processCreatedAt: "1100" };
const ready = {
  v: 1,
  requestId: "startup",
  generation: "startup",
  helperInstanceId: "instance-a",
  status: "ready",
  durationMs: 0,
  helperPid: 22,
  helperProcessCreatedAt: "2200",
};

function fakeApi({ processIdentity, foreground = hostWindow, allow = true } = {}) {
  let activeForeground = foreground;
  const calls = { process: [], foreground: 0, allow: [], clipboardSequence: 0 };
  return {
    calls,
    setForeground(value) {
      activeForeground = value;
    },
    api: {
      getProcessIdentity(pid) {
        calls.process.push(pid);
        return processIdentity ?? { pid, processCreatedAt: ready.helperProcessCreatedAt };
      },
      getForegroundWindow() {
        calls.foreground += 1;
        return activeForeground;
      },
      allowSetForegroundWindow(pid) {
        calls.allow.push(pid);
        return allow;
      },
      getClipboardSequenceNumber() {
        calls.clipboardSequence += 1;
        return 42;
      },
    },
  };
}

test("each consecutive paste intent rechecks and authorizes the same live helper", () => {
  const gate = new HostAuthorizationGate();
  const fake = fakeApi();
  const activeHelper = { pid: 22 };

  assert.equal(gate.authorize(ready, activeHelper, hostWindow, fake.api), "authorized");
  assert.equal(gate.authorize(ready, activeHelper, hostWindow, fake.api), "authorized");
  assert.deepEqual(fake.calls.process, [22, 22]);
  assert.equal(fake.calls.foreground, 2);
  assert.deepEqual(fake.calls.allow, [22, 22]);
});

test("a prior grant does not authorize when the host later leaves the foreground", () => {
  const gate = new HostAuthorizationGate();
  const fake = fakeApi({ foreground: { ...hostWindow, hwnd: "101" } });

  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, fake.api), "host_not_foreground");
  assert.deepEqual(fake.calls.allow, []);
  fake.setForeground(hostWindow);
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, fake.api), "authorized");
  fake.setForeground({ ...hostWindow, hwnd: "101" });
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, fake.api), "host_not_foreground");
  assert.deepEqual(fake.calls.allow, [22]);
  assert.deepEqual(fake.calls.process, [22, 22, 22]);
  assert.equal(fake.calls.foreground, 3);
});

test("READY PID mismatch, PID reuse, and creation-time mismatch make zero authorization calls", () => {
  const wrongPid = fakeApi();
  const reusedPid = fakeApi({ processIdentity: { pid: 23, processCreatedAt: "2200" } });
  const changedCreation = fakeApi({ processIdentity: { pid: 22, processCreatedAt: "2201" } });
  const gate = new HostAuthorizationGate();

  assert.equal(gate.authorize(ready, { pid: 23 }, hostWindow, wrongPid.api), "helper_identity_mismatch");
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, reusedPid.api), "helper_identity_mismatch");
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, changedCreation.api), "helper_identity_mismatch");
  assert.deepEqual(wrongPid.calls.allow, []);
  assert.deepEqual(reusedPid.calls.allow, []);
  assert.deepEqual(changedCreation.calls.allow, []);
});

test("helper restart requires a new READY identity and does not reuse the prior authorization", () => {
  const gate = new HostAuthorizationGate();
  const first = fakeApi();
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, first.api), "authorized");

  const restartedReady = {
    ...ready,
    helperInstanceId: "instance-b",
    helperPid: 33,
    helperProcessCreatedAt: "3300",
  };
  const restarted = fakeApi({ processIdentity: { pid: 33, processCreatedAt: "3300" } });
  assert.equal(gate.authorize(restartedReady, { pid: 33 }, hostWindow, restarted.api), "authorized");
  assert.deepEqual(first.calls.allow, [22]);
  assert.deepEqual(restarted.calls.allow, [33]);
});

test("a denied authorization is retried for the next paste intent", () => {
  const gate = new HostAuthorizationGate();
  const fake = fakeApi({ allow: false });

  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, fake.api), "authorization_denied");
  assert.equal(gate.authorize(ready, { pid: 22 }, hostWindow, fake.api), "authorization_denied");
  assert.deepEqual(fake.calls.process, [22, 22]);
  assert.equal(fake.calls.foreground, 2);
  assert.deepEqual(fake.calls.allow, [22, 22]);
});

test("selection baseline is sampled through the fixed host bridge and zero fails closed", () => {
  const fake = fakeApi();
  assert.equal(captureClipboardBaseline(fake.api), "42");
  assert.equal(fake.calls.clipboardSequence, 1);
  fake.api.getClipboardSequenceNumber = () => 0;
  assert.equal(captureClipboardBaseline(fake.api), null);
});
