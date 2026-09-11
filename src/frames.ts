import { createHash } from 'node:crypto';
import { isTclkLine, tryDecodeFrame, decodeFrame, type TclkFrame } from '@flop-labs/tclk';
import { parseRoomPage, storedMessagePayload, verifyPayload } from 'technocore-client';

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
 * It also checks what the decoder returns, because 0.1.0 does coerce in two
 * places. PROBED 2026-09-11: it looks a frame's `type` up by its string form,
 * so `["lock"]` decodes as a lock and skips every check on a lock's own
 * fields. It reads a receipt's `outcome` by its string form too. So each
 * decoded frame goes through `shapeRefusal`, which compares it with the
 * JavaScript types tclk declares. That check parses nothing and knows no
 * value rule. Every rule about values is still the decoder's.
 *
 * Then it applies SPEC.md section 2. STATED [SPEC.md section 2, tclk 0.1.0,
 * lines 56 to 58]: a frame's `from` "MUST match the transport-verified `from`
 * of the record that carried it. An unsigned frame is data, not a commitment".
 * So only a frame whose signature verifies, and whose `from` is the key that
 * signed it, reaches `ScanResult.frames`. Every other decoded frame becomes a
 * rejection with `refusedBy: 'signature-check'`, and nothing downstream sees
 * it. `FrameVerification` says what each outcome means.
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
   * unchanged. In `ScanResult.frames` it is always the did:key that signed the
   * record.
   */
  readonly from: string;
  /**
   * Whether the record carries a signature and can be re-verified offline.
   *
   * STATED [RENDERING]: a missing `sig` means "not re-verifiable", NOT
   * "invalid". Records written before the field existed do not have one.
   * STATED [patterns.md §6]: "An unsigned frame is data, not a commitment —
   * readers drop it." In `ScanResult.frames` this is always true.
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
   * `scanRecords` puts a frame in `ScanResult.frames` only when this is
   * `verified`. A frame built some other way is not checked again downstream.
   */
  readonly verification: FrameVerification;
}

/**
 * The outcome of checking one record against SPEC.md section 2, and what
 * `scanRecords` does with it. Only `verified` reaches the audit.
 *
 *   - `verified` means the signature verifies for the record's room, nonce and
 *     text, and the frame's `from` is the key that signed it. Applied.
 *   - `from-mismatch` means the signature verifies, and the frame's `from`
 *     names a different key. Left out, and counted apart. It breaks the MUST
 *     in SPEC.md section 2 (lines 56 and 57).
 *   - `bad-signature` means the record carries a signature that does not
 *     verify. Left out, and counted apart. Many at once more likely mean a
 *     fault in this reader than many faulty senders. A nonce that lost digits
 *     on the way in fails a good signature, which is why `parseExportLine`
 *     keeps them.
 *   - `unsigned` means the record carries no signature. Left out. STATED
 *     [RENDERING]: it is "not re-verifiable", which is not "invalid". STATED
 *     [SPEC.md section 2, lines 57 and 58]: it is data, not a commitment.
 *   - `unverifiable` means the record carries a signature that cannot be
 *     checked here. The room was not given, or the nonce is missing, has
 *     already lost digits, or is not the form the transport signs. Left out,
 *     and reported as a limit of this reader.
 *     It says nothing about the sender. The scheduled run and the follower
 *     always pass the room and keep nonces as digits.
 */
export type FrameVerification =
  | 'verified'
  | 'from-mismatch'
  | 'bad-signature'
  | 'unsigned'
  | 'unverifiable';

/** Every outcome that leaves a frame out of the audit. */
export type Unverified = Exclude<FrameVerification, 'verified'>;

/**
 * A line that looked like a frame and was refused, by the normative decoder, by
 * the shape check after it, or by the signature check after that.
 */
