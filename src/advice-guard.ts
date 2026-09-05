/**
 * The advice boundary, in one place because two copies would drift.
 *
 * This auditor reports what the signed transcript establishes. It has no view
 * on whether a deal is sound, and could not have one: a signature says who
 * wrote a frame and never whether the deal is real, no frame is evidence money
 * moved, and the rail — which this tool never looks at — is the only authority
 * on any of it.
 *
 * The structural lines cannot cross that boundary; they are assembled from
 * fixed strings. A generated sentence can, which is why this list exists as a
 * runtime guard and not only as a test. `describe()` runs every candidate
 * sentence through it and discards anything that trips it.
 */

/**
 * Words that turn a statement about the transcript into a claim about the deal.
 *
 * Two groups, and the distinction matters when adding to the list:
 *   - verdicts on a counterparty or an offer (legitimate, scam, trustworthy);
 *   - recommendations to the reader (should, recommend, avoid, safe to).
 *
 * Deliberately not here: "refused", "rejected", "unresolved", "missing",
 * "anomaly". Those describe the transcript and are the whole vocabulary of a
 * finding.
 */
export const ADVICE_PATTERNS: readonly RegExp[] = [
  /\blegitimate\b/i,
  /\billegitimate\b/i,
  /\btrustworthy\b/i,
  /\buntrustworthy\b/i,
  /\bscam\b/i,
  /\bfraud(ulent)?\b/i,
  /\bstolen\b/i,
  /\bmalicious\b/i,
  /\bsafe to\b/i,
  /\bunsafe\b/i,
  /\brisky\b/i,
  /\brecommend(ed|ation)?\b/i,
  /\bshould (accept|reject|avoid|take|trust|walk|proceed)\b/i,
  /\bavoid (this|the|these)\b/i,
  /\bdo not (accept|trust|engage)\b/i,
  /\bprobably (a|an|the)\b/i,
  /\blikely (a )?(scam|fraud|theft)\b/i,
  /\bthe (payer|payee) (is|was) (dishonest|lying|cheating)\b/i,
];

/** True when the text crosses from describing the transcript into judging the deal. */
export function containsAdvice(text: string): boolean {
  return ADVICE_PATTERNS.some((pattern) => pattern.test(text));
}

/** The first pattern that tripped, for reporting why a sentence was discarded. */
export function adviceReason(text: string): string | null {
  const hit = ADVICE_PATTERNS.find((pattern) => pattern.test(text));
  return hit === undefined ? null : String(hit);
}
