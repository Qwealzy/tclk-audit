import { isTclkLine, tryDecodeFrame, decodeFrame, type TclkFrame } from '@flop-labs/tclk';

/**
 * Reading tclk frames out of Technocore room messages.
 *
 * NOTHING HERE PARSES A FRAME.
 *
 * `@flop-labs/tclk` is the normative implementation: SPEC.md says the field
 * tables are "generated from schema/tclk1-frames.schema.json, the same artifact
 * the decoder uses", and that decoding is fail-closed — "a known frame type with
 * an unknown key, a missing field, or a malformed value is rejected, never
 * coerced". A second decoder written from the prose would be a second thing to
 * keep in step, and the first place the two disagreed is the place this auditor
 * would start reporting fiction.
 *
 * So this module does the part the library cannot: it turns a room message into
 * an auditable record, keeping the transport facts (seq, ts, sender, whether the
 * record is re-verifiable) beside the decoded frame.
 *
 * MEASURED 2026-09-05 against the full retained `tclk-offers` ring, 12,372
 * records: 12,149 frames decoded, 141 lines were not tclk at all, and 82 were
 * rejected — every rejection a schema violation the spec requires
 * (`unknown field on offer: contractId`, `missing field on accept: nonce`,
 * `claimByMs must be strictly before refundAfterMs`). The decoder handles live
 * traffic; the rejections are the fail-closed rule working.
 */

/** One room message that carried a frame, with the transport facts kept. */
export interface FrameRecord {
  readonly frame: TclkFrame;
  /** Total order within the room. The only ordering this auditor trusts. */
  readonly seq: bigint;
  /** Server-assigned wall clock. Parsed for the state machine's `nowMs`. */
  readonly tsMs: number;
  /** Raw timestamp as served, kept because `tsMs` is lossy (microseconds). */
  readonly ts: string;
  /**
   * The sender as the room reports it: a did:key on the signed lane, a
   * self-asserted nickname otherwise.
   *
   * STATED [IDENTITY]: unverified either way unless it is a did:key, and even
   * then it proves possession of a key and nothing more.
   */
  readonly from: string;
  /**
   * Whether the record carries a signature and can be re-verified offline.
   *
   * STATED [RENDERING]: a missing `sig` means "not re-verifiable", NOT
   * "invalid" — records written before the field existed do not have one.
   * STATED [patterns.md §6]: "An unsigned frame is data, not a commitment —
   * readers drop it." This auditor records the distinction rather than
   * silently trusting either.
   */
  readonly signed: boolean;
}

/** A line that looked like a frame and was refused by the normative decoder. */
export interface FrameRejection {
  readonly seq: bigint;
  readonly ts: string;
  readonly from: string;
  /** The decoder's own message. Never reworded — it names the exact field. */
  readonly reason: string;
}

export interface ScanResult {
  readonly frames: readonly FrameRecord[];
  readonly rejections: readonly FrameRejection[];
  /** Messages in the room that were not tclk lines at all. Not an error. */
  readonly nonFrameCount: number;
}

/** The shape this auditor needs from a room message, whatever produced it. */
export interface RoomRecord {
  readonly seq: bigint | number;
  readonly ts: string;
  readonly from: string;
  readonly text: string;
  readonly sig?: string;
}

/**
 * Parses a server timestamp.
 *
 * The server serves `2026-09-05T17:02:16.263436Z` — microsecond precision, and
 * already carrying the `Z`. Appending another one yields NaN, which a
 * `|| Date.now()` fallback then hides by silently evaluating every frame at the
 * present moment. That mistake made 94% of all transitions fail as "offer has
 * expired" in an early probe of this data, and it looked like a finding about
 * the ecosystem rather than a bug in the reader. Hence: no fallback. An
 * unparseable timestamp is returned as NaN and the caller must decide.
 */
export function parseServerTimestamp(ts: string): number {
  return Date.parse(ts);
}

export function scanRecords(records: Iterable<RoomRecord>): ScanResult {
  const frames: FrameRecord[] = [];
  const rejections: FrameRejection[] = [];
  let nonFrameCount = 0;

  for (const record of records) {
    // Untrusted content: a room message is a string a stranger typed. It is
    // only ever passed to the decoder, never interpreted here.
    if (typeof record.text !== 'string' || !isTclkLine(record.text)) {
      nonFrameCount += 1;
      continue;
    }

    const frame = tryDecodeFrame(record.text);
    if (frame === null) {
      rejections.push({
        seq: BigInt(record.seq),
        ts: record.ts,
        from: record.from,
        reason: rejectionReason(record.text),
      });
      continue;
    }

    frames.push({
      frame,
      seq: BigInt(record.seq),
      tsMs: parseServerTimestamp(record.ts),
      ts: record.ts,
      from: record.from,
      signed: typeof record.sig === 'string',
    });
  }

  return { frames, rejections, nonFrameCount };
}

/**
 * `tryDecodeFrame` returns null without saying why; `decodeFrame` throws with
 * the reason. Calling both is the only way to get a null result and an
 * explanation, and the explanation is the whole value of a rejection record.
 */
function rejectionReason(text: string): string {
  try {
    decodeFrame(text);
    return 'decoder disagreed with itself between tryDecodeFrame and decodeFrame';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
