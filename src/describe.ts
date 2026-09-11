import type { Finding } from './audit.js';
import { containsAdvice, adviceReason } from './advice-guard.js';
import type { InferenceAdapter } from './inference/types.js';

/**
 * The one place this agent calls a model. It turns a finding into a sentence.
 *
 * It is the smallest useful consumer. Every structural conclusion is already
 * made before this runs. A description adds readability and nothing else,
 * which is what makes it safe to lose.
 *
 * TWO RULES, BOTH ENFORCED HERE RATHER THAN DOCUMENTED.
 *
 * 1. The model never sees a frame. The prompt carries the finding, its code,
 *    severity, subject and the structural detail line, and nothing more. It
 *    cannot see the offer's amount, asset, rails or deadlines, so it cannot
 *    opine on them. The boundary is enforced by what is in scope, not by
 *    asking the model nicely. Whatever it writes, it is writing about a
 *    finding, because that is all it was given.
 *
 * 2. Failure degrades, never blocks. No adapter, an unreachable model, a
 *    refusal, an empty answer, or a sentence that trips the advice guard. All
 *    of them return null and the caller renders the structural line it already
 *    had. The agent must run to completion with zero inference available,
 *    because that is how it will usually run.
 */

const SYSTEM = [
  'You restate one audit finding as a single plain sentence, under 200 characters.',
  '',
  'The finding is about the structure of a signed message transcript for a contract',
  'protocol. You are given the finding only. You cannot see the contract terms, the',
  'amounts, the parties, or any message content, because they were not provided.',
  '',
  'Rules:',
  '- Describe only what the finding says. Add no cause, motive, or consequence.',
  '- Never judge whether a deal is sound, safe, honest, or worth taking.',
  '- Never advise the reader to do anything.',
  '- If the finding is not enough to write a sentence about, reply exactly: SKIP',
  '',
  'Reply with the sentence alone. No preamble, no quotes, no markdown.',
].join('\n');

export interface DescribeOptions {
  /** Absent means no inference is configured. That is a supported mode. */
  readonly adapter?: InferenceAdapter;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export type DescribeSkipReason =
  | 'no-adapter'
  | 'unavailable'
  | 'refused'
  | 'empty'
  | 'model-said-skip'
  | 'too-long'
  | 'advice-guard';

export interface DescribeResult {
  /** The sentence, or null when none could be produced for any reason. */
  readonly text: string | null;
  readonly skipped: DescribeSkipReason | null;
  /** Set when the advice guard rejected the sentence; names the pattern. */
  readonly guardPattern?: string;
}

/**
 * Renders the finding into the prompt.
 *
 * Everything passed here comes from the auditor's own structured output, never
 * from a room message. No text a stranger put in a refused frame reaches the
 * model. `scanRecords` rebuilds each decoder refusal from the decoder's fixed
 * text, and a field name, a field value or a frame type appears only as its
 * byte length and SHA-256 (`rebuildRefusal` in frames.ts). A test sends such
 * findings through here and checks the request.
 *
 * Two strings a stranger chose can still reach a detail line. A rejected
 * frame's sender is appended as `(from ...)`. It is a did:key, or a name the
 * live service limits to lowercase letters, digits, `_` and `-`, and this
 * reader only percent-encodes it. And the state machine repeats a rail name in
 * "rail X was not offered". The decoder has already limited that name to
 * lowercase letters, digits, `.`, `_` and `-`.
 */
function promptFor(finding: Finding): string {
  return [
    `code: ${finding.code}`,
    `severity: ${finding.severity}`,
    `subject: ${finding.subject}`,
    finding.seq === null ? 'seq: none' : `seq: ${finding.seq}`,
    `detail: ${finding.detail}`,
  ].join('\n');
}

export async function describeFinding(
  finding: Finding,
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  const adapter = options.adapter;
  if (adapter === undefined) return { text: null, skipped: 'no-adapter' };

  const maxChars = options.maxChars ?? 200;

  let text: string;
  try {
    const requestOptions: Parameters<InferenceAdapter['complete']>[0] = {
      system: SYSTEM,
      messages: [{ role: 'user', content: promptFor(finding) }],
      maxOutputTokens: 120,
      effort: 'low',
      tag: `describe:${finding.code}`,
    };
    const result = await adapter.complete(requestOptions, options.signal);

    if (result.stop === 'refused' || result.stop === 'error') {
      return { text: null, skipped: 'refused' };
    }
    text = result.text.trim();
  } catch {
    // Unreachable provider, timeout, transport error, anything. One outcome:
    // there is no sentence, and the caller carries on with the structural line.
    return { text: null, skipped: 'unavailable' };
  }

  if (text.length === 0) return { text: null, skipped: 'empty' };
  if (/^SKIP\b/i.test(text)) return { text: null, skipped: 'model-said-skip' };

  // Single line: a finding renders as one room message, and a sentence with a
  // newline in it would be swept to a space anyway. Normalising here keeps the
  // guard checking the same string the caller will publish.
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxChars) return { text: null, skipped: 'too-long' };

  if (containsAdvice(text)) {
    // The one thing a model can do that the structural checks never would.
    // Discarded rather than edited: a sentence that had to be repaired to pass
    // is not one to trust with the part that passed.
    const pattern = adviceReason(text);
    return pattern === null
      ? { text: null, skipped: 'advice-guard' }
      : { text: null, skipped: 'advice-guard', guardPattern: pattern };
  }

  return { text, skipped: null };
}

/**
 * Describes many findings, never failing the batch.
 *
 * Returns one result per finding in the order given, so a caller can zip it
 * against its own list without tracking indices.
 */
export async function describeFindings(
  findings: readonly Finding[],
  options: DescribeOptions = {},
): Promise<readonly DescribeResult[]> {
  const results: DescribeResult[] = [];
  for (const finding of findings) {
    results.push(await describeFinding(finding, options));
  }
  return results;
}