export interface FrameRejection {
  readonly seq: bigint;
  readonly ts: string;
  /** The sender, after `sanitizeReason`. See `FrameRecord.from`. */
  readonly from: string;
  /**
   * Who refused the line. `decoder` is 0.1.0's `decodeFrame`. `shape-check` is
   * this module, after the decoder had accepted the line. See `shapeRefusal`.
   * `signature-check` is this module, after the shape check had passed it.
   * See `FrameVerification`.
   */
  readonly refusedBy: 'decoder' | 'shape-check' | 'signature-check';
  /** Set only when `refusedBy` is `signature-check`. What that check found. */
  readonly verification?: Unverified;
  /**
   * The refusal. A decoder refusal is rebuilt by `rebuildRefusal`. It keeps the
   * decoder's fixed text, and every part a stranger chose appears only as
   * `<N bytes, sha256:HEX>`. A shape refusal is this module's own text, built
   * the same way by `shapeRefusal`. A signature refusal is fixed text and a
   * frame type from `FRAME_SHAPES`. Each then goes through `sanitizeReason`.
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
  /** Frames that decoded, passed the shape check, and are `verified`. */
  readonly frames: readonly FrameRecord[];
  /**
   * Lines the decoder refused, apart from known decoder gaps. Then lines it
   * accepted that the shape check refused, and frames that passed it whose
   * signature check found anything but `verified`. `refusedBy` tells them apart.
   * A line here is never in `frames`.
   */
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
   * `<room>|<nonce>|<text>`, so without the room no signature can be checked.
   * Every signed frame is then `unverifiable` and left out. The scheduled run,
   * the follower and `readDealRooms` always pass it.
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
    // the service for that, so the sender goes through sanitizeReason. That
    // percent-encodes every character outside printable ASCII, and `%`, the
    // backtick, `|`, `#` and a leading `::`. Any other printable ASCII comes
    // through as it is. The sender is not rebuilt or hashed.
    const from = sanitizeReason(String(record.from));

    const frame = tryDecodeFrame(record.text);
    if (frame === null) {
      const { reason, gap } = rejectionReason(record.text);
      const rejection = { seq: BigInt(record.seq), ts: record.ts, from, refusedBy: 'decoder' as const, reason };
      if (gap === undefined) rejections.push(rejection);
      else knownGaps.push({ ...rejection, gap });
      continue;
    }

    // The decoder accepted the line. Nothing uses the frame until its shape
    // matches the types tclk declares. A frame that fails never reaches the
    // state machine.
    const shape = shapeRefusal(frame);
    if (shape !== null) {
      rejections.push({
        seq: BigInt(record.seq),
        ts: record.ts,
        from,
        refusedBy: 'shape-check',
        reason: sanitizeReason(shape),
      });
      continue;
    }

    // Then SPEC.md section 2. Only a verified frame goes on. Any other is a
    // rejection, and nothing downstream sees it.
    const verification = verificationOf(record, frame, options.room);
    if (verification !== 'verified') {
      rejections.push({
        seq: BigInt(record.seq),
        ts: record.ts,
        from,
        refusedBy: 'signature-check',
        verification,
        reason: sanitizeReason(signatureReason(frame.type, verification)),
      });
      continue;
    }

    frames.push({
      frame,
      seq: BigInt(record.seq),
      tsMs: parseServerTimestamp(record.ts),
      ts: record.ts,
      from,
      signed: typeof record.sig === 'string',
      verification,
    });
  }

  return { frames, rejections, knownGaps, nonFrameCount };
}

/**
 * The reason a frame the signature check left out is given. Fixed text, and a
 * frame type the shape check has already matched in `FRAME_SHAPES`.
 */
function signatureReason(type: TclkFrame['type'], verification: Unverified): string {
  switch (verification) {
    case 'unsigned':
      return `tclk-audit: unsigned ${type}, not re-verifiable`;
    case 'from-mismatch':
      return `tclk-audit: ${type} whose from is not the key that signed it`;
    case 'bad-signature':
      return `tclk-audit: ${type} whose signature does not verify`;
    case 'unverifiable':
      return `tclk-audit: ${type} whose signature this reader could not check`;
  }
}

/**
 * Checks one record against SPEC.md section 2 with technocore-client's
 * `verifyStoredMessage`. It compares the frame's `from` with the raw transport
 * `from`, before `sanitizeReason`, because that is the key the signature was
 * checked against.
 *
 * The payload is built first, and on its own. STATED in technocore-client's
 * dist/payload.js: `storedMessagePayload` throws for a nonce outside the form
 * the transport signs, and its 19-digit rule lives there rather than here.
 * A nonce like that leaves nothing to check, which is this reader's limit and
 * not the sender's, so the frame is `unverifiable` and not `bad-signature`.
 *
 * It never throws. STATED in technocore-client's dist/verify.js: `verifyPayload`
 * returns false for a malformed signature or key. Should anything throw all the
 * same, the check did not finish, so that frame is `unverifiable` too.
 */
