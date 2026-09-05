/**
 * The one interface every inference call goes through.
 *
 * One method, because an interface that cannot be re-implemented in an
 * afternoon will only ever have one implementation — and the whole point is
 * that swapping providers is an adapter change and nothing else. No call site
 * in this project imports a provider SDK; they take an `InferenceAdapter`.
 *
 * Not here, deliberately: streaming and tools. Both are real, both double the
 * surface, and nothing in this agent needs either. They go in as separate
 * optional methods when something does, and an adapter that omits them is
 * still an adapter.
 */

export type Role = 'user' | 'assistant';

export interface Turn {
  readonly role: Role;
  readonly content: string;
}

export interface InferenceRequest {
  readonly system?: string;
  readonly messages: readonly Turn[];
  readonly maxOutputTokens: number;
  /**
   * A hint, not a token budget.
   *
   * Providers express reasoning depth incompatibly, and a budget number is the
   * one thing guaranteed not to port. Three levels map onto anything; the
   * adapter decides what they mean.
   */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Free-form label recorded in the ledger: which task spent this. */
  readonly tag: string;
}

/**
 * Why generation stopped.
 *
 * `refused` is first-class because it is a real outcome with its own recovery.
 * A call site that folds it into `error` will retry something that will refuse
 * again.
 */
export type StopReason = 'complete' | 'max_output' | 'refused' | 'error';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Room for a provider that does not bill in tokens. */
  readonly unit: 'tokens';
}

export interface InferenceResult {
  readonly text: string;
  readonly stop: StopReason;
  /** Provider units, never normalised into money. See ledger.ts for why. */
  readonly usage: Usage;
  readonly model: string;
  readonly latencyMs: number;
  /**
   * Escape hatch. Typed `unknown`, so reaching into it needs a cast — which is
   * greppable, and is the actual enforcement of "no call site touches a
   * provider SDK". Not a convention: a compile error.
   */
  readonly raw?: unknown;
}

export interface InferenceAdapter {
  /** Stable identifier recorded against every call in the ledger. */
  readonly id: string;
  complete(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult>;
}

/**
 * Raised when an adapter cannot reach its provider at all.
 *
 * Distinguished from a refusal or a bad response because the caller's recovery
 * differs: this one means "there is no inference available right now", which
 * every consumer in this project must survive.
 */
export class AdapterUnavailableError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string, message: string, options?: { cause?: unknown }) {
    super(`${adapterId}: ${message}`);
    this.name = 'AdapterUnavailableError';
    this.adapterId = adapterId;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
