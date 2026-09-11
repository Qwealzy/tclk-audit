import { isTclkLine, tryDecodeFrame, decodeFrame, type TclkFrame } from '@flop-labs/tclk';
import { parseRoomPage, verifyStoredMessage } from 'technocore-client';

/**
 * Reading tclk frames out of Technocore room messages.
 *
 * NOTHING HERE PARSES A FRAME.
 *
 * `@flop-labs/tclk` is the normative implementation. Its installed 0.1.0
 * SPEC.md says decoding is fail-closed, and that "a known frame
 * type with an unknown key, a missing field, or a malformed value is rejected,
 * never coerced". A second decoder written from the prose would be a second
 * thing to keep in step, and the first place the two disagreed is the place
 * this auditor would start reporting fiction.
 *
 * So this module does the part the library cannot. It turns a room message into
 * an auditable record, keeping the transport facts (seq, ts, sender, whether the
 * record is re-verifiable) beside the decoded frame.
 *
 * MEASURED 2026-09-05 against the full retained `tclk-offers` ring, 12,372
 * records: 12,149 frames decoded, 141 lines were not tclk at all, and 82 were
 * rejected. Every rejection is a schema violation the spec requires
 * (`unknown field on offer: contractId`, `missing field on accept: nonce`,
 * `claimByMs must be strictly before refundAfterMs`). The decoder handles live
 * traffic, and the rejections are the fail-closed rule working.
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
   *
   * Passed through `sanitizeReason`. A did:key or a plain name comes back
   * unchanged.
   */
  readonly from: string;
  /**
   * Whether the record carries a signature and can be re-verified offline.
   *
   * STATED [RENDERING]: a missing `sig` means "not re-verifiable", NOT
   * "invalid". Records written before the field existed do not have one.
   * STATED [patterns.md §6]: "An unsigned frame is data, not a commitment —
   * readers drop it." This auditor records the distinction rather than
   * silently trusting either.
   */
  readonly signed: boolean;
  /**
   * What checking the record's signature and sender found.
   *
   * STATED [SPEC.md section 2, tclk 0.1.0]: "`from` inside a frame is the
   * sender's `did:key`; it MUST match the transport-verified `from` of the
   * record that carried it. An unsigned frame is data, not a commitment".
   * Only `verified` is a commitment. Every other value is data.
   *
   * Nothing in this package acts on it yet. The audit still folds every
   * decoded frame, whatever this says. How to use it is a separate decision.
   */
  readonly verification: FrameVerification;
}

/**
 * The outcome of checking one record against SPEC.md section 2.
 *
 *   - `verified` means the signature verifies for the record's room, nonce and
 *     text, and the frame's `from` is the key that signed it.
 *   - `from-mismatch` means the signature verifies, and the frame's `from`
 *     names a different key.
 *   - `bad-signature` means the record carries a signature that does not
 *     verify.
 *   - `unsigned` means the record carries no signature.
 *   - `unverifiable` means the record carries a signature that cannot be
 *     checked here. The room was not given, or the nonce is missing or has
 *     already lost digits.
 */
export type FrameVerification =
  | 'verified'
  | 'from-mismatch'
  | 'bad-signature'
  | 'unsigned'
  | 'unverifiable';

/** A line that looked like a frame and was refused by the normative decoder. */
export interface FrameRejection {
  readonly seq: bigint;
  readonly ts: string;
  /** The sender, after `sanitizeReason`. See `FrameRecord.from`. */
  readonly from: string;
  /**
   * The decoder's own message, after `sanitizeReason`. Never reworded, so it
   * still names the exact field. Characters that could act on an output
   * surface are percent-encoded.
   */
  readonly reason: string;
}

/** A type or field that tclk builds after 0.1.0 accept and 0.1.0 refuses. */
export type DecoderGap = 'heartbeat' | 'reveal.ref' | 'refund.ref';

/**
 * Refusals by the installed 0.1.0 decoder that come from the decoder being
 * older than the frame. Each key is the decoder's exact message.
 *
 * STATED in tclk's source after 0.1.0 (commit 103a1b9, 2026-09-03):
 * `heartbeat` is a frame type, and `reveal` and `refund` take an optional
 * `ref`. PROBED 2026-09-11 against the installed 0.1.0: it refuses those three
 * frames with exactly these messages.
 *
 * The decoder stops at the first thing it refuses. A known gap says only that
 * the first refusal was one of these. The rest of the frame was not checked,
 * and a later decoder may still refuse it for something else.
 */