function verificationOf(
  record: RoomRecord,
  frame: TclkFrame,
  room: string | undefined,
): FrameVerification {
  if (typeof record.sig !== 'string') return 'unsigned';
  const nonce = exactNonce(record.nonce);
  if (room === undefined || nonce === null) return 'unverifiable';
  let signed: boolean;
  try {
    signed = verifyPayload(storedMessagePayload(room, nonce, record.text), record.sig, String(record.from));
  } catch {
    return 'unverifiable';
  }
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
 * Every refusal goes through `rebuildRefusal` and then `sanitizeReason`, so no
 * caller ever holds the raw message. The one other path returns this module's
 * own constant, for a decoder that disagreed with itself. The known-gap check
 * reads the raw message, which is never returned.
 */
function rejectionReason(text: string): { reason: string; gap: DecoderGap | undefined } {
  let raw: string;
  try {
    decodeFrame(text);
    return {
      reason: 'decoder disagreed with itself between tryDecodeFrame and decodeFrame',
      gap: undefined,
    };
  } catch (error) {
    raw = error instanceof Error ? error.message : String(error);
  }
  return { reason: sanitizeReason(rebuildRefusal(raw)), gap: KNOWN_DECODER_GAPS.get(raw) };
}

const UTF8 = new TextEncoder();

/**
 * Text a stranger chose, shown without the text: `<N bytes, sha256:HEX>`.
 *
 * N is the length of its UTF-8 bytes and HEX the full SHA-256 of them. The
 * same text always gives the same slot, so repeats still count together, and a
 * reader with a guess can hash the guess and compare. A lone surrogate has no
 * UTF-8 form. It is encoded as U+FFFD first.
 */
function hidden(text: string): string {
  const bytes = UTF8.encode(text);
  return `<${bytes.length} bytes, sha256:${createHash('sha256').update(bytes).digest('hex')}>`;
}

/**
 * A value a stranger chose, of any type, as `hidden` over its JSON text. So
 * `["lock"]` is hashed as the 8 bytes `["lock"]`. A value with no JSON text
 * gets fixed text instead.
 */
function hiddenJson(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return json === undefined ? '<no JSON form>' : hidden(json);
}

/** `any` is a key the decoder lets through with any value. Nothing here reads it. */
type FieldKind = 'string' | 'number' | 'strings' | 'job' | 'presig' | 'any';

interface Field {
  readonly kind: FieldKind;
  readonly optional: boolean;
}

type Shape = ReadonlyMap<string, Field>;

/** A shape from `{ name: kind }`. A name that ends in `?` is optional. */
function shape(spec: Readonly<Record<string, FieldKind>>): Shape {
  return new Map(
    Object.entries(spec).map(([name, kind]): [string, Field] =>
      name.endsWith('?') ? [name.slice(0, -1), { kind, optional: true }] : [name, { kind, optional: false }],
    ),
  );
}

/**
 * The fields of each frame type 0.1.0 decodes, with the JavaScript type of
 * each.
 *
 * STATED in 0.1.0's dist/frames.d.ts, in the `TclkFrame` union and the
 * interfaces it joins, and in dist/frames.js, in the `KEYS` table (lines 122
 * to 153). For the seven frame types the two agree on every field and on which
 * are optional. The thirteen names in `MALFORMED_NAMES` are only the string
 * fields the decoder also matches against a pattern. This table has every
 * field.
 *
 * A `Map` and a `typeof` check, so no coercion happens here and no name an
 * object inherits, such as `constructor`, can match.
 */
const FRAME_SHAPES: ReadonlyMap<string, Shape> = new Map([
  [
    'offer',
    shape({
      type: 'string', from: 'string', role: 'string', amount: 'string', asset: 'string',
      lock: 'string', rails: 'strings', claimByMs: 'number', refundAfterMs: 'number',
      expiresMs: 'number', 'paymentKey?': 'string', 'job?': 'job', nonce: 'string', id: 'string',
    }),
  ],
  [
    'accept',
    shape({
      type: 'string', from: 'string', ref: 'string', statement: 'string', contract: 'string',
      'paymentKey?': 'string', nonce: 'string',
    }),
  ],
  ['lock', shape({ type: 'string', from: 'string', contract: 'string', rail: 'string', ref: 'string', 'presig?': 'presig' })],
  ['reveal', shape({ type: 'string', from: 'string', contract: 'string', secret: 'string' })],
  ['refund', shape({ type: 'string', from: 'string', contract: 'string', 'reason?': 'string' })],
  ['cancel', shape({ type: 'string', from: 'string', contract: 'string', 'reason?': 'string' })],
  [
    'receipt',
    shape({ type: 'string', from: 'string', contract: 'string', outcome: 'string', 'rail?': 'string', 'ref?': 'string' }),
  ],
]);

/**
 * `JobRef` and `PresigRef` in dist/frames.d.ts, and one key they do not
 * declare. STATED in dist/frames.js (lines 61 and 219): the decoder checks the
 * keys of a job and of a presig against a set that includes `type`, after it
 * has set `type` in its own copy. So a `type` key inside either passes with any
 * value. This table allows it too, so it refuses nothing the decoder accepts
 * there.
 */
const NESTED_SHAPES: { readonly job: Shape; readonly presig: Shape } = {
  job: shape({ 'type?': 'any', proto: 'string', id: 'string', 'context?': 'string' }),
  presig: shape({ 'type?': 'any', nonce: 'string', s: 'string' }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why a frame the decoder accepted does not have the shape tclk declares, or
 * null when it does.
 *
 * STATED in 0.1.0's dist/frames.js. `validateFrame` finds a type's fields with
 * `KEYS[type]` (line 166). That is a plain object, so an array type is looked
 * up by its string form, and `["lock"]` or `[["lock"]]` finds the lock entry.
 * The field checks then sit in `switch (type)` (line 171), which compares with
 * `===` and has no default. So such a frame passes with only its key names and
 * `from` checked, and any value in its other fields. A receipt's `outcome` is
 * checked as `String(frame.outcome)` (line 239), so `["claimed"]` passes too.
 * STATED in dist/machine.js: `applyFrame` switches on `frame.type` the same way
 * (line 48) and returns nothing when no case matches. PROBED 2026-09-11: one
 * such frame in a deal room, or on the board where `acceptTaken` reads it,
 * threw a TypeError in the fold and stopped the scheduled run before it wrote
 * anything.
 *
 * The check covers every type and every field. Each key must be in its table,
 * each required field present, and each field of its JavaScript type. It
 * checks types only. A string that breaks a pattern is still the decoder's to
 * refuse. INFERRED from dist/frames.js: on a frame the decoder accepts, this
 * refuses only a type or an outcome that is not a string. The decoder has
 * already checked everything else the same way.
 *
 * Its text is built like `rebuildRefusal`'s. Field names and frame types come
 * from this module's tables. Anything a stranger chose appears only as a
 * length and a hash, a non-string over its JSON text. It never throws. A check
 * that fails for any other reason refuses the frame with fixed text.
 */
export function shapeRefusal(frame: unknown): string | null {
  const prefix = 'tclk-audit: ';
  try {
    if (!isRecord(frame)) return `${prefix}frame must be an object`;
    const type = frame['type'];
    if (typeof type !== 'string') return `${prefix}type must be a string: ${hiddenJson(type)}`;
    const fields = FRAME_SHAPES.get(type);
    if (fields === undefined) return `${prefix}type is not a frame type: ${hidden(type)}`;
    const refusal = recordRefusal(frame, fields, type);
    return refusal === null ? null : prefix + refusal;
  } catch {
    return `${prefix}frame shape could not be checked`;
  }
}

/** The first way `record` differs from `fields`, or null. `owner` names it in the text. */
function recordRefusal(record: Record<string, unknown>, fields: Shape, owner: string): string | null {
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) return `unknown field on ${owner}: ${hidden(key)}`;
  }
  for (const [name, field] of fields) {
    if (!Object.hasOwn(record, name)) {
      if (field.optional) continue;
      return `missing field on ${owner}: ${name}`;
    }
    const value = record[name];
    const path = `${owner}.${name}`;
    switch (field.kind) {
      case 'string':
        if (typeof value !== 'string') return `${path} must be a string: ${hiddenJson(value)}`;
        break;
      case 'number':
        if (typeof value !== 'number') return `${path} must be a number: ${hiddenJson(value)}`;
        break;
      case 'strings':
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
          return `${path} must be an array of strings: ${hiddenJson(value)}`;
        }
        break;
      case 'job':
      case 'presig': {
        if (!isRecord(value)) return `${path} must be an object: ${hiddenJson(value)}`;
        const inner = recordRefusal(value, NESTED_SHAPES[field.kind], path);
        if (inner !== null) return inner;
        break;
      }
      case 'any':
        break;
    }
  }
  return null;
}

