import * as ffi from "ffi-rs";
import type { JsExternal } from "ffi-rs";
import type { NativeTarget, NativeTriggerKey } from "../../shared/native-contracts";
import type { HostAuthorizationApi } from "./host-authorization";

const KERNEL_LIBRARY = "clipnest_kernel32";
const USER_LIBRARY = "clipnest_user32";
const KERNEL_DLL = "kernel32.dll";
const USER_DLL = "user32.dll";
const KNOWN_SYSTEM_DLLS = new Set([KERNEL_DLL, USER_DLL]);
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export interface Win32HostBridge extends HostAuthorizationApi {
  getWindowTarget(hwnd: string): NativeTarget | null;
  getMonotonicTickMs(): number | null;
  areKeysReleased(triggerKeys: readonly NativeTriggerKey[]): boolean | null;
  close(): void;
}

interface FfiRuntime {
  DataType: typeof ffi.DataType;
  PointerType: typeof ffi.PointerType;
  open(params: { library: string; path: string }): void;
  close(library: string): void;
  load(params: {
    library: string;
    funcName: string;
    retType: ffi.DataType;
    paramsType: ffi.DataType[];
    paramsValue: unknown[];
  }): unknown;
  createPointer(params: { paramsType: ffi.DataType[]; paramsValue: unknown[] }): JsExternal[];
  restorePointer(params: { retType: ffi.DataType[]; paramsValue: JsExternal[] }): unknown[];
  freePointer(params: {
    paramsType: ffi.DataType[];
    paramsValue: JsExternal[];
    pointerType: ffi.PointerType;
  }): void;
  isNullPointer(pointer: JsExternal): boolean;
}

function decimalHandle(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const handle = BigInt(value);
    return handle > 0n && handle <= 0xffffffffffffffffn ? handle : null;
  } catch {
    return null;
  }
}

function creationTime(runtime: FfiRuntime, pointer: JsExternal[]): string | null {
  const [fileTime] = runtime.restorePointer({
    retType: [runtime.DataType.BigInt],
    paramsValue: pointer,
  }) as [bigint];
  return typeof fileTime === "bigint" && fileTime >= 0n ? fileTime.toString(10) : null;
}

function openKnownSystemDll(runtime: FfiRuntime, library: string, dllName: string): void {
  // These basenames resolve through the Windows KnownDLL mechanism. Never form
  // a full path from SystemRoot or accept a path that could name a UNC or
  // user-writable DLL location.
  if (!KNOWN_SYSTEM_DLLS.has(dllName) || /[\\/:]/.test(dllName) || dllName.includes("..")) {
    throw new Error("win32_system_library_path_invalid");
  }
  runtime.open({ library, path: dllName });
}

/**
 * Fixed, private bindings for the Win32 calls T03 needs. The optional runtime
 * argument exists for unit tests; production constructs this with ffi-rs and
 * exposes only the typed methods below to main-process code.
 */
