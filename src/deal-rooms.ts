import { OFFER_ROOM, dealRoom } from '@flop-labs/tclk';
import { roomName, type Transport } from 'technocore-client';
import { parseExportLine, scanRecords, type FrameRecord, type RoomRecord, type ScanResult } from './frames.js';
import { buildThreads, recomputedContractId, type ContractThread, type ThreadIndex } from './threads.js';

/**
 * Which room each frame belongs in, and reading the deal rooms.
 *
 * STATED [technocore.chat /patterns.md, pattern 6]: the accept is "signed in
 * tclk-offers as well. The contract id hashes the offer and the acceptance
 * together, so from here both sides derive the same deal room and go there:
 * mb-p-tclk-<first 16 hex of the contract id>."
 *
 * STATED [SPEC.md section 2, tclk 0.1.0]: "Everything from `lock` onward moves
 * to `mb-p-tclk-<first 16 hex of contract id>`".
 *
 * WHERE THE LINE FALLS. Once a contract is accepted, every frame other than an
 * offer or an accept belongs in its deal room. That includes a `cancel` sent
 * between the accept and the lock.
 *   - INFERRED from the patterns.md sentence above. "From here" follows the
 *     accept, and the lock comes later.
 *   - STATED in tclk's source after 0.1.0 (src/transcript.ts lines 291-294 at
 *     5cc4ab9): once the contract has an id, a frame that is not an offer or an
 *     accept is expected in `dealRoom(state.contract)`. Before that, every frame
 *     is expected in `tclk-offers`.
 * 0.1.0's "from `lock` onward" does not say where a cancel between the accept
 * and the lock goes. This module follows the two sources that do.
 *
 * "Accepted" means the accept the state machine takes. That accept is the one
 * that gives the contract its id in the machine's state. An accept the machine
 * refuses gives no contract an id, so it moves nothing into a deal room.
 *
 * 0.1.0 has no room check. `applyFrame` takes a state, a frame and a time, and
 * no room. So the rule is applied here, before the fold. A frame in the wrong
 * room is left out of the fold, so it cannot move a contract, whatever its
 * signature says. STATED [tclk HEAD SPEC.md section 2]: "A valid signature in
 * the wrong room cannot advance state."
 */

/** A contract the state machine accepted, and the room its later frames belong in. */
export interface ContractBinding {
  /** The offer id, which keys the contract's thread. */
  readonly key: string;
  readonly offer: FrameRecord;
  /** The accept the state machine took. */
  readonly accept: FrameRecord;
  /** The contract id, recomputed from the offer and the accept. */
  readonly contract: string;
  /** `dealRoom(contract)`. Derived from the recomputed id, never from a frame's field. */
  readonly room: string;
}

/** An accept whose `contract` field is not the id its offer and acceptance hash to. */
export interface ContractMismatch {
  readonly accept: FrameRecord;
  /** The id SPEC §3.2 gives for this offer and acceptance. */
  readonly recomputed: string;
}

export interface Bindings {
  /** In the order the accepts arrived in the board room. */
  readonly bindings: readonly ContractBinding[];
  readonly mismatches: readonly ContractMismatch[];
}

/**
 * Finds, for each offer on the board, the accept the state machine takes and
 * the deal room it leads to.
 *
 * Each accept whose offer is on the board is recomputed with
 * `recomputedContractId`. A mismatch is reported in `mismatches`, and such an
 * accept gives no deal room. The state machine checks the same thing, and this
 * check does not rely on it. An accept whose offer is not on the board cannot
 * be recomputed, so it gives no deal room either.
 *
 * Which accept the machine takes is `ContractThread.accept`, from
 * `buildThreads`. The thread's contract id and the board's status come from
 * that same decision, so the deal room does too. The room is derived from the
 * id recomputed here for that accept. A cancel from the offerer before any
 * accept closes the offer, and then nothing binds.
 */
export function bindContracts(board: readonly FrameRecord[]): Bindings {
  const index = buildThreads(board);
  const mismatches: ContractMismatch[] = [];
  const bindings: ContractBinding[] = [];

  for (const thread of index.threads) {
    const offer = thread.offer;
    if (offer === null || offer.frame.type !== 'offer') continue;
    for (const record of thread.frames) {
      if (record.frame.type !== 'accept') continue;
      const id = recomputedContractId(offer.frame, record.frame);
      if (id !== record.frame.contract) mismatches.push({ accept: record, recomputed: id });
    }

    const accept = thread.accept;
    if (accept === null || accept.frame.type !== 'accept') continue;
    const id = recomputedContractId(offer.frame, accept.frame);
    if (id !== accept.frame.contract) continue;
    bindings.push({ key: thread.key, offer, accept, contract: id, room: dealRoom(id) });
  }

  bindings.sort((a, b) => compareSeq(a.accept, b.accept));
  return { bindings, mismatches };
}

/** A decoded frame read from a room the spec does not put it in. */
export interface WrongRoomFrame {
  readonly record: FrameRecord;
  /** The room the record was read from. */
  readonly room: string;
  /** The room the spec puts it in. */
  readonly expected: string;
}

export interface RoutedFrames {
  /** Board frames in the room the spec puts them in. The board fold takes these. */
  readonly board: readonly FrameRecord[];
  /**
   * One thread per contract whose deal room was read. It holds the offer, the
   * accept the machine took, then the deal room's own frames in that room's
   * order. The deal room's seq is its own, so its frames are never sorted in
   * with the board's.
   */
  readonly deals: ThreadIndex;
  readonly wrongRoom: readonly WrongRoomFrame[];
}

