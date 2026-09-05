import type {
  InferenceAdapter,
  InferenceRequest,
  InferenceResult,
} from './types.js';

/**
 * A fixed-response adapter, for proving the seam without a provider.
 *
 * It reports usage like anything else, because it is wrapped by the same
 * accounting layer as a real adapter. A stub that bypassed the ledger would
 * exercise a path the production one never takes, and prove nothing about it.
 *
 * Token counts are a crude character estimate. They are honest about being an
 * estimate — the field says `tokens` and the model says `stub`, so nothing
 * downstream mistakes them for a provider's numbers.
 */
export interface StubOptions {
  /** Returned for every call unless `responses` matches the tag. */
  readonly defaultText?: string;
  /** Per-tag canned responses, so one stub can serve several call sites. */
  readonly responses?: Readonly<Record<string, string>>;
  /** Fails every call, to exercise the degradation path on demand. */
  readonly failWith?: Error;
  readonly latencyMs?: number;
}

export class StubAdapter implements InferenceAdapter {
  readonly id = 'stub';
  readonly #options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.#options = options;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    if (this.#options.failWith !== undefined) throw this.#options.failWith;

    const latencyMs = this.#options.latencyMs ?? 0;
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const text =
      this.#options.responses?.[request.tag] ??
      this.#options.defaultText ??
      'the transcript records this step and nothing further.';

    const promptChars =
      (request.system?.length ?? 0) +
      request.messages.reduce((total, turn) => total + turn.content.length, 0);

    return {
      text,
      stop: 'complete',
      model: 'stub',
      latencyMs,
      usage: {
        // ~4 chars per token is a rough public rule of thumb, and it is only
        // ever used to make the stub's ledger rows non-zero.
        inputTokens: Math.ceil(promptChars / 4),
        outputTokens: Math.ceil(text.length / 4),
        unit: 'tokens',
      },
    };
  }
}