export function createWin32HostBridge(runtime: FfiRuntime = ffi as unknown as FfiRuntime): Win32HostBridge {
  if (process.platform !== "win32") throw new Error("win32_bridge_platform_invalid");
  const opened: string[] = [];

  try {
    openKnownSystemDll(runtime, KERNEL_LIBRARY, KERNEL_DLL);
    opened.push(KERNEL_LIBRARY);
    openKnownSystemDll(runtime, USER_LIBRARY, USER_DLL);
    opened.push(USER_LIBRARY);
  } catch {
    for (const library of opened.reverse()) {
      try { runtime.close(library); } catch { /* fail closed */ }
    }
    throw new Error("win32_bridge_load_failed");
  }

  let closed = false;
  const load = <T>(
    library: string,
    funcName: string,
    retType: ffi.DataType,
    paramsType: ffi.DataType[],
    paramsValue: unknown[],
  ): T => runtime.load({ library, funcName, retType, paramsType, paramsValue }) as T;

  function getProcessIdentity(pid: number): { pid: number; processCreatedAt: string } | null {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff || closed) return null;
    let handle: JsExternal | null = null;
    const fileTimes: JsExternal[][] = [];
    let identity: { pid: number; processCreatedAt: string } | null = null;
    let closeSucceeded = false;
    try {
      handle = load<JsExternal>(KERNEL_LIBRARY, "OpenProcess", runtime.DataType.External,
        [runtime.DataType.U32, runtime.DataType.I32, runtime.DataType.U32],
        [PROCESS_QUERY_LIMITED_INFORMATION, 0, pid]);
      if (runtime.isNullPointer(handle)) return null;

      for (let index = 0; index < 4; index += 1) {
        fileTimes.push(runtime.createPointer({
          paramsType: [runtime.DataType.BigInt],
          paramsValue: [0n],
        }));
      }
      const ok = load<number>(KERNEL_LIBRARY, "GetProcessTimes", runtime.DataType.I32,
        [runtime.DataType.External, runtime.DataType.External, runtime.DataType.External, runtime.DataType.External, runtime.DataType.External],
        [handle, ...fileTimes.map((pointer) => pointer[0])]);
      if (ok !== 0) {
        const createdAt = creationTime(runtime, fileTimes[0]);
        if (createdAt !== null) identity = { pid, processCreatedAt: createdAt };
      }
    } catch {
      identity = null;
    } finally {
      for (const pointer of fileTimes) {
        try {
          runtime.freePointer({
            paramsType: [runtime.DataType.BigInt],
            paramsValue: pointer,
            pointerType: runtime.PointerType.RsPointer,
          });
        } catch {
          identity = null;
        }
      }
      if (handle && !runtime.isNullPointer(handle)) {
        try {
          closeSucceeded = load<number>(KERNEL_LIBRARY, "CloseHandle", runtime.DataType.I32,
            [runtime.DataType.External], [handle]) !== 0;
        } catch {
          closeSucceeded = false;
        }
      }
    }
    return closeSucceeded ? identity : null;
  }

  function getWindowTarget(hwndText: string): NativeTarget | null {
    if (closed) return null;
    const hwnd = decimalHandle(hwndText);
    if (hwnd === null) return null;
    const pidPointer = runtime.createPointer({ paramsType: [runtime.DataType.U32], paramsValue: [0] });
    try {
      const threadId = load<number>(USER_LIBRARY, "GetWindowThreadProcessId", runtime.DataType.U32,
        [runtime.DataType.BigInt, runtime.DataType.External], [hwnd, pidPointer[0]]);
      const [pid] = runtime.restorePointer({ retType: [runtime.DataType.U32], paramsValue: pidPointer }) as [number];
      if (threadId === 0 || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) return null;
      const process = getProcessIdentity(pid);
      return process ? { hwnd: hwnd.toString(10), ...process } : null;
    } catch {
      return null;
    } finally {
      try {
        runtime.freePointer({
          paramsType: [runtime.DataType.U32],
          paramsValue: pidPointer,
          pointerType: runtime.PointerType.RsPointer,
        });
      } catch { /* no pointer escapes this fixed wrapper */ }
    }
  }

  return {
    getProcessIdentity,
    getWindowTarget(hwnd) {
      return getWindowTarget(hwnd);
    },
    getForegroundWindow() {
      if (closed) return null;
      try {
        const hwnd = load<bigint>(USER_LIBRARY, "GetForegroundWindow", runtime.DataType.BigInt, [], []);
        return hwnd > 0n ? getWindowTarget(hwnd.toString(10)) : null;
      } catch {
        return null;
      }
    },
    allowSetForegroundWindow(pid) {
      if (closed || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) return false;
      try {
        return load<number>(USER_LIBRARY, "AllowSetForegroundWindow", runtime.DataType.I32,
          [runtime.DataType.U32], [pid]) !== 0;
      } catch {
        return false;
      }
    },
    getClipboardSequenceNumber() {
      if (closed) return 0;
      try {
        return load<number>(USER_LIBRARY, "GetClipboardSequenceNumber", runtime.DataType.U32, [], []);
      } catch {
        return 0;
      }
    },
    getMonotonicTickMs() {
      if (closed) return null;
      try {
        const tick = load<number>(KERNEL_LIBRARY, "GetTickCount64", runtime.DataType.U64, [], []);
        return Number.isSafeInteger(tick) && tick >= 0 ? tick : null;
      } catch {
        return null;
      }
    },
    areKeysReleased(triggerKeys) {
      if (closed) return null;
      const virtualKeys = new Set<number>([
        0xa2, 0xa3, 0xa4, 0xa5, 0xa0, 0xa1, 0x5b, 0x5c,
        ...triggerKeys.map((key) => key === "Enter" ? 0x0d : 0x56),
      ]);
      try {
        for (const virtualKey of virtualKeys) {
          const state = load<number>(
            USER_LIBRARY, "GetAsyncKeyState", runtime.DataType.I16,
            [runtime.DataType.I32], [virtualKey],
          );
          if (!Number.isInteger(state)) return null;
          if ((state & 0x8000) !== 0) return false;
        }
        return true;
      } catch {
        return null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const library of opened.reverse()) {
        try { runtime.close(library); } catch { /* process shutdown is fail closed */ }
      }
    },
  };
}
