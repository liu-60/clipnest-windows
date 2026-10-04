const assert = require("node:assert/strict");
const test = require("node:test");
const { DataType, PointerType } = require("ffi-rs");
const { createWin32HostBridge } = require("../../../dist-electron/main/native/win32-host-bridge.js");

function fakeRuntime(overrides = {}) {
  const calls = [];
  let nextPointerId = 0;
  const runtime = {
    DataType,
    PointerType,
    open: (args) => calls.push({ name: "open", ...args }),
    close: (library) => calls.push({ name: "close", library }),
    createPointer({ paramsType, paramsValue }) {
      calls.push({ name: "createPointer", paramsType });
      const pointer = { id: ++nextPointerId, values: [...paramsValue] };
      return [pointer];
    },
    restorePointer({ paramsValue }) {
      return [...paramsValue[0].values];
    },
    freePointer({ paramsValue, pointerType }) {
      calls.push({ name: "freePointer", pointerId: paramsValue[0].id, pointerType });
    },
    isNullPointer: (pointer) => pointer === null,
    load(args) {
      calls.push({ name: "load", ...args });
      if (args.funcName === "OpenProcess") return { handle: "fake-process-handle" };
      if (args.funcName === "GetProcessTimes") {
        const [creation] = args.paramsValue.slice(1);
        creation.values[0] = (0x01234567n << 32n) | 0x89abcdefn;
        return overrides.processTimesResult ?? 1;
      }
      if (args.funcName === "CloseHandle") return overrides.closeHandleResult ?? 1;
      if (args.funcName === "GetForegroundWindow") return 0x12345678n;
      if (args.funcName === "GetWindowThreadProcessId") {
        args.paramsValue[1].values[0] = 77;
        return 88;
      }
      if (args.funcName === "AllowSetForegroundWindow") return overrides.allowResult ?? 1;
      if (args.funcName === "GetClipboardSequenceNumber") return overrides.clipboardSequence ?? 0;
      if (args.funcName === "GetTickCount64") {
        if (overrides.tickCountThrows) throw new Error("tick_count_failure");
        return overrides.tickCount64 ?? 123456;
      }
      if (args.funcName === "GetAsyncKeyState") {
        if (overrides.asyncKeyStateThrows) throw new Error("key_state_failure");
        return (overrides.downVirtualKeys ?? []).includes(args.paramsValue[0]) ? -32768 : 0;
      }
      throw new Error(`Unexpected FFI symbol ${args.funcName}`);
    },
  };
  return { runtime, calls };
}

test("fixed bridge opens only KnownDLL libraries and reads FILETIME exactly with finally cleanup", () => {
  const { runtime, calls } = fakeRuntime();
  const bridge = createWin32HostBridge(runtime);
  const identity = bridge.getProcessIdentity(77);
  const expectedCreationTime = ((0x01234567n << 32n) | 0x89abcdefn).toString(10);

  assert.deepEqual(identity, { pid: 77, processCreatedAt: expectedCreationTime });
  const openCalls = calls.filter((entry) => entry.name === "open");
  assert.deepEqual(openCalls.map((entry) => entry.library), ["clipnest_kernel32", "clipnest_user32"]);
  assert.deepEqual(openCalls.map((entry) => entry.path), ["kernel32.dll", "user32.dll"]);
  assert.ok(openCalls.every((entry) => !/[\\/:]/.test(entry.path) && !entry.path.includes("..")));

  const processTimeCall = calls.find((entry) => entry.name === "load" && entry.funcName === "GetProcessTimes");
  assert.equal(processTimeCall.retType, DataType.I32);
  assert.deepEqual(processTimeCall.paramsType, Array(5).fill(DataType.External));
  assert.deepEqual(calls.filter((entry) => entry.name === "createPointer").map((entry) => entry.paramsType),
    [[DataType.BigInt], [DataType.BigInt], [DataType.BigInt], [DataType.BigInt]]);
  assert.equal(calls.filter((entry) => entry.name === "freePointer").length, 4);
  assert.equal(calls.filter((entry) => entry.name === "load" && entry.funcName === "CloseHandle").length, 1);

  const symbols = calls.filter((entry) => entry.name === "load").map((entry) => entry.funcName);
  assert.deepEqual([...new Set(symbols)].sort(), ["CloseHandle", "GetProcessTimes", "OpenProcess"]);
  bridge.close();
});

