export const SELECTION_KEY_RELEASE_WINDOW_MS = 500;
const KEY_STATE_POLL_INTERVAL_MS = 5;

export type SelectionKeyReleaseDecision =
  | { readonly kind: "continue"; readonly operationBudgetMs: number }
  | { readonly kind: "blocked"; readonly reasonCode: "key_held" | "key_state_unavailable" | "selection_clock_unavailable" | "selection_cancelled" };

export type SelectionHelperDeadline =
  | { readonly kind: "include"; readonly deadlineTickMs: number }
  | { readonly kind: "expired"; readonly selectionBudgetMs: 0 }
  | { readonly kind: "unavailable" };

/** Includes the helper fence only when the commit starts before the selection cutoff. */
export function selectionHelperDeadlineAtCommit(
  nowTickMs: number | null,
  selectionDeadlineTickMs: number,
): SelectionHelperDeadline {
  if (!Number.isSafeInteger(nowTickMs) || !Number.isSafeInteger(selectionDeadlineTickMs)) {
    return { kind: "unavailable" };
  }
  if (nowTickMs! >= selectionDeadlineTickMs) return { kind: "expired", selectionBudgetMs: 0 };
  return { kind: "include", deadlineTickMs: selectionDeadlineTickMs };
}

export interface SelectionKeyReleaseMonitor {
  /** Settles on the original cutoff or another terminal cancellation/failure, never on an early key-up. */
  readonly cutoff: Promise<SelectionKeyReleaseDecision>;
  waitForPreparation(): Promise<SelectionKeyReleaseDecision>;
  cancel(): void;
}

export type SelectionPreparationRaceResult<T> =
  | { readonly kind: "prepared"; readonly result: T }
  | { readonly kind: "blocked"; readonly decision: Extract<SelectionKeyReleaseDecision, { kind: "blocked" }> };

