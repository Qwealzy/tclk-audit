import { appendFileSync } from 'node:fs';
import type { InferenceAdapter, InferenceRequest, InferenceResult } from './types.js';

/**
 * Accounting: what every call cost, in the units the provider reports.
 *
 * STORE UNITS, DERIVE COST. Prices change, and a table of dollars cannot be
 * re-priced. Store `{inputTokens, outputTokens, cacheReadTokens}` with the
 * model and the timestamp, keep the price table separate and versioned, and
 * "what did this cost last month, at today's prices, on a different model"
 * stays answerable. Store dollars and none of those questions survive.
 *
 * Failures are recorded too. A call that errored still consumed time, may have
 * consumed tokens, and is the thing you want to count when a run looks
 * expensive for no visible output.
 *
 * `cacheReadTokens` earns its place by itself: if it stays zero across calls
 * that share a prefix, something is silently invalidating the cache, and that
 * is usually the largest single cost lever. It is invisible without a field.
 *
 * The wrapper is where accounting lives rather than inside each adapter, so an
 * adapter cannot forget to record — including the stub. A stub that bypassed
 * the ledger would prove nothing about the path the real adapter takes.
 */

export interface LedgerEntry {
  readonly ts: string;
  readonly tag: string;
  readonly adapter: string;
  readonly model: string;
  readonly stop: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Present only on a failed call; the class name, never the message. */
  readonly errorClass?: string;
}

export interface Ledger {
  record(entry: LedgerEntry): void;
  entries(): readonly LedgerEntry[];
}

/** Keeps everything in memory. Enough for a run; the file ledger outlives one. */
export class MemoryLedger implements Ledger {
  readonly #entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    this.#entries.push(entry);
  }

  entries(): readonly LedgerEntry[] {
    return this.#entries;
  }
}

/** Append-only JSONL. One record per call, never rewritten. */
export class FileLedger implements Ledger {
  readonly #path: string;
  readonly #mirror = new MemoryLedger();

  constructor(path: string) {
    this.#path = path;
  }

  record(entry: LedgerEntry): void {
    this.#mirror.record(entry);
    appendFileSync(this.#path, JSON.stringify(entry) + '\n', 'utf8');
  }

  entries(): readonly LedgerEntry[] {
    return this.#mirror.entries();
  }
}

/**
 * Wraps any adapter so every call is recorded, successful or not.
 *
 * The returned object is an `InferenceAdapter`, so nothing downstream knows or
 * cares that accounting happened.
 */
export function withAccounting(adapter: InferenceAdapter, ledger: Ledger): InferenceAdapter {
  return {
    id: adapter.id,
    async complete(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
      const startedAt = Date.now();
      try {
        const result = await adapter.complete(request, signal);
        ledger.record(buildEntry(request, adapter.id, result));
        return result;
      } catch (error) {
        ledger.record({
          ts: new Date().toISOString(),
          tag: request.tag,
          adapter: adapter.id,
          model: 'unknown',
          stop: 'error',
          latencyMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          // The class, not the message: a provider error string can carry
          // prompt content, and a ledger is a file that gets shared.
          errorClass: error instanceof Error ? error.name : 'unknown',
        });
        throw error;
      }
    },
  };
}

function buildEntry(
  request: InferenceRequest,
  adapterId: string,
  result: InferenceResult,
): LedgerEntry {
  const entry: {
    ts: string;
    tag: string;
    adapter: string;
    model: string;
    stop: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {
    ts: new Date().toISOString(),
    tag: request.tag,
    adapter: adapterId,
    model: result.model,
    stop: result.stop,
    latencyMs: result.latencyMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
  if (result.usage.cacheReadTokens !== undefined) {
    entry.cacheReadTokens = result.usage.cacheReadTokens;
  }
  if (result.usage.cacheWriteTokens !== undefined) {
    entry.cacheWriteTokens = result.usage.cacheWriteTokens;
  }
  return entry;
}

export interface LedgerSummary {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly byTag: Readonly<Record<string, number>>;
  readonly byAdapter: Readonly<Record<string, number>>;
}

/** Spend by tag and adapter. The question anyone actually asks of a ledger. */
export function summarise(ledger: Ledger): LedgerSummary {
  const byTag = new Map<string, number>();
  const byAdapter = new Map<string, number>();
  let calls = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const entry of ledger.entries()) {
    calls += 1;
    if (entry.errorClass !== undefined) failed += 1;
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    byTag.set(entry.tag, (byTag.get(entry.tag) ?? 0) + 1);
    byAdapter.set(entry.adapter, (byAdapter.get(entry.adapter) ?? 0) + 1);
  }

  return {
    calls,
    failed,
    inputTokens,
    outputTokens,
    byTag: Object.fromEntries(byTag),
    byAdapter: Object.fromEntries(byAdapter),
  };
}