// The closed lists the decoder draws its own words from, copied from 0.1.0's
// dist/frames.js. A word in a refusal is kept only if it is on one of these.

/** `record.type` in requireKeys: a frame type, or the two nested records. */
const KEY_OWNERS = ['offer', 'accept', 'lock', 'reveal', 'refund', 'cancel', 'receipt', 'job', 'presig'];

/** Names passed to requireString with a pattern, so its refusal repeats the value. */
const MALFORMED_NAMES = [
  'from', 'amount', 'asset', 'rail', 'nonce', 'ref', 'statement', 'contract', 'secret',
  'presig.nonce', 'presig.s', 'job.proto', 'paymentKey',
];

/** Every name in a `required` list, so every key a "missing field" refusal can name. */
const REQUIRED_KEYS = [
  'from', 'role', 'amount', 'asset', 'lock', 'rails', 'claimByMs', 'refundAfterMs',
  'expiresMs', 'nonce', 'id', 'ref', 'statement', 'contract', 'rail', 'secret', 'outcome',
  'proto', 's',
];

/** Every refusal on the decode path with no part a stranger chose. */
const FIXED_REFUSALS: ReadonlySet<string> = new Set([
  'not a tclk/1 line',
  'frame is not valid JSON',
  'frame must be an object',
  'job must be an object',
  'frame contains an unsupported value',
  'role must be payer|payee',
  'lock must be hash|point',
  'rails must be a non-empty array',
  'claimByMs must be strictly before refundAfterMs',
  'point locks require paymentKey',
  'presig must be an object',
  'outcome must be claimed|refunded|cancelled',
  'paymentKey is not a valid secp256k1 point',
  ...KEY_OWNERS.flatMap((owner) => REQUIRED_KEYS.map((key) => `missing field on ${owner}: ${key}`)),
  ...[...MALFORMED_NAMES, 'reason', 'job.id', 'job.context'].map((name) => `${name} must be a non-empty string`),
  ...['claimByMs', 'refundAfterMs', 'expiresMs'].map((name) => `${name} must be a positive unix-ms integer`),
].map((message) => `tclk: ${message}`));