/**
 * Splits frames by the room the spec puts them in.
 *
 * Board frames. An offer or an accept belongs in `tclk-offers`. Any other
 * frame belongs in the deal room once its thread's contract is accepted, which
 * is when it comes after the binding accept in the board's order. Before
 * that, or when its thread has no binding, it belongs in `tclk-offers`.
 *
 * Deal-room frames, from `dealRooms`, keyed by the room read. An offer or an
 * accept read there is in the wrong room. Every other frame joins the thread of
 * the contract the room was derived for. The room decides that. A frame's own
 * `contract` field is left to the state machine, which refuses a frame naming
 * a different contract. Rooms that no binding names are not looked at.
 *
 * `bindings` must come from `bindContracts` over the same board frames.
 */
export function routeFrames(
  board: { readonly room: string; readonly frames: readonly FrameRecord[] },
  bindings: readonly ContractBinding[],
  dealRooms: ReadonlyMap<string, readonly FrameRecord[]>,
): RoutedFrames {
  const byKey = new Map(bindings.map((b) => [b.key, b]));
  const threadOf = new Map<FrameRecord, string>();
  for (const thread of buildThreads(board.frames).threads) {
    for (const record of thread.frames) threadOf.set(record, thread.key);
  }

  const kept: FrameRecord[] = [];
  const wrongRoom: WrongRoomFrame[] = [];
  for (const record of board.frames) {
    const key = threadOf.get(record);
    const binding = key === undefined ? undefined : byKey.get(key);
    const expected = expectedBoardRoom(record, binding);
    if (expected === board.room) kept.push(record);
    else wrongRoom.push({ record, room: board.room, expected });
  }

  // Two contracts can share a room if their ids share the first 16 hex. Each
  // room is sorted once, so a wrong-room frame in it is counted once.
  const laterByRoom = new Map<string, FrameRecord[]>();
  const threads: ContractThread[] = [];
  for (const binding of bindings) {
    const frames = dealRooms.get(binding.room);
    if (frames === undefined) continue;
    let later = laterByRoom.get(binding.room);
    if (later === undefined) {
      later = [];
      for (const record of [...frames].sort(compareSeq)) {
        if (record.frame.type === 'offer' || record.frame.type === 'accept') {
          wrongRoom.push({ record, room: binding.room, expected: OFFER_ROOM });
        } else {
          later.push(record);
        }
      }
      laterByRoom.set(binding.room, later);
    }
    threads.push({
      key: binding.key,
      offer: binding.offer,
      accept: binding.accept,
      contractId: binding.contract,
      frames: [binding.offer, binding.accept, ...later],
      firstSeq: binding.offer.seq,
    });
  }

  return { board: kept, deals: { threads, unattributed: [] }, wrongRoom };
}

/** Where the spec puts a frame read from the board, given its thread's binding. */
function expectedBoardRoom(record: FrameRecord, binding: ContractBinding | undefined): string {
  if (record.frame.type === 'offer' || record.frame.type === 'accept') return OFFER_ROOM;
  if (binding !== undefined && record.seq > binding.accept.seq) return binding.room;
  return OFFER_ROOM;
}

function compareSeq(a: FrameRecord, b: FrameRecord): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

export interface DealRoomReads {
  /** Each room that was read, with what scanning it found. */
  readonly scans: ReadonlyMap<string, ScanResult>;
  /**
   * Set when a read failed. No room after it was read, and nothing is retried.
   * `error` is the error's class name only. A server's error body is room
   * data, so none of it is kept.
   */
  readonly stopped: { readonly room: string; readonly error: string } | null;
}

/**
 * Reads each deal room through `/export`, one room at a time, in the order
 * given.
 *
 * STATED [EXPORT]: `/export` is "the room's stored file", its reachability is
 * the room read's, "p- rooms included, and a missing room exports as empty".
 * So a deal room nobody wrote to reads as empty, and reading it creates
 * nothing. STATED [patterns.md, pattern 6]: a deal room's "reads take no
 * signature". Nothing here signs or writes.
 *
 * Each room is one read. The read budget is the deployment's, published at
 * /config, and this function does not guess at it. It stops at the first
 * refusal, a 429 included, and says where it stopped. The caller reports that.
 */
export async function readDealRooms(
  transport: Transport,
  rooms: Iterable<string>,
): Promise<DealRoomReads> {
  const scans = new Map<string, ScanResult>();
  for (const room of rooms) {
    if (scans.has(room)) continue;
    let body: string;
    try {
      const url = `${transport.baseUrl}/r/${roomName(room)}/export`;
      body = (await transport.requestText(url, undefined, { bucket: 'read' })).body;
    } catch (error) {
      return {
        scans,
        stopped: { room, error: error instanceof Error ? error.constructor.name : typeof error },
      };
    }
    scans.set(room, scanRecords(exportRecords(body), { room }));
  }
  return { scans, stopped: null };
}

/** The records of an `/export` body. A torn or malformed line is skipped. */
export function exportRecords(body: string): RoomRecord[] {
  const records: RoomRecord[] = [];
  for (const line of body.split('\n')) {
    if (line.length === 0) continue;
    const record = parseExportLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

/** The decoded frames of each room read, for `routeFrames`. */
export function framesByRoom(reads: DealRoomReads): Map<string, readonly FrameRecord[]> {
  const frames = new Map<string, readonly FrameRecord[]>();
  for (const [room, scan] of reads.scans) frames.set(room, scan.frames);
  return frames;
}