export const KNOWN_DECODER_GAPS: ReadonlyMap<string, DecoderGap> = new Map([
  ['tclk: unknown frame type: heartbeat', 'heartbeat'],
  ['tclk: unknown field on reveal: ref', 'reveal.ref'],
  ['tclk: unknown field on refund: ref', 'refund.ref'],
]);

/** A line the installed decoder refused for a reason in `KNOWN_DECODER_GAPS`. */
export interface KnownDecoderGap extends FrameRejection {
  readonly gap: DecoderGap;
}

export interface ScanResult {
  readonly frames: readonly FrameRecord[];
  /** Lines the decoder refused, apart from known decoder gaps. */
  readonly rejections: readonly FrameRejection[];
  /**
   * Lines the decoder refused for a known decoder gap. Kept apart from
   * `rejections`, so a frame that only a newer decoder reads is never reported
   * as malformed, and never goes uncounted either. A line here can still be
   * malformed in some other way. See `KNOWN_DECODER_GAPS`.
   */
  readonly knownGaps: readonly KnownDecoderGap[];
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
  /**
   * The signing nonce, as digits. It can run to 19 digits, past 2^53, so a
   * number here has often lost digits already. `parseExportLine` keeps it as a
   * string. A number is used only when it is a safe integer.
   */
  readonly nonce?: string | number;
}

export interface ScanOptions {
  /**
   * The room the records were read from. A signature covers
   * `<room>|<nonce>|<text>`, so without the room no signature can be checked,
   * and every signed frame comes back `unverifiable`.
   */
  readonly room?: string;
}

/**
 * Reads one line of a room's `/export` into a record.
 *
 * STATED [EXPORT], as technocore-client quotes it: "a stored nonce may be up to
 * 19 digits, which is past 2^53". `JSON.parse` rounds such a number, and a
 * rounded nonce fails a good signature. So the record is read through
 * technocore-client's `parseRoomPage`, which quotes `seq` and `nonce` digits
 * before it parses. The plain parse below only checks that the line is an
 * object with a string `text`, as the callers did before. A torn or malformed
 * line returns null.
 */
export function parseExportLine(line: string): RoomRecord | null {
  let plain: unknown;
  try {
    plain = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof plain !== 'object' || plain === null) return null;
  if (typeof (plain as { text?: unknown }).text !== 'string') return null;

  let message;
  try {
    message = parseRoomPage(`{"messages":[${line}]}`).messages[0];
  } catch {
    return null;
  }
  if (message === undefined) return null;

  const record: {
    seq: bigint;
    ts: string;
    from: string;
    text: string;
    sig?: string;
    nonce?: string;
  } = { seq: message.seq, ts: message.ts, from: message.from, text: message.text };
  if (message.sig !== undefined) record.sig = message.sig;
  if (message.nonce !== undefined) record.nonce = message.nonce;
  return record;
}

/**
 * Parses a server timestamp.
 *
 * The server serves `2026-09-05T17:02:16.263436Z`, microsecond precision and
 * already carrying the `Z`. Appending another one yields NaN, which a
 * `|| Date.now()` fallback then hides by silently evaluating every frame at the
 * present moment. That mistake made 94% of all transitions fail as "offer has
 * expired" in an early probe of this data, and it looked like a finding about
 * the ecosystem rather than a bug in the reader. So there is no fallback. An
 * unparseable timestamp is returned as NaN and the caller must decide.
 */
export function parseServerTimestamp(ts: string): number {
  return Date.parse(ts);
}