test("shared monotonic tick is read as a safe integer and fails closed", () => {
  const normal = createWin32HostBridge(fakeRuntime({ tickCount64: 987654 }).runtime);
  assert.equal(normal.getMonotonicTickMs(), 987654);
  normal.close();

  const unsafe = createWin32HostBridge(fakeRuntime({ tickCount64: Number.MAX_SAFE_INTEGER + 1 }).runtime);
  assert.equal(unsafe.getMonotonicTickMs(), null);
  unsafe.close();

  const broken = createWin32HostBridge(fakeRuntime({ tickCountThrows: true }).runtime);
  assert.equal(broken.getMonotonicTickMs(), null);
  broken.close();
});

test("foreground HWND, PID, repeated authorization bridge, and sequence zero are fail closed", () => {
  const { runtime, calls } = fakeRuntime({ clipboardSequence: 0 });
  const bridge = createWin32HostBridge(runtime);

  assert.deepEqual(bridge.getForegroundWindow(), {
    hwnd: "305419896",
    pid: 77,
    processCreatedAt: ((0x01234567n << 32n) | 0x89abcdefn).toString(10),
  });
  assert.equal(bridge.allowSetForegroundWindow(77), true);
  assert.equal(bridge.allowSetForegroundWindow(0), false);
  assert.equal(bridge.getClipboardSequenceNumber(), 0);
  assert.equal(bridge.getWindowTarget("0"), null);
  assert.equal(calls.filter((entry) => entry.name === "load" && entry.funcName === "AllowSetForegroundWindow").length, 1);
  assert.deepEqual(
    [...new Set(calls.filter((entry) => entry.name === "load").map((entry) => entry.funcName))].sort(),
    ["AllowSetForegroundWindow", "CloseHandle", "GetClipboardSequenceNumber", "GetForegroundWindow", "GetProcessTimes", "GetWindowThreadProcessId", "OpenProcess"],
  );
  bridge.close();
  assert.equal(bridge.getClipboardSequenceNumber(), 0);
});

test("pre-hide key check reads trigger keys and every modifier, failing closed", () => {
  const { runtime, calls } = fakeRuntime();
  const bridge = createWin32HostBridge(runtime);
  assert.equal(bridge.areKeysReleased(["Enter"]), true);
  const queried = calls.filter((entry) => entry.name === "load" && entry.funcName === "GetAsyncKeyState");
  assert.deepEqual(queried.map((entry) => entry.paramsValue[0]).sort((a, b) => a - b),
    [0x0d, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c].sort((a, b) => a - b));
  bridge.close();

  const held = createWin32HostBridge(fakeRuntime({ downVirtualKeys: [0x56] }).runtime);
  assert.equal(held.areKeysReleased(["V"]), false);
  held.close();

  const unavailable = createWin32HostBridge(fakeRuntime({ asyncKeyStateThrows: true }).runtime);
  assert.equal(unavailable.areKeysReleased([]), null);
  unavailable.close();
});

test("KnownDLL loading ignores malicious SystemRoot and never builds a UNC or writable DLL path", () => {
  const originalSystemRoot = process.env.SystemRoot;
  const { runtime, calls } = fakeRuntime();
  let bridge;
  try {
    process.env.SystemRoot = "\\\\attacker.example\\share\\Windows";
    bridge = createWin32HostBridge(runtime);
    const paths = calls.filter((entry) => entry.name === "open").map((entry) => entry.path);
    assert.deepEqual(paths, ["kernel32.dll", "user32.dll"]);
    assert.ok(paths.every((path) => !path.startsWith("\\\\") && !/[\\/:]/.test(path)));
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    bridge?.close();
  }
});

test("failed GetProcessTimes still closes the process handle and releases FILETIME pointers", () => {
  const { runtime, calls } = fakeRuntime({ processTimesResult: 0 });
  const bridge = createWin32HostBridge(runtime);
  assert.equal(bridge.getProcessIdentity(77), null);
  assert.equal(calls.filter((entry) => entry.name === "freePointer").length, 4);
  assert.equal(calls.filter((entry) => entry.name === "load" && entry.funcName === "CloseHandle").length, 1);
  bridge.close();
});
