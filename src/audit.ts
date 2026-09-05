import { openContract, applyFrame, type ContractState, type TclkStatus } from '@flop-labs/tclk';
import type { FrameRecord, FrameRejection } from './frames.js';
import type { ContractThread, ThreadIndex } from './threads.js';

/**
 * Running the normative state machine over each thread and reporting what the
 * transcript establishes.
 *
 * The state machine is `applyFrame` from `@flop-labs/tclk` — SPEC §4 describes
 * it as "pure and fail-closed ... never throws mid-poll, never moves on an
 * invalid frame", and every guard the auditor would otherwise hand-write is
 * already in it. What this module adds is everything the machine cannot know,
 * because the machine sees one contract at a time and no room context:
 *
 *   1. which rejections are root causes and which are consequences;
 *   2. which apparent orphans are just the ring having forgotten their offer.
 *
 * Both were measured, not imagined. See the notes on each below.
 *
 * WHAT THIS DOES NOT DO: judge whether a deal is worth taking. Every finding
 * here is a statement about the shape of the signed transcript. "This contract
 * has no lock frame" is a fact; "this offer looks legitimate" would be advice,
 * and this auditor does not give it. SPEC §7 and patterns.md are both explicit
 * that a signature says who wrote a frame and never whether the deal is real,
 * and that no frame is evidence money moved.
 */

export type Severity = 'info' | 'notice' | 'anomaly';

export type FindingCode =
  /** A line that looked like a frame and failed the normative decoder. */
  | 'frame-rejected'
  /** The machine refused a transition, and nothing earlier explains it. */
  | 'transition-rejected'
  /** A transition failed only because an earlier one did. Reported, not counted. */
  | 'transition-blocked'
  /** An accept whose offer is not in the window, beyond the warm-up boundary. */
  | 'accept-without-offer'
  /** Frames naming a contract no accept in the window ever bound. */
  | 'unattributed-frames'
  /** A contract that reached a terminal status. */
  | 'contract-settled'
  /** Locked, past refundAfterMs, with neither reveal nor refund seen. */
  | 'lock-unresolved';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  /** The offer id, or the contract id where no offer was seen. */
  readonly subject: string;
  /** Room order of the frame this is about, when there is one. */
  readonly seq: bigint | null;
  /** Plain statement of what the transcript shows. Never a recommendation. */
  readonly detail: string;
  /**
   * For a blocked transition: the seq of the rejection that caused it.
   * Cascade findings are the only ones that carry this.
   */
  readonly causedBy?: bigint;
}

export interface AuditOptions {
  /**
   * Wall clock used for deadline checks that the machine does not make, such
   * as whether a lock is past its refund deadline. The machine itself is
   * always given each frame's own timestamp.
   */
  readonly nowMs: number;
  /**
   * Threads whose earliest frame falls within this fraction of the start of
   * the scanned window are not reported as orphans.
   *
   * MEASURED 2026-09-05 on the full retained `tclk-offers` ring: of 5 accepts
   * whose offer was absent, 4 were in the first 5% of the window and all 5 were
   * in the first 20% — every one of them a contract whose offer the ring had
   * already dropped, and none an actual orphan. STATED [RETENTION]: rooms are a
   * ring and old messages are dropped, so the beginning of any window is
   * always missing the frames that came before it. Reporting those as findings
   * would mean reporting the ring's own behaviour as other agents' misconduct.
   */
  readonly warmupFraction?: number;
}

export interface ThreadOutcome {
  readonly thread: ContractThread;
  readonly status: TclkStatus | 'unopened';
  readonly state: ContractState | null;
  readonly findings: readonly Finding[];
}

export interface AuditReport {
  readonly windowFirstSeq: bigint | null;
  readonly windowLastSeq: bigint | null;
  readonly threadCount: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly transitionsAccepted: number;
  readonly transitionsRejected: number;
  readonly transitionsBlocked: number;
  readonly outcomes: readonly ThreadOutcome[];
  readonly findings: readonly Finding[];
}

const DEFAULT_WARMUP_FRACTION = 0.2;

