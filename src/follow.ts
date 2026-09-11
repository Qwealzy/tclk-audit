import { RoomCursor, type Transport, type StoredMessage } from 'technocore-client';
import {
  scanRecords,
  parseExportLine,
  type FrameRecord,
  type FrameRejection,
  type KnownDecoderGap,
  type RoomRecord,
  type ScanResult,
} from './frames.js';
import { buildThreads } from './threads.js';
import { audit, type AuditReport, type AuditOptions } from './audit.js';
import {
  bindContracts,
  readDealRooms,
  routeFrames,
  type ContractBinding,
  type ContractMismatch,
  type DealRoomReads,
  type WrongRoomFrame,
} from './deal-rooms.js';

/**
 * Following `tclk-offers` and auditing what arrives.
 *
 * Two things about the venue shape this:
 *
 * A contract's frames arrive minutes or hours apart, so an auditor that only
 * ever saw the newest page would never see a whole contract. It keeps a rolling
 * window of recent frames and re-audits over the window, not the batch.
 *
 * And a reader more than 200 messages behind cannot catch up through `?since=`
 * at all. `limit` returns the newest n after the cursor, never the next n, so
 * every read past that point returns the newest slice and reports a gap. At the
 * measured ~4,900 frames/hour in this room that is about two and a half minutes
 * of lag. Long-polling is not an optimisation here. It is the only way to stay
 * attached, and when a gap does appear, `/export` is the only way back.
 *
 * Once the state machine accepts a contract, its later frames belong in its
 * deal room (see deal-rooms.ts). So each pass also reads the deal rooms of the
 * newest accepted contracts in the window, through `/export`. A deal room is
 * small and has no long-poll of its own here. Re-reading it whole is one read,
 * and it cannot leave a gap.
 *
 * Every read passes its room to `scanRecords`, and technocore-client keeps each
 * nonce as digits. So a signed frame can be checked, and only a verified one
 * joins the window. A frame the signature check leaves out is reported with the
 * rejections and folded nowhere.
 */

export interface FollowOptions {
  readonly room?: string;
  /**
   * How many frames to keep in the rolling window.
   *
   * Not a deployment limit. A memory and coverage tradeoff for this process.
   * Large enough that a contract's whole life usually fits, small enough to
   * bound the audit's cost per pass.
   */
  readonly windowFrames?: number;
  /** Seconds to hold each long-poll. Passed to the cursor unchanged. */
  readonly waitSeconds?: number;
  readonly signal?: AbortSignal;
  /**
   * How many deal rooms one read covers, newest accepted contracts first.
   *
   * Not a deployment limit either. Each deal room costs one read, so this
   * bounds what one read of them spends from this process's read budget.
   */
  readonly maxDealRooms?: number;
  /**
   * The least time between two reads of the deal rooms, in milliseconds.
   *
   * A busy board returns from its long-poll at once, so passes can come many
   * times a second. Reading every deal room on every pass would spend the read
   * budget on the same unchanged rooms. Between reads, a pass reuses what the
   * last read found.
   */
  readonly dealRoomIntervalMs?: number;
}

/** What the deal rooms showed in one pass. */
export interface DealPass {
  /**
   * The audit over the contracts whose deal room has been read. Each is folded
   * from its offer and accept through the deal room's own frames.
   */
  readonly report: AuditReport;
  /** Every contract the state machine accepted in the window. */
  readonly bindings: readonly ContractBinding[];
  /** Accepts whose `contract` field is not the id their offer and acceptance hash to. */
  readonly mismatches: readonly ContractMismatch[];
  /** Frames read from a room the spec does not put them in. Left out of both audits. */
  readonly wrongRoom: readonly WrongRoomFrame[];
  /** Known decoder gaps in the deal rooms read. */
  readonly knownGaps: readonly KnownDecoderGap[];
  /** How many deal rooms the audit covers. */
  readonly roomsRead: number;
  /** Set when the latest read stopped at a refusal. */
  readonly stopped: DealRoomReads['stopped'];
}

export interface FollowPass {
  /** Frames that arrived in this pass. */
  readonly arrived: readonly FrameRecord[];
  /**
   * The audit over the board's rolling window, not just the arrivals. A frame
   * the spec puts in a deal room is left out of it, and so is a frame whose
   * signature is not verified.
   */
  readonly report: AuditReport;
  /** Known decoder gaps in the board's window. They are not in `report`. */
  readonly knownGaps: readonly KnownDecoderGap[];
  readonly deals: DealPass;
  /**
   * Set when the room advanced past the cursor and records were missed.
   *
   * The window is incomplete from here, so findings that depend on seeing a
   * contract's whole life are unreliable until the window refills.
   */
  readonly gap: { readonly missing: bigint; readonly causes: readonly string[] } | null;
}

function toRoomRecord(message: StoredMessage): RoomRecord {
  const record: {
    seq: bigint;
    ts: string;
    from: string;
    text: string;
    sig?: string;
    nonce?: string;
  } = { seq: message.seq, ts: message.ts, from: message.from, text: message.text };
  if (message.sig !== undefined) record.sig = message.sig;
  // technocore-client carries the nonce as digits. Keep them, since the
  // signature covers them.
  if (message.nonce !== undefined) record.nonce = message.nonce;
  return record;
}

export class Follower {
  readonly #transport: Transport;
  readonly #room: string;
  readonly #windowFrames: number;
  readonly #maxDealRooms: number;
  readonly #dealRoomIntervalMs: number;
  #frames: FrameRecord[] = [];
  #rejections: FrameRejection[] = [];
  #knownGaps: KnownDecoderGap[] = [];
  #dealScans = new Map<string, ScanResult>();
  #dealReadAt: number | null = null;
  #dealStopped: DealRoomReads['stopped'] = null;

