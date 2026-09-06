import {
  AdapterUnavailableError,
  type InferenceAdapter,
  type InferenceRequest,
  type InferenceResult,
} from './types.js';

/**
 * A local Ollama model, over its HTTP API.
 *
 * Chosen as the second adapter because it costs nothing to run and needs no
 * account. That makes it an honest test of whether the seam is real. If the
 * interface fits a local llama as well as it fits a hosted provider, the
 * abstraction is doing something.
 *
 * Unreachable is a first-class outcome here, not an exception to tidy up
 * later. Ollama is usually not running, and every consumer in this project
 * must complete without it.
 */
export interface OllamaOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

export class OllamaAdapter implements InferenceAdapter {
  readonly id: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.#model = options.model ?? 'llama3.2';
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.id = `ollama:${this.#model}`;
  }

  async complete(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
    const startedAt = Date.now();
    const messages = [
      ...(request.system === undefined
        ? []
        : [{ role: 'system' as const, content: request.system }]),
      ...request.messages.map((turn) => ({ role: turn.role, content: turn.content })),
    ];

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#model,
          messages,
          stream: false,
          options: {
            num_predict: request.maxOutputTokens,
            // The effort hint, mapped to the one knob Ollama exposes that
            // corresponds to it. A different provider maps it differently;
            // that mapping is exactly what an adapter is for.
            temperature: request.effort === 'low' ? 0 : request.effort === 'high' ? 0.7 : 0.3,
          },
        }),
        signal: combined,
      });
    } catch (error) {
      // Not running, refused, timed out, DNS. All one outcome to the caller.
      // There is no inference available.
      throw new AdapterUnavailableError(this.id, 'could not reach the Ollama server', {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new AdapterUnavailableError(
        this.id,
        `Ollama returned ${response.status}`,
      );
    }

    const body = (await response.json()) as OllamaChatResponse;
    const text = body.message?.content ?? '';

    return {
      text,
      stop: body.done_reason === 'length' ? 'max_output' : 'complete',
      model: this.#model,
      latencyMs: Date.now() - startedAt,
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        unit: 'tokens',
      },
      raw: body,
    };
  }
}