export function audit(
  index: ThreadIndex,
  rejections: readonly FrameRejection[],
  options: AuditOptions,
): AuditReport {
  const warmup = options.warmupFraction ?? DEFAULT_WARMUP_FRACTION;

  const allSeqs: bigint[] = [];
  for (const thread of index.threads) for (const r of thread.frames) allSeqs.push(r.seq);
  for (const r of index.unattributed) allSeqs.push(r.seq);
  for (const r of rejections) allSeqs.push(r.seq);

  const windowFirstSeq = allSeqs.length === 0 ? null : allSeqs.reduce((a, b) => (b < a ? b : a));
  const windowLastSeq = allSeqs.length === 0 ? null : allSeqs.reduce((a, b) => (b > a ? b : a));
  const warmupBoundary =
    windowFirstSeq === null || windowLastSeq === null
      ? null
      : windowFirstSeq +
        BigInt(Math.floor(Number(windowLastSeq - windowFirstSeq) * warmup));

  const findings: Finding[] = [];
  const outcomes: ThreadOutcome[] = [];
  const byStatus = new Map<string, number>();
  let accepted = 0;
  let rejected = 0;
  let blocked = 0;

  for (const rejection of rejections) {
    findings.push({
      code: 'frame-rejected',
      severity: 'notice',
      subject: `seq ${rejection.seq}`,
      seq: rejection.seq,
      // The decoder's own words. Rewording them would lose the field name,
      // which is the only actionable part.
      detail: `${rejection.reason} (from ${rejection.from})`,
    });
  }

  for (const thread of index.threads) {
    const threadFindings: Finding[] = [];

    if (thread.offer === null) {
      const beyondWarmup = warmupBoundary === null || thread.firstSeq > warmupBoundary;
      if (beyondWarmup) {
        threadFindings.push({
          code: 'accept-without-offer',
          severity: 'anomaly',
          subject: thread.key,
          seq: thread.firstSeq,
          detail:
            'frames reference an offer that is not in the scanned window, and the thread ' +
            'starts past the warm-up boundary, so the ring dropping it is not the explanation',
        });
      }
      byStatus.set('unopened', (byStatus.get('unopened') ?? 0) + 1);
      outcomes.push({ thread, status: 'unopened', state: null, findings: threadFindings });
      findings.push(...threadFindings);
      continue;
    }

    const offerFrame = thread.offer.frame;
    if (offerFrame.type !== 'offer') continue;

    let state: ContractState;
    try {
      state = openContract(offerFrame);
    } catch (error) {
      threadFindings.push({
        code: 'transition-rejected',
        severity: 'anomaly',
        subject: thread.key,
        seq: thread.offer.seq,
        detail: `offer decoded but would not open a contract: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      byStatus.set('unopened', (byStatus.get('unopened') ?? 0) + 1);
      outcomes.push({ thread, status: 'unopened', state: null, findings: threadFindings });
      findings.push(...threadFindings);
      continue;
    }

    /**
     * The cascade rule.
     *
     * Once a transition is refused the state does not move, so every later
     * frame is refused too — a lock lands "in status proposed" because the
     * accept before it never applied. Counting those as separate faults
     * multiplies one root cause into a thread's worth of noise.
     *
     * MEASURED: an early probe of this data mis-parsed timestamps and evaluated
     * every frame at the present moment, which failed 2,757 accepts as "offer
     * has expired". Those alone produced 4,863 downstream refusals — locks,
     * reveals and receipts all refused "in status proposed" — and the report
     * read as though the ecosystem were broken. It was one bug, seen 7,620
     * times. The distinction is kept structurally so no future reader has to
     * rediscover it.
     */
    let firstRejectionSeq: bigint | null = null;

    for (const record of thread.frames) {
      if (record.frame.type === 'offer') continue;

      if (!Number.isFinite(record.tsMs)) {
        threadFindings.push({
          code: 'transition-rejected',
          severity: 'notice',
          subject: thread.key,
          seq: record.seq,
          detail: `frame timestamp ${record.ts} did not parse; not applied`,
        });
        continue;
      }

      const step = applyFrame(state, record.frame, record.tsMs);
      if (step.ok) {
        accepted += 1;
        state = step.state;
        continue;
      }

      if (firstRejectionSeq === null) {
        rejected += 1;
        firstRejectionSeq = record.seq;
        threadFindings.push({
          code: 'transition-rejected',
          severity: 'anomaly',
          subject: thread.key,
          seq: record.seq,
          detail: `${record.frame.type} refused: ${step.reason ?? 'no reason given'}`,
        });
      } else {
        blocked += 1;
        threadFindings.push({
          code: 'transition-blocked',
          severity: 'info',
          subject: thread.key,
          seq: record.seq,
          detail: `${record.frame.type} refused: ${step.reason ?? 'no reason given'}`,
          causedBy: firstRejectionSeq,
        });
      }
    }

    if (state.status === 'locked' && offerFrame.refundAfterMs <= options.nowMs) {
      threadFindings.push({
        code: 'lock-unresolved',
        severity: 'notice',
        subject: thread.key,
        seq: thread.frames[thread.frames.length - 1]?.seq ?? null,
        detail:
          'locked, past refundAfterMs, and the window contains neither a reveal nor a refund. ' +
          'The transcript is silent on what happened; the rail is the only authority on it',
      });
    }

    byStatus.set(state.status, (byStatus.get(state.status) ?? 0) + 1);
    outcomes.push({ thread, status: state.status, state, findings: threadFindings });
    findings.push(...threadFindings);
  }

  if (index.unattributed.length > 0) {
    const first = index.unattributed.reduce((a, b) => (b.seq < a.seq ? b : a));
    const beyondWarmup = warmupBoundary === null || first.seq > warmupBoundary;
    findings.push({
      code: 'unattributed-frames',
      severity: beyondWarmup ? 'notice' : 'info',
      subject: 'window',
      seq: first.seq,
      detail:
        `${index.unattributed.length} frame(s) name a contract no accept in this window bound` +
        (beyondWarmup ? '' : '; the earliest is inside the warm-up boundary, so the ring is the likely cause'),
    });
  }

  return {
    windowFirstSeq,
    windowLastSeq,
    threadCount: index.threads.length,
    byStatus: Object.fromEntries(byStatus),
    transitionsAccepted: accepted,
    transitionsRejected: rejected,
    transitionsBlocked: blocked,
    outcomes,
    findings,
  };
}