  constructor(transport: Transport, options: FollowOptions = {}) {
    this.#transport = transport;
    this.#room = options.room ?? 'tclk-offers';
    this.#windowFrames = options.windowFrames ?? 4000;
    this.#maxDealRooms = options.maxDealRooms ?? 50;
    this.#dealRoomIntervalMs = options.dealRoomIntervalMs ?? 60_000;
  }

  get room(): string {
    return this.#room;
  }

  /** Seeds the window from `/export` so contracts already in flight are complete. */
  async seedFromExport(): Promise<number> {
    const url = `${this.#transport.baseUrl}/r/${this.#room}/export`;
    const reply = await this.#transport.requestText(url, undefined, { bucket: 'read' });
    const records: RoomRecord[] = [];
    for (const line of reply.body.split('\n')) {
      if (line.length === 0) continue;
      // Untrusted content, and a torn final line is expected: STATED
      // [EXPORT], the body is "cut back to the last complete line", but a
      // defensive parse costs nothing. parseExportLine returns null for it,
      // and keeps a 19-digit nonce exact.
      const record = parseExportLine(line);
      if (record !== null) records.push(record);
    }
    const scan = scanRecords(records, { room: this.#room });
    this.#frames = [...scan.frames];
    this.#rejections = [...scan.rejections];
    this.#knownGaps = [...scan.knownGaps];
    this.#trim();
    return this.#frames.length;
  }

  /**
   * Follows the room, yielding one audit per batch of arrivals.
   *
   * `waitSeconds` is required by `RoomCursor.follow`. Without a wait or a poll
   * interval it refuses to run rather than becoming an unthrottled request loop.
   */
  async *follow(options: FollowOptions = {}): AsyncGenerator<FollowPass> {
    const { cursor } = await RoomCursor.open(this.#transport, this.#room, { limit: 200 });
    const waitSeconds = options.waitSeconds ?? 10;

    const followOptions: Parameters<typeof cursor.follow>[0] = { waitSeconds, limit: 200 };
    if (options.signal !== undefined) {
      (followOptions as { signal?: AbortSignal }).signal = options.signal;
    }

    for await (const step of cursor.follow(followOptions)) {
      const scan = scanRecords(step.messages.map(toRoomRecord), { room: this.#room });
      this.#frames.push(...scan.frames);
      this.#rejections.push(...scan.rejections);
      this.#knownGaps.push(...scan.knownGaps);
      this.#trim();

      const auditOptions: AuditOptions = { nowMs: Date.now() };
      const { bindings, mismatches } = bindContracts(this.#frames);
      await this.#readDealRooms(bindings, auditOptions.nowMs);

      const dealFrames = new Map<string, readonly FrameRecord[]>();
      const dealRejections: FrameRejection[] = [];
      const dealGaps: KnownDecoderGap[] = [];
      for (const [room, dealScan] of this.#dealScans) {
        dealFrames.set(room, dealScan.frames);
        dealRejections.push(...dealScan.rejections);
        dealGaps.push(...dealScan.knownGaps);
      }
      const routed = routeFrames({ room: this.#room, frames: this.#frames }, bindings, dealFrames);

      const index = buildThreads(routed.board);
      const report = audit(index, this.#rejections, auditOptions);

      yield {
        arrived: scan.frames,
        report,
        knownGaps: [...this.#knownGaps],
        deals: {
          report: audit(routed.deals, dealRejections, auditOptions),
          bindings,
          mismatches,
          wrongRoom: routed.wrongRoom,
          knownGaps: dealGaps,
          roomsRead: this.#dealScans.size,
          stopped: this.#dealStopped,
        },
        gap:
          step.gap === null
            ? null
            : { missing: step.gap.missing, causes: step.gap.possibleCauses },
      };
    }
  }

  /**
   * Reads the deal rooms of the newest accepted contracts, when the last read
   * is old enough. Rooms whose contract has left the window are dropped. A
   * room the latest read did not reach keeps what an earlier read found.
   */
  async #readDealRooms(bindings: readonly ContractBinding[], nowMs: number): Promise<void> {
    const wanted = new Set(
      [...bindings].reverse().slice(0, this.#maxDealRooms).map((b) => b.room),
    );
    for (const room of this.#dealScans.keys()) {
      if (!wanted.has(room)) this.#dealScans.delete(room);
    }
    if (this.#dealReadAt !== null && nowMs - this.#dealReadAt < this.#dealRoomIntervalMs) return;

    this.#dealReadAt = nowMs;
    const reads = await readDealRooms(this.#transport, wanted);
    for (const [room, dealScan] of reads.scans) this.#dealScans.set(room, dealScan);
    this.#dealStopped = reads.stopped;
  }

  #trim(): void {
    this.#frames.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    if (this.#frames.length > this.#windowFrames) {
      this.#frames = this.#frames.slice(this.#frames.length - this.#windowFrames);
    }
    const oldest = this.#frames[0]?.seq;
    if (oldest !== undefined) {
      this.#rejections = this.#rejections.filter((r) => r.seq >= oldest);
      this.#knownGaps = this.#knownGaps.filter((r) => r.seq >= oldest);
    }
    // The cutoff above is the oldest frame's seq, and the signature check moved
    // frames out of `#frames` and into `#rejections`. In a room where little
    // verifies, `#frames` fills slowly and the cutoff barely moves, and with no
    // frame at all there is no cutoff. So each list is capped by count too, and
    // the newest are the ones kept.
    this.#rejections = this.#rejections.slice(-this.#windowFrames);
    this.#knownGaps = this.#knownGaps.slice(-this.#windowFrames);
  }
}