/**
 * The templates whose last part is text a stranger chose, as the fixed text
 * that comes before it. That part always comes last, after text the decoder
 * wrote, so the prefix cannot be forged by it.
 */
const PREFIXED_REFUSALS: readonly string[] = [
  'tclk: unknown frame type: ',
  ...KEY_OWNERS.map((owner) => `tclk: unknown field on ${owner}: `),
  ...MALFORMED_NAMES.map((name) => `tclk: ${name} is malformed: `),
];

/**
 * Rebuilds a decoder refusal so that no text a stranger chose survives in it.
 *
 * STATED in 0.1.0's dist/frames.js (line 31): every refusal the decoder
 * writes is thrown as `new Error("tclk: " + msg)`, with no structured form.
 * PROBED 2026-09-11: a JavaScript error it does not catch has another form. A
 * TypeError from a type that cannot become a string is one, and a stack
 * overflow from deep nesting is another. Those match no template and are
 * hidden whole. So the refusal is matched against every template the decode
 * path can produce
 * (dist/frames.js lines 36 to 315), and a new message is built from this
 * module's own copy of the fixed text.
 *   - A refusal with no stranger's part is kept, but only when it equals one
 *     of `FIXED_REFUSALS`, all of which this module wrote out itself.
 *   - A field name, a field value or a frame type becomes `hidden(...)`, however
 *     harmless it looks. That also bounds the length, since only the byte
 *     count is printed.
 *   - The offer id mismatch carries a hash the decoder computed. It is kept
 *     only when it is exactly `0x` and 64 lowercase hex digits.
 *   - Anything else is hidden whole.
 *
 * This deliberately gives up an earlier rule, that the decoder's own words are
 * never reworded. The words a stranger chose were the part of them that could
 * reach a reader, a CI log, a model prompt or a room.
 */
export function rebuildRefusal(raw: string): string {
  if (FIXED_REFUSALS.has(raw)) return raw;
  const mismatch = /^tclk: offer id mismatch \(expected (0x[0-9a-f]{64})\)$/.exec(raw);
  if (mismatch !== null) return `tclk: offer id mismatch (expected ${mismatch[1]})`;
  for (const prefix of PREFIXED_REFUSALS) {
    if (raw.startsWith(prefix)) return prefix + hidden(raw.slice(prefix.length));
  }
  return `tclk: refusal in a form this reader does not know, ${hidden(raw)}`;
}

/** Printable ASCII that still has to be encoded. See `sanitizeReason`. */
const ENCODED_ASCII: ReadonlySet<string> = new Set(['%', '`', '|', '#']);

/**
 * Makes a string inert on every surface that prints it.
 *
 * For a rejection reason this is a second layer. `rebuildRefusal` has already
 * replaced every part a stranger chose, so what remains is text this package
 * wrote. `scanRecords` passes each sender through it too, and a sender is not
 * rebuilt. It can carry line breaks, Markdown, and lines the GitHub runner
 * reads as workflow commands. This runs once, where the string is produced, so
 * the findings file, the CI log and any later output all read the same string.
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
