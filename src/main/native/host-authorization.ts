import type { NativeResult, NativeTarget } from "../../shared/native-contracts";

export type HelperReady = Extract<NativeResult, { status: "ready" }>;

export interface HelperProcessBinding {
  pid: number;
}

export interface HostAuthorizationApi {
  getProcessIdentity(pid: number): { pid: number; processCreatedAt: string } | null;
  getForegroundWindow(): NativeTarget | null;
  allowSetForegroundWindow(pid: number): boolean;
  getClipboardSequenceNumber(): number;
}

export type AuthorizationOutcome =
  | "authorized"
  | "helper_identity_mismatch"
  | "host_not_foreground"
  | "authorization_denied";

/** Samples GetClipboardSequenceNumber at the selection boundary; 0 means unavailable. */
export function captureClipboardBaseline(api: HostAuthorizationApi): string | null {
  try {
    const sequence = api.getClipboardSequenceNumber();
    if (!Number.isInteger(sequence) || sequence <= 0 || sequence > 0xffffffff) return null;
    return String(sequence);
  } catch {
    return null;
  }
}

function sameWindow(left: NativeTarget | null, right: NativeTarget): boolean {
  return left !== null &&
    left.hwnd === right.hwnd &&
    left.pid === right.pid &&
    left.processCreatedAt === right.processCreatedAt;
}

function isReadyBinding(value: HelperReady): boolean {
  return Number.isInteger(value.helperPid) &&
    value.helperPid > 0 &&
    value.helperPid <= 0xffffffff &&
    typeof value.helperInstanceId === "string" &&
    value.helperInstanceId.length > 0 &&
    typeof value.helperProcessCreatedAt === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value.helperProcessCreatedAt);
}

/**
 * Checks the READY identity against the active child and Windows process identity before
 * authorizing it. The bridge is injected so unit tests can verify call counts without
 * invoking Win32 or interacting with the user's foreground window.
 */
export class HostAuthorizationGate {
  authorize(
    ready: HelperReady,
    activeHelper: HelperProcessBinding,
    hostWindow: NativeTarget,
    api: HostAuthorizationApi,
  ): AuthorizationOutcome {
    if (
      !isReadyBinding(ready) ||
      ready.helperPid !== activeHelper.pid
    ) {
      return "helper_identity_mismatch";
    }

    const processIdentity = api.getProcessIdentity(activeHelper.pid);
    if (
      !processIdentity ||
      processIdentity.pid !== activeHelper.pid ||
      processIdentity.processCreatedAt !== ready.helperProcessCreatedAt
    ) {
      return "helper_identity_mismatch";
    }

    if (!sameWindow(api.getForegroundWindow(), hostWindow)) {
      return "host_not_foreground";
    }

    // Each paste authorization is a separate, fresh decision. A prior ASFW call
    // does not persist while the foreground host or helper process can change.
    return api.allowSetForegroundWindow(ready.helperPid)
      ? "authorized"
      : "authorization_denied";
  }
}
