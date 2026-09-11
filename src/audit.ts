import {
  openContract,
  applyFrame,
  type ContractState,
  type StepResult,
  type TclkStatus,
} from '@flop-labs/tclk';
import type { FrameRecord, FrameRejection } from './frames.js';
import type { ContractThread, ThreadIndex } from './threads.js';

/**
 * Running the normative state machine over each thread and reporting what the
 * transcript establishes.
 *
 * The state machine is `applyFrame` from `@flop-labs/tclk`. SPEC §4 describes
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
  /**
   * A line the decoder accepted and the shape check in frames.ts refused. Its
   * frame never reached the state machine.
   */
  | 'frame-rejected-shape'
  /**
   * The machine refused a transition, and no open root in its contract's chain
   * explains it. Severity anomaly, counted in `transitionsRejected`.
   *
   * Two other findings share this code and are counted in neither total. At
   * anomaly level, an offer that decoded but would not open a contract. At
   * notice level, a frame whose timestamp did not parse, which was not applied.
   * Count roots by `transitionsRejected`, never by this code alone.
   */
  | 'transition-rejected'
  /**
   * The machine refused a transition for the status it was in, and an earlier
   * refusal on the same contract opened a root in that same status. The
   * status belongs to the offer's machine. Reported, not counted. See the
   * chain rule in `audit`.
   */
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
   * For a blocked transition: the seq of the open root in its contract's chain.
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
   * in the first 20%. Every one was a contract whose offer the ring had already
   * dropped, and none was an actual orphan. STATED [RETENTION]: rooms are a
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

/**
 * The machine's messages for a frame that arrived in the wrong status for it.
 * STATED in 0.1.0's machine.js (lines 54, 95, 110, 124, 135 and 147). Every
 * other refusal names what else was wrong.
 */
const STATUS_REFUSAL =
  /^(accept|lock|reveal|refund|cancel) in status (proposed|accepted|locked|claimed|refunded|cancelled)$/;

function isStatusRefusal(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return STATUS_REFUSAL.test(reason) || reason === 'receipt before a terminal status';
}

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
      code: rejection.refusedBy === 'shape-check' ? 'frame-rejected-shape' : 'frame-rejected',
      severity: 'notice',
      subject: `seq ${rejection.seq}`,
      seq: rejection.seq,
      // The refusal as scanRecords built it. Only fixed text is kept, and every
      // part a stranger chose is shown as its length and hash.
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
     * The chain rule: which refusals are root causes and which are their
     * consequences.
     *
     * When a transition is refused the state does not move, and a later frame
     * that needed it is refused for the stale status. A lock lands "in status
     * proposed" because the accept before it never applied. Counting that lock
     * as its own fault multiplies one root cause.
     *
     * MEASURED: an early probe of this data mis-parsed timestamps and evaluated
     * every frame at the present moment, which failed 2,757 accepts as "offer
     * has expired". Those alone produced 4,863 downstream refusals. Locks,
     * reveals and receipts were all refused "in status proposed", and the
     * report read as though the ecosystem were broken. It was one bug, seen
     * 7,620 times. The distinction is kept structurally so no future reader
     * has to rediscover it.
     *
     * INFERRED, and this package's own decision. Neither tclk's SPEC.md nor
     * technocore.chat says when a refusal is the consequence of an earlier one.
     *   - Chains are kept per contract, the id each frame names. STATED [SPEC.md
     *     section 4, 0.1.0]: the machine runs "Per contract". A thread keyed on
     *     an offer id can hold frames that name several.
     *   - A refusal for any reason other than status is an anomaly, always, and
     *     carries no `causedBy`. When its contract has no open root, it becomes
     *     one.
     *   - A status refusal is a consequence of its contract's open root, when
     *     there is one.
     *   - A root remembers the status it was opened in, and stays open only
     *     while the machine is still in that status. The machine keeps one
     *     status for the offer, so a transition that moves it closes every
     *     root, whichever contract its frame named. A receipt moves nothing.
     *   - A status refusal with no open root is an anomaly and opens a root.
     *     So a status refusal after a transition that moved the status starts
     *     a new chain instead of joining the old one.
     *
     * STATED in 0.1.0's machine.js: for lock, reveal, refund, cancel and
     * receipt, the status is checked before anything else. A status refusal
     * can therefore hide another fault in the same frame. It is still chained.
     *
     * A known limit, left for a separate decision. A frame that arrives after
     * the status has moved past it is refused for the status. A late copy of
     * an accept, lock, reveal, refund or cancel is one such frame, and a
     * cancel sent after the lock is another. STATED [SPEC.md section 4, 0.1.0]:
     * "Duplicates and replays are rejections without state change". A receipt
     * copy is accepted again, and an offer copy is not folded.
     * When its contract has an open root, such a frame is chained to it, so its
     * `causedBy` names an unrelated refusal. With no root open, it is a root.
     * Telling a frame that came too late from one still waiting on a refused
     * transition needs the order of the statuses, which this rule does not use.
     */
    /** Each contract's latest root, and the status the machine was in then. */
    const roots = new Map<string, { readonly seq: bigint; readonly status: TclkStatus }>();

    for (const record of thread.frames) {
      if (record.frame.type === 'offer') continue;

      if (!Number.isFinite(record.tsMs)) {
        // Not applied, so neither a root nor a consequence, and counted in
        // neither total. It shares the code transition-rejected at notice
        // level. See that code's doc.
        threadFindings.push({
          code: 'transition-rejected',
          severity: 'notice',
          subject: thread.key,
          seq: record.seq,
          detail: `frame timestamp ${record.ts} did not parse; not applied`,
        });
        continue;
      }

      const contract = record.frame.contract;
      // STATED in 0.1.0's dist/machine.js (line 48): applyFrame returns nothing
      // when a frame's type matches none of its cases. scanRecords refuses such
      // a frame before it gets here. This is a second guard, in case one
      // arrives some other way. No result is a refusal, and the state stays.
      const step: StepResult | undefined = applyFrame(state, record.frame, record.tsMs);
      if (step?.ok === true) {
        accepted += 1;
        state = step.state;
        continue;
      }
      const reason = step === undefined ? 'the state machine returned no result' : step.reason;

      const latest = roots.get(contract);
      const root = latest !== undefined && latest.status === state.status ? latest.seq : undefined;
      if (root !== undefined && isStatusRefusal(reason)) {
        blocked += 1;
        threadFindings.push({
          code: 'transition-blocked',
          severity: 'info',
          subject: thread.key,
          seq: record.seq,
          detail: `${record.frame.type} refused: ${reason ?? 'no reason given'}`,
          causedBy: root,
        });
      } else {
        rejected += 1;
        if (root === undefined) roots.set(contract, { seq: record.seq, status: state.status });
        threadFindings.push({
          code: 'transition-rejected',
          severity: 'anomaly',
          subject: thread.key,
          seq: record.seq,
          detail: `${record.frame.type} refused: ${reason ?? 'no reason given'}`,
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