/** Stops pending preparation when the original key cutoff becomes terminal. */
export async function raceSelectionPreparation<T>(input: {
  readonly monitor: SelectionKeyReleaseMonitor;
  readonly preparation: Promise<T>;
  readonly cancelPreparation: () => Promise<unknown> | unknown;
}): Promise<SelectionPreparationRaceResult<T>> {
  const preparation = input.preparation.then(
    (result) => ({ kind: "prepared" as const, result }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const outcome = await Promise.race([
    input.monitor.cutoff.then((decision) => ({ kind: "cutoff" as const, decision })),
    preparation.then((result) => ({ kind: "preparation" as const, result })),
  ]);

  if (outcome.kind === "cutoff") {
    if (outcome.decision.kind === "blocked") {
      await input.cancelPreparation();
      return { kind: "blocked", decision: outcome.decision };
    }
    const prepared = await preparation;
    if (prepared.kind === "failed") throw prepared.error;
    return { kind: "prepared", result: prepared.result };
  }
  if (outcome.result.kind === "failed") throw outcome.result.error;
  return { kind: "prepared", result: outcome.result.result };
}

export type SelectionKeyReleaseScheduler = (callback: () => void, delayMs: number) => () => void;

/** Starts at selection time and latches the freshest pre-cutoff key sample. */
export function startSelectionKeyReleaseMonitor(input: {
  readonly selectionDeadlineAt: number;
  readonly selectionDeadlineTickMs: number;
  readonly nowAt: () => number;
  readonly nowTickMs: () => number | null;
  readonly keysReleased: () => boolean | null;
  readonly isCurrent?: () => boolean;
  readonly schedule?: SelectionKeyReleaseScheduler;
}): SelectionKeyReleaseMonitor {
  const schedule = input.schedule ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  });
  let latestKeySample: { readonly keysReleased: boolean; readonly at: number; readonly tickMs: number } | null = null;
  let terminalDecision: SelectionKeyReleaseDecision | null = null;
  let timerCancel: (() => void) | null = null;
  let cancelled = false;
  let resolveCutoff!: (decision: SelectionKeyReleaseDecision) => void;
  const cutoff = new Promise<SelectionKeyReleaseDecision>((resolve) => { resolveCutoff = resolve; });
  const waiters = new Set<(decision: SelectionKeyReleaseDecision) => void>();

  const finish = (decision: SelectionKeyReleaseDecision): void => {
    if (terminalDecision) return;
    terminalDecision = decision;
    resolveCutoff(decision);
    timerCancel?.();
    timerCancel = null;
    for (const resolve of waiters) resolve(decision);
    waiters.clear();
  };

  const readClock = (): { readonly at: number; readonly tickMs: number } | null => {
    const nowAt = input.nowAt();
    const nowTickMs = input.nowTickMs();
    if (
      !Number.isFinite(input.selectionDeadlineAt) ||
      !Number.isSafeInteger(input.selectionDeadlineTickMs) ||
      !Number.isFinite(nowAt) ||
      nowTickMs === null ||
      !Number.isSafeInteger(nowTickMs)
    ) return null;
    return { at: nowAt, tickMs: nowTickMs };
  };

  const remainingMs = (): number | null => {
    const now = readClock();
    if (!now) return null;
    return Math.min(input.selectionDeadlineAt - now.at, input.selectionDeadlineTickMs - now.tickMs);
  };

  const continueWaiters = (): void => {
    const decision: SelectionKeyReleaseDecision = {
      kind: "continue",
      operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS,
    };
    for (const resolve of waiters) resolve(decision);
    waiters.clear();
  };

  const cutoffDecision = (): SelectionKeyReleaseDecision => {
    const now = readClock();
    if (!now) return { kind: "blocked", reasonCode: "selection_clock_unavailable" };
    const lateAtMs = now.at - input.selectionDeadlineAt;
    const lateTickMs = now.tickMs - input.selectionDeadlineTickMs;
    if (lateAtMs > KEY_STATE_POLL_INTERVAL_MS || lateTickMs > KEY_STATE_POLL_INTERVAL_MS) {
      return { kind: "blocked", reasonCode: "key_state_unavailable" };
    }
    // A last-moment re-press may happen after the previous poll. A post-cutoff
    // down state is conservative evidence to block; an up state cannot prove
    // when the key was released, so only the pre-cutoff sample can continue.
    const keysReleasedAtDecision = input.keysReleased();
    if (keysReleasedAtDecision === null) return { kind: "blocked", reasonCode: "key_state_unavailable" };
    if (!keysReleasedAtDecision) return { kind: "blocked", reasonCode: "key_held" };
    const afterDecisionSample = readClock();
    if (!afterDecisionSample) return { kind: "blocked", reasonCode: "selection_clock_unavailable" };
    if (
      afterDecisionSample.at - input.selectionDeadlineAt > KEY_STATE_POLL_INTERVAL_MS ||
      afterDecisionSample.tickMs - input.selectionDeadlineTickMs > KEY_STATE_POLL_INTERVAL_MS
    ) return { kind: "blocked", reasonCode: "key_state_unavailable" };
    const sample = latestKeySample;
    if (
      !sample ||
      sample.at >= input.selectionDeadlineAt ||
      sample.tickMs >= input.selectionDeadlineTickMs ||
      input.selectionDeadlineAt - sample.at > KEY_STATE_POLL_INTERVAL_MS ||
      input.selectionDeadlineTickMs - sample.tickMs > KEY_STATE_POLL_INTERVAL_MS
    ) return { kind: "blocked", reasonCode: "key_state_unavailable" };
    return sample.keysReleased
      ? { kind: "continue", operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS }
      : { kind: "blocked", reasonCode: "key_held" };
  };

  const sampleKeysBeforeCutoff = ():
    | { readonly kind: "sample"; readonly keysReleased: boolean }
    | { readonly kind: "cutoff" }
    | { readonly kind: "blocked"; readonly reasonCode: "key_state_unavailable" | "selection_clock_unavailable" } => {
    const before = readClock();
    if (!before) return { kind: "blocked", reasonCode: "selection_clock_unavailable" };
    if (before.at >= input.selectionDeadlineAt || before.tickMs >= input.selectionDeadlineTickMs) {
      return { kind: "cutoff" };
    }
    const keysReleased = input.keysReleased();
    const after = readClock();
    if (!after) return { kind: "blocked", reasonCode: "selection_clock_unavailable" };
    if (keysReleased === null) return { kind: "blocked", reasonCode: "key_state_unavailable" };
    // A key query that straddles the deadline is not a proven pre-cutoff sample.
    if (after.at >= input.selectionDeadlineAt || after.tickMs >= input.selectionDeadlineTickMs) {
      return { kind: "cutoff" };
    }
    latestKeySample = { keysReleased, at: after.at, tickMs: after.tickMs };
    return { kind: "sample", keysReleased };
  };

  const poll = (): void => {
    timerCancel = null;
    if (cancelled || terminalDecision) return;
    if (input.isCurrent && !input.isCurrent()) {
      finish({ kind: "blocked", reasonCode: "selection_cancelled" });
      return;
    }
    const remaining = remainingMs();
    if (remaining === null) {
      finish({ kind: "blocked", reasonCode: "selection_clock_unavailable" });
      return;
    }
    if (remaining <= 0) {
      // Sampling after the cutoff could accept a key released too late.
      finish(cutoffDecision());
      return;
    }
    const sample = sampleKeysBeforeCutoff();
    if (sample.kind === "blocked") {
      finish({ kind: "blocked", reasonCode: sample.reasonCode });
      return;
    }
    if (sample.kind === "cutoff") {
      finish(cutoffDecision());
      return;
    }
    const remainingAfterSample = remainingMs();
    if (remainingAfterSample === null) {
      finish({ kind: "blocked", reasonCode: "selection_clock_unavailable" });
      return;
    }
    if (remainingAfterSample <= 0) {
      finish(cutoffDecision());
      return;
    }
    if (sample.keysReleased) continueWaiters();
    timerCancel = schedule(poll, Math.max(1, Math.min(KEY_STATE_POLL_INTERVAL_MS, Math.floor(remainingAfterSample))));
  };

  const waitForPreparation = (): Promise<SelectionKeyReleaseDecision> => {
    if (terminalDecision) return Promise.resolve(terminalDecision);
    if (cancelled || (input.isCurrent && !input.isCurrent())) {
      finish({ kind: "blocked", reasonCode: "selection_cancelled" });
      return Promise.resolve(terminalDecision!);
    }
    const remaining = remainingMs();
    if (remaining === null) {
      finish({ kind: "blocked", reasonCode: "selection_clock_unavailable" });
      return Promise.resolve(terminalDecision!);
    }
    if (remaining <= 0) {
      finish(cutoffDecision());
      return Promise.resolve(terminalDecision!);
    }
    const sample = sampleKeysBeforeCutoff();
    if (sample.kind === "blocked") {
      finish({ kind: "blocked", reasonCode: sample.reasonCode });
      return Promise.resolve(terminalDecision!);
    }
    if (sample.kind === "cutoff") {
      finish(cutoffDecision());
      return Promise.resolve(terminalDecision!);
    }
    const remainingAfterSample = remainingMs();
    if (remainingAfterSample === null) {
      finish({ kind: "blocked", reasonCode: "selection_clock_unavailable" });
      return Promise.resolve(terminalDecision!);
    }
    if (remainingAfterSample <= 0) {
      finish(cutoffDecision());
      return Promise.resolve(terminalDecision!);
    }
    if (sample.keysReleased) {
      continueWaiters();
      return Promise.resolve({
        kind: "continue",
        operationBudgetMs: SELECTION_KEY_RELEASE_WINDOW_MS,
      });
    }
    return new Promise((resolve) => waiters.add(resolve));
  };

  // Establish the first sample and timer synchronously at selection start.
  poll();
  return {
    cutoff,
    waitForPreparation,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      timerCancel?.();
      timerCancel = null;
      if (!terminalDecision) finish({ kind: "blocked", reasonCode: "selection_cancelled" });
    },
  };
}
