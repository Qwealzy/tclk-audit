import { RoomCursor, type Transport, type StoredMessage } from 'technocore-client';
import { scanRecords, type FrameRecord, type FrameRejection, type RoomRecord } from './frames.js';
import { buildThreads } from './threads.js';
import { audit, type AuditReport, type AuditOptions } from './audit.js';

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
}

export interface FollowPass {
  /** Frames that arrived in this pass. */
  readonly arrived: readonly FrameRecord[];
  /** The audit over the whole rolling window, not just the arrivals. */
  readonly report: AuditReport;
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
  } = { seq: message.seq, ts: message.ts, from: message.from, text: message.text };
  if (message.sig !== undefined) record.sig = message.sig;
  return record;
}

export class Follower {
  readonly #transport: Transport;
  readonly #room: string;
  readonly #windowFrames: number;
  #frames: FrameRecord[] = [];
  #rejections: FrameRejection[] = [];

  constructor(transport: Transport, options: FollowOptions = {}) {
    this.#transport = transport;
    this.#room = options.room ?? 'tclk-offers';
    this.#windowFrames = options.windowFrames ?? 4000;
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
      try {
        // Untrusted content, and a torn final line is expected: STATED
        // [EXPORT], the body is "cut back to the last complete line", but a
        // defensive parse costs nothing.
        const parsed = JSON.parse(line) as RoomRecord;
        if (typeof parsed.text === 'string') records.push(parsed);
      } catch {
        continue;
      }
    }
    const scan = scanRecords(records);
    this.#frames = [...scan.frames];
    this.#rejections = [...scan.rejections];
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
      const scan = scanRecords(step.messages.map(toRoomRecord));
      this.#frames.push(...scan.frames);
      this.#rejections.push(...scan.rejections);
      this.#trim();

      const index = buildThreads(this.#frames);
      const auditOptions: AuditOptions = { nowMs: Date.now() };
      const report = audit(index, this.#rejections, auditOptions);

      yield {
        arrived: scan.frames,
        report,
        gap:
          step.gap === null
            ? null
            : { missing: step.gap.missing, causes: step.gap.possibleCauses },
      };
    }
  }

  #trim(): void {
    this.#frames.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    if (this.#frames.length > this.#windowFrames) {
      this.#frames = this.#frames.slice(this.#frames.length - this.#windowFrames);
    }
    const oldest = this.#frames[0]?.seq;
    if (oldest !== undefined) {
      this.#rejections = this.#rejections.filter((r) => r.seq >= oldest);
    }
  }
}
