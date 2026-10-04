const DWORD_MAX = 0xffff_ffff;

export type ClipboardSequenceGateResult<T> =
  | { readonly status: "captured"; readonly sequence: number; readonly value: T }
  | { readonly status: "captured_unstable"; readonly sequence: number; readonly value: T }
  | { readonly status: "captured_unavailable"; readonly value: T }
  | { readonly status: "skipped"; readonly sequence: number }
  | { readonly status: "in_progress"; readonly sequence: number };

/**
 * Avoids rereading clipboard contents when Windows reports an unchanged
 * sequence number. Sequence reads are injected so the state machine can be
 * exercised without touching the system clipboard.
 */
export class ClipboardSequenceGate {
  private processedSequence: number | null = null;
  private readonly activeSequences = new Set<number>();
  private generation = 0;

  async capture<T>(
    readSequence: () => unknown,
    readContents: () => T | Promise<T>,
  ): Promise<ClipboardSequenceGateResult<T>> {
    const before = this.readValidSequence(readSequence);
    if (before === null) {
      return { status: "captured_unavailable", value: await readContents() };
    }

    if (this.processedSequence === before) return { status: "skipped", sequence: before };
    if (this.activeSequences.has(before)) return { status: "in_progress", sequence: before };

    const generation = this.generation;
    this.activeSequences.add(before);
    try {
      const value = await readContents();
      const after = this.readValidSequence(readSequence);
      if (after !== before || generation !== this.generation) {
        return { status: "captured_unstable", sequence: before, value };
      }
      this.processedSequence = before;
      return { status: "captured", sequence: before, value };
    } finally {
      this.activeSequences.delete(before);
    }
  }

  /** Mark a sequence produced by this app's own clipboard write as handled. */
  markProcessed(sequence: unknown): boolean {
    if (!isDwordSequence(sequence)) return false;
    this.generation += 1;
    this.processedSequence = sequence;
    return true;
  }

  /** Forget a failed downstream capture only when it still owns the cache entry. */
  forgetProcessed(sequence: unknown): boolean {
    if (!isDwordSequence(sequence) || this.processedSequence !== sequence) return false;
    this.generation += 1;
    this.processedSequence = null;
    return true;
  }

  private readValidSequence(readSequence: () => unknown): number | null {
    try {
      const sequence = readSequence();
      return isDwordSequence(sequence) ? sequence : null;
    } catch {
      return null;
    }
  }
}

function isDwordSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= DWORD_MAX;
}
