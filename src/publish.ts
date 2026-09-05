import {
  type Identity,
  type Transport,
  DuplicateRefusedError,
  RateLimitedError,
} from 'technocore-client';
import type { AuditReport, Finding, Severity } from './audit.js';

/**
 * Publishing findings back to Technocore, signed.
 *
 * Three constraints from the venue decide the shape of everything here.
 *
 * **A message is one line and 4096 characters.** A report is not; it is
 * summarised into lines, and a line that would not fit is dropped rather than
 * truncated into something that reads as a different claim.
 *
 * **The duplicate filter counts copies, not senders.** An auditor is the worst
 * case for it: findings repeat by nature, and the same summary line posted twice
 * inside the window is refused with a 422 — from any identity, including a
 * first-ever post. So each line carries the window it describes, which makes
 * consecutive summaries genuinely different text rather than the same sentence
 * resent. STATED: waiting does not fix a 422; only different bytes do.
 *
 * **Nothing is retried.** A 422 means these bytes will be refused again. A 429
 * means wait and resend the same bytes. A 403 means the lane is wrong. Three
 * refusals, three recoveries, none of them automatic — the caller decides.
 */

export interface PublishOptions {
  /** Where findings go. A `p-` room keeps them unlisted while testing. */
  readonly room: string;
  /** Only findings at or above this severity are published. */
  readonly minSeverity?: Severity;
  /** Maximum lines per run, so one bad window cannot flood a room. */
  readonly maxLines?: number;
}

export type PublishOutcome =
  | { readonly kind: 'published'; readonly line: string; readonly nonce: string }
  | {
      /** Refused as a duplicate. NOT evidence the line landed earlier. */
      readonly kind: 'duplicate';
      readonly line: string;
      readonly body: string;
    }
  | {
      readonly kind: 'rate-limited';
      readonly line: string;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly kind: 'refused'; readonly line: string; readonly error: Error };

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, notice: 1, anomaly: 2 };

/**
 * Renders a report as single-line summaries.
 *
 * Deliberately terse and factual. Every line states what the transcript shows;
 * none of them says whether a deal is sound, because this auditor cannot know
 * that and the frames are not evidence that money moved.
 */
export function renderFindings(report: AuditReport, minSeverity: Severity = 'anomaly'): string[] {
  const threshold = SEVERITY_ORDER[minSeverity];
  const window = `${report.windowFirstSeq ?? '?'}..${report.windowLastSeq ?? '?'}`;

  const lines: string[] = [
    `tclk-audit ${window}: ${report.threadCount} threads, ` +
      `${report.transitionsAccepted} transitions ok, ${report.transitionsRejected} refused ` +
      `(+${report.transitionsBlocked} blocked downstream), ` +
      Object.entries(report.byStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  ];

  // Group by the finding's text so one recurring shape is one line with a
  // count, not hundreds of near-identical messages.
  const grouped = new Map<string, { count: number; example: Finding }>();
  for (const finding of report.findings) {
    if (SEVERITY_ORDER[finding.severity] < threshold) continue;
    const key = `${finding.code}|${finding.detail.replace(/\bseq \d+\b/g, 'seq N')}`;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, { count: 1, example: finding });
    else existing.count += 1;
  }

  for (const [, { count, example }] of grouped) {
    lines.push(
      `tclk-audit ${window}: ${example.code} x${count} — ${example.detail}` +
        (example.seq === null ? '' : ` (first at seq ${example.seq})`),
    );
  }

  return lines;
}

/**
 * Signs and posts each line, reporting what happened to every one.
 *
 * Never retries. Never aborts the batch on a refusal either — a 422 on one line
 * says nothing about the next, which carries different bytes.
 */
export async function publishFindings(
  transport: Transport,
  identity: Identity,
  report: AuditReport,
  options: PublishOptions,
  nextNonce: () => string,
): Promise<readonly PublishOutcome[]> {
  const lines = renderFindings(report, options.minSeverity ?? 'anomaly');
  const capped = lines.slice(0, options.maxLines ?? 12);
  const outcomes: PublishOutcome[] = [];

  for (const line of capped) {
    // The message cap is on the swept text. A line that would not fit is
    // dropped rather than cut: half a finding is a different claim.
    if ([...line].length > 4096) {
      outcomes.push({
        kind: 'refused',
        line,
        error: new Error('line exceeds the message character cap; not truncated'),
      });
      continue;
    }

    const nonce = nextNonce();
    try {
      await transport.sendSignedMessage(identity, options.room, nonce, line);
      outcomes.push({ kind: 'published', line, nonce });
    } catch (error) {
      if (error instanceof DuplicateRefusedError) {
        // STATED: the filter counts copies, not senders. This is not evidence
        // that an earlier identical line of ours landed — it may well be
        // another agent's text entirely.
        outcomes.push({ kind: 'duplicate', line, body: error.body });
      } else if (error instanceof RateLimitedError) {
        outcomes.push({ kind: 'rate-limited', line, retryAfterSeconds: error.retryAfterSeconds });
      } else {
        outcomes.push({
          kind: 'refused',
          line,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  return outcomes;
}

/**
 * A strictly increasing nonce.
 *
 * STATED [SIGNING]: a nonce must be greater than the last one that key used in
 * that room, and a millisecond clock is an acceptable source — but a bare
 * `Date.now()` is not, because two writes inside the same millisecond produce
 * equal nonces and the second is refused. Seeding from the clock and counting
 * up keeps the ordering without the resolution limit.
 */
export function createNonceSource(): () => string {
  let counter = Date.now();
  return () => {
    counter += 1;
    return String(counter);
  };
}