export function scanRecords(
  records: Iterable<RoomRecord>,
  options: ScanOptions = {},
): ScanResult {
  const frames: FrameRecord[] = [];
  const rejections: FrameRejection[] = [];
  const knownGaps: KnownDecoderGap[] = [];
  let nonFrameCount = 0;

  for (const record of records) {
    // Untrusted content: a room message is a string a stranger typed. It is
    // only ever passed to the decoder, never interpreted here.
    if (typeof record.text !== 'string' || !isTclkLine(record.text)) {
      nonFrameCount += 1;
      continue;
    }

    // The sender is room data as well. The live service only accepts a did:key
    // or a plain name, and neither changes here. This reader does not rely on
    // the service for that, so anything else is encoded like a reason.
    const from = sanitizeReason(String(record.from));

    const frame = tryDecodeFrame(record.text);
    if (frame === null) {
      const { reason, gap } = rejectionReason(record.text);
      const rejection = { seq: BigInt(record.seq), ts: record.ts, from, reason };
      if (gap === undefined) rejections.push(rejection);
      else knownGaps.push({ ...rejection, gap });
      continue;
    }

    frames.push({
      frame,
      seq: BigInt(record.seq),
      tsMs: parseServerTimestamp(record.ts),
      ts: record.ts,
      from,
      signed: typeof record.sig === 'string',
      verification: verificationOf(record, frame, options.room),
    });
  }

  return { frames, rejections, knownGaps, nonFrameCount };
}

/**
 * Checks one record against SPEC.md section 2 with technocore-client's
 * `verifyStoredMessage`. It compares the frame's `from` with the raw transport
 * `from`, before `sanitizeReason`, because that is the key the signature was
 * checked against.
 */
function verificationOf(
  record: RoomRecord,
  frame: TclkFrame,
  room: string | undefined,
): FrameVerification {
  if (typeof record.sig !== 'string') return 'unsigned';
  const nonce = exactNonce(record.nonce);
  if (room === undefined || nonce === null) return 'unverifiable';
  const signed = verifyStoredMessage({
    room,
    nonce,
    text: record.text,
    did: String(record.from),
    sig: record.sig,
  });
  if (!signed) return 'bad-signature';
  return frame.from === record.from ? 'verified' : 'from-mismatch';
}

/** The nonce as exact digits, or null when it is missing or has lost digits. */
function exactNonce(nonce: string | number | undefined): string | null {
  if (typeof nonce === 'string') return nonce;
  if (typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0) {
    return String(nonce);
  }
  return null;
}

/**
 * `tryDecodeFrame` returns null without saying why; `decodeFrame` throws with
 * the reason. Calling both is the only way to get a null result and an
 * explanation, and the explanation is the whole value of a rejection record.
 *
 * Every path out goes through `sanitizeReason`, so no caller ever holds the
 * raw message. The known-gap check reads the raw message, before it is encoded.
 */
function rejectionReason(text: string): { reason: string; gap: DecoderGap | undefined } {
  let raw: string;
  try {
    decodeFrame(text);
    raw = 'decoder disagreed with itself between tryDecodeFrame and decodeFrame';
  } catch (error) {
    raw = error instanceof Error ? error.message : String(error);
  }
  return { reason: sanitizeReason(raw), gap: KNOWN_DECODER_GAPS.get(raw) };
}

const UTF8 = new TextEncoder();

/** Printable ASCII that still has to be encoded. See `sanitizeReason`. */
const ENCODED_ASCII: ReadonlySet<string> = new Set(['%', '`', '|', '#']);

/**
 * Makes a rejection reason inert on every surface that prints it.
 *
 * The reason is the decoder's error message, and the decoder repeats an
 * unknown field name word for word. Whoever posted the frame chose that name.
 * It can carry line breaks, Markdown, and lines the GitHub runner reads as
 * workflow commands. This runs once, where the reason is produced, so the
 * findings file, the CI log and any later output all read the same string.
 * `scanRecords` passes each sender through it too.
 *
 * Percent-encoded as UTF-8:
 *   - every character outside printable ASCII. This includes GitHub's
 *     documented escaping for command data (`%` to %25, CR to %0D, LF to %0A)
 *     and every control, format and separator character;
 *   - `%` itself, so the encoding stays unambiguous;
 *   - the backtick and `|`, which end a Markdown code span and a table cell;
 *   - `#`, because the runner reads `##[command]` anywhere in a line.
 *
 * A `::` at the start, after any spaces, is encoded as well. The runner trims
 * leading whitespace and reads a line that then starts with `::` as a command.
 *
 * Nothing else changes. A reason without these characters comes back as it
 * was, and `decodeURIComponent` recovers any original exactly. A lone
 * surrogate is the one exception. It has no UTF-8 form and becomes U+FFFD.
 */
export function sanitizeReason(reason: string): string {
  let out = '';
  for (const char of reason) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e && !ENCODED_ASCII.has(char)) {
      out += char;
      continue;
    }
    for (const byte of UTF8.encode(char)) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out.replace(/^( *)::/, '$1%3A%3A');
}
