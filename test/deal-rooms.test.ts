import { describe, expect, it } from 'vitest';
import {
  OFFER_ROOM,
  canonicalJson,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  type AcceptFrame,
  type OfferFrame,
  type TclkFrame,
} from '@flop-labs/tclk';
import { Identity, Transport } from 'technocore-client';
import { scanRecords, type RoomRecord } from '../src/frames.js';
import { buildThreads, recomputedContractId } from '../src/threads.js';
import { audit } from '../src/audit.js';
import { bindContracts, routeFrames } from '../src/deal-rooms.js';
import { Follower } from '../src/follow.js';

/**
 * Deal rooms, the room each frame belongs in, and contract ids.
 *
 * The committed fixture was taken from `tclk-offers` alone and holds no deal
 * room at all. So every contract here is built and signed in the test by
 * throwaway identities. `Identity.create()` makes an Ed25519 key with
 * node:crypto that lives in memory while the test runs. No key file is read
 * or written.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const NOW = T0 + 30 * MINUTE;

let nextNonce = 1788627060599440000n;

/** One signed record, as a room would store it. */
function post(identity: Identity, room: string, seq: number, minute: number, text: string): RoomRecord {
  const nonce = String(nextNonce++);
  const signed = identity.signMessage(room, nonce, text);
  return {
    seq: BigInt(seq),
    ts: new Date(T0 + minute * MINUTE).toISOString(),
    from: signed.did,
    text: signed.text,
    nonce,
    sig: signed.sig,
  };
}

/** A frame line 0.1.0 would not encode, for the frames later builds added. */
function rawLine(frame: Record<string, unknown>): string {
  return 'tclk1 ' + canonicalJson(frame);
}

interface Deal {
  readonly payer: Identity;
  readonly payee: Identity;
  readonly offer: OfferFrame;
  readonly accept: AcceptFrame;
  readonly contract: string;
  readonly room: string;
  readonly preimage: string;
}

function newDeal(): Deal {
  const payer = Identity.create();
  const payee = Identity.create();
  const lock = generateHashLock();
  const offer = makeOffer({
    from: payer.did,
    role: 'payer',
    amount: '1000',
    asset: 'FLOP',
    lock: 'hash',
    rails: ['flop-htlc'],
    claimByMs: T0 + 120 * MINUTE,
    refundAfterMs: T0 + 180 * MINUTE,
    expiresMs: T0 + 60 * MINUTE,
  });
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  return {
    payer,
    payee,
    offer,
    accept,
    contract: accept.contract,
    room: dealRoom(accept.contract),
    preimage: lock.preimage,
  };
}

const lockOf = (d: Deal, contract = d.contract): string =>
  encodeFrame({ type: 'lock', from: d.payer.did, contract, rail: 'flop-htlc', ref: 'esc-1' } as TclkFrame);
const revealOf = (d: Deal): string =>
  encodeFrame({ type: 'reveal', from: d.payee.did, contract: d.contract, secret: d.preimage } as TclkFrame);
const cancelOf = (d: Deal): string =>
  encodeFrame({ type: 'cancel', from: d.payer.did, contract: d.contract } as TclkFrame);

/** The offer and the accept, posted to `tclk-offers` as the spec says. */
function handshake(d: Deal): RoomRecord[] {
  return [
    post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
    post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(d.accept)),
  ];
}

/** The whole path the scheduled run takes, over records in memory. */
function run(board: readonly RoomRecord[], deals: ReadonlyMap<string, readonly RoomRecord[]> = new Map()) {
  const boardScan = scanRecords(board, { room: OFFER_ROOM });
  const dealScans = new Map([...deals].map(([room, records]) => [room, scanRecords(records, { room })]));
  const { bindings, mismatches } = bindContracts(boardScan.frames);
  const dealFrames = new Map([...dealScans].map(([room, scan]) => [room, scan.frames]));
  const routed = routeFrames({ room: OFFER_ROOM, frames: boardScan.frames }, bindings, dealFrames);
  const boardReport = audit(buildThreads(routed.board), boardScan.rejections, { nowMs: NOW });
  const dealRejections = [...dealScans.values()].flatMap((s) => s.rejections);
  const dealReport = audit(routed.deals, dealRejections, { nowMs: NOW });
  return { boardScan, dealScans, bindings, mismatches, routed, boardReport, dealReport };
}

describe('(a) a contract whose frames are in the rooms the spec gives', () => {
  const d = newDeal();
  const r = run(
    handshake(d),
    new Map([[d.room, [post(d.payer, d.room, 1, 2, lockOf(d)), post(d.payee, d.room, 2, 3, revealOf(d))]]]),
  );

  it('binds the accept and derives the deal room from the recomputed contract id', () => {
    expect(r.mismatches).toEqual([]);
    expect(r.bindings).toHaveLength(1);
    const binding = r.bindings[0];
    expect(binding?.contract).toBe(recomputedContractId(d.offer, d.accept));
    expect(binding?.room).toBe(dealRoom(recomputedContractId(d.offer, d.accept)));
    expect(binding?.room).toBe(d.room);
  });

  it('folds the deal room to claimed, and leaves the board at accepted', () => {
    expect(r.routed.wrongRoom).toEqual([]);
    expect(r.dealReport.byStatus).toEqual({ claimed: 1 });
    expect(r.dealReport.transitionsAccepted).toBe(3);
    expect(r.dealReport.transitionsRejected).toBe(0);
    expect(r.boardReport.byStatus).toEqual({ accepted: 1 });
  });

  it('verifies each deal-room frame against the deal room it was read from', () => {
    const frames = r.dealScans.get(d.room)?.frames ?? [];
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.verification === 'verified')).toBe(true);
  });
});

describe('(b) a cancel between the accept and the lock', () => {
  it('is applied from the deal room', () => {
    const d = newDeal();
    const r = run(handshake(d), new Map([[d.room, [post(d.payer, d.room, 1, 2, cancelOf(d))]]]));
    expect(r.routed.wrongRoom).toEqual([]);
    expect(r.dealReport.byStatus).toEqual({ cancelled: 1 });
  });

  it('is in the wrong room in tclk-offers once the contract is accepted', () => {
    const d = newDeal();
    const cancel = post(d.payer, OFFER_ROOM, 3, 2, cancelOf(d));
    const r = run([...handshake(d), cancel], new Map([[d.room, []]]));

    expect(r.routed.wrongRoom).toHaveLength(1);
    const wrong = r.routed.wrongRoom[0];
    expect(wrong?.record.frame.type).toBe('cancel');
    expect(wrong?.room).toBe(OFFER_ROOM);
    expect(wrong?.expected).toBe(d.room);
    // A good signature, for the room it was posted in. It still moves nothing.
    expect(wrong?.record.verification).toBe('verified');
    expect(r.boardReport.byStatus).toEqual({ accepted: 1 });
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
  });

  it('stays in tclk-offers before any accept, where it closes the offer', () => {
    const d = newDeal();
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 1, cancelOf(d)),
      post(d.payee, OFFER_ROOM, 3, 2, encodeFrame(d.accept)),
    ];
    const r = run(board);
    expect(r.routed.wrongRoom).toEqual([]);
    expect(r.bindings).toEqual([]);
    expect(r.boardReport.byStatus).toEqual({ cancelled: 1 });
  });
});

describe('(c) a validly signed frame in the wrong room', () => {
  it('does not move the contract when the lock is posted in tclk-offers', () => {
    const d = newDeal();
    const lock = post(d.payer, OFFER_ROOM, 3, 2, lockOf(d));
    const r = run([...handshake(d), lock], new Map([[d.room, []]]));

    expect(r.routed.wrongRoom.map((w) => w.record.frame.type)).toEqual(['lock']);
    expect(r.routed.wrongRoom[0]?.record.verification).toBe('verified');
    expect(r.routed.wrongRoom[0]?.expected).toBe(d.room);
    expect(r.boardReport.byStatus).toEqual({ accepted: 1 });
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
    expect(r.boardReport.transitionsAccepted).toBe(1);
  });

  it('keeps an accept read from the deal room out of the fold', () => {
    const d = newDeal();
    const reposted = post(d.payee, d.room, 1, 2, encodeFrame(d.accept));
    const r = run(handshake(d), new Map([[d.room, [reposted]]]));

    expect(r.routed.wrongRoom).toHaveLength(1);
    expect(r.routed.wrongRoom[0]?.record.verification).toBe('verified');
    expect(r.routed.wrongRoom[0]?.room).toBe(d.room);
    expect(r.routed.wrongRoom[0]?.expected).toBe(OFFER_ROOM);
    const thread = r.routed.deals.threads[0];
    expect(thread?.frames.map((f) => f.frame.type)).toEqual(['offer', 'accept']);
    expect(r.dealReport.transitionsRejected).toBe(0);
  });
});

describe('(d) an accept whose contract field is not the recomputed id', () => {
  function badAccept(d: Deal): AcceptFrame {
    return { ...d.accept, contract: '0x' + 'ab'.repeat(32) };
  }

  it('is reported, gives no deal room, and names no contract', () => {
    const d = newDeal();
    const bad = badAccept(d);
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(bad)),
      post(d.payer, OFFER_ROOM, 3, 2, lockOf(d, bad.contract)),
    ];
    const r = run(board);

    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]?.accept.seq).toBe(2n);
    expect(r.mismatches[0]?.recomputed).toBe(d.contract);
    expect(r.bindings).toEqual([]);
    // The lock names the id the accept declared. No accept recomputes to it,
    // so no thread takes the lock.
    const index = buildThreads(r.boardScan.frames);
    expect(index.unattributed.map((f) => f.seq)).toEqual([3n]);
    expect(r.boardReport.byStatus).toEqual({ proposed: 1 });
    expect(
      r.boardReport.findings.some(
        (f) => f.code === 'transition-rejected' && f.detail === 'accept refused: contract id mismatch',
      ),
    ).toBe(true);
  });

  it('does not keep a later valid accept from binding its own room', () => {
    const d = newDeal();
    const bad = badAccept(d);
    const good = makeAccept(d.offer, { from: d.payee.did, statement: d.accept.statement });
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(bad)),
      post(d.payee, OFFER_ROOM, 3, 2, encodeFrame(good)),
    ];
    const r = run(board);

    expect(r.mismatches.map((m) => m.accept.seq)).toEqual([2n]);
    expect(r.bindings.map((b) => b.accept.seq)).toEqual([3n]);
    expect(r.bindings[0]?.room).toBe(dealRoom(good.contract));
    expect(r.bindings[0]?.room).not.toBe(dealRoom(bad.contract));
  });

  it('never takes a thread contract id from an accept that does not recompute', () => {
    // An accept on offer B that carries A's real contract id. The id is valid
    // for A and wrong for B, so B's thread names no contract.
    const a = newDeal();
    const b = newDeal();
    const borrowed: AcceptFrame = { ...b.accept, contract: a.contract };
    const board = [
      ...handshake(a),
      post(b.payer, OFFER_ROOM, 3, 2, encodeFrame(b.offer)),
      post(b.payee, OFFER_ROOM, 4, 3, encodeFrame(borrowed)),
    ];
    const index = buildThreads(scanRecords(board, { room: OFFER_ROOM }).frames);
    const byKey = new Map(index.threads.map((t) => [t.key, t.contractId]));
    expect(byKey.get(a.offer.id)).toBe(a.contract);
    expect(byKey.get(b.offer.id)).toBeNull();
  });

  it('never takes it from an accept that carries a later accept real id', () => {
    // Three accepts on one offer. The first carries the id of the third,
    // which is valid for the third's fields and not for its own.
    const d = newDeal();
    const later = makeAccept(d.offer, { from: d.payee.did, statement: d.accept.statement });
    const early = makeAccept(d.offer, { from: d.payee.did, statement: d.accept.statement });
    const borrowed: AcceptFrame = { ...early, contract: later.contract };
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(borrowed)),
      post(d.payee, OFFER_ROOM, 3, 2, encodeFrame(d.accept)),
      post(d.payee, OFFER_ROOM, 4, 3, encodeFrame(later)),
    ];
    const frames = scanRecords(board, { room: OFFER_ROOM }).frames;
    expect(buildThreads(frames).threads.map((t) => t.contractId)).toEqual([d.contract]);
    expect(bindContracts(frames).bindings.map((b) => b.contract)).toEqual([d.contract]);
  });

  it('uses a later frame contract field only as a consistency check', () => {
    // A lock in the right deal room that names another contract. The room
    // decides the thread; the state machine refuses the mismatched field.
    const d = newDeal();
    const other = '0x' + 'cd'.repeat(32);
    const r = run(handshake(d), new Map([[d.room, [post(d.payer, d.room, 1, 2, lockOf(d, other))]]]));
    expect(r.routed.wrongRoom).toEqual([]);
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
    expect(r.dealReport.findings.map((f) => f.detail)).toContain(
      'lock refused: lock names a different contract',
    );
  });
});

describe('(e) known decoder gaps', () => {
  const d = newDeal();
  const records = [
    post(d.payer, d.room, 1, 2, lockOf(d)),
    post(d.payer, d.room, 2, 3, rawLine({ type: 'heartbeat', from: d.payer.did, contract: d.contract, nonce: '0123456789abcdef' })),
    post(d.payee, d.room, 3, 4, rawLine({ type: 'reveal', from: d.payee.did, contract: d.contract, ref: 'esc-1', secret: d.preimage })),
    post(d.payer, d.room, 4, 5, rawLine({ type: 'refund', from: d.payer.did, contract: d.contract, ref: 'esc-1' })),
    post(d.payer, d.room, 5, 6, rawLine({ type: 'lock', from: d.payer.did, contract: d.contract, rail: 'flop-htlc', ref: 'esc-1', foo: 1 })),
  ];
  const r = run(handshake(d), new Map([[d.room, records]]));
  const scan = r.dealScans.get(d.room);

  it('labels heartbeat, reveal.ref and refund.ref as known gaps, apart from rejections', () => {
    expect(scan?.knownGaps.map((g) => g.gap)).toEqual(['heartbeat', 'reveal.ref', 'refund.ref']);
    expect(scan?.knownGaps.map((g) => g.reason)).toEqual([
      'tclk: unknown frame type: heartbeat',
      'tclk: unknown field on reveal: ref',
      'tclk: unknown field on refund: ref',
    ]);
    expect(scan?.rejections.map((x) => x.reason)).toEqual(['tclk: unknown field on lock: foo']);
  });

  it('keeps known gaps out of the rejected-frame findings', () => {
    const rejected = r.dealReport.findings.filter((f) => f.code === 'frame-rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.detail).toContain('unknown field on lock: foo');
    expect(r.dealReport.byStatus).toEqual({ locked: 1 });
  });

  it('labels by the decoder first refusal only', () => {
    // The decoder stops at the unknown `ref` and never reaches the malformed
    // secret. The label says what 0.1.0 refused first, nothing more.
    const odd = post(d.payee, d.room, 9, 7, rawLine({ type: 'reveal', from: d.payee.did, contract: d.contract, ref: 'x', secret: '0x12' }));
    expect(scanRecords([odd], { room: d.room }).knownGaps.map((g) => g.gap)).toEqual(['reveal.ref']);
  });

  it('keeps a known gap in tclk-offers out of the rejections as well', () => {
    const heartbeat = post(d.payer, OFFER_ROOM, 3, 2, rawLine({ type: 'heartbeat', from: d.payer.did, contract: d.contract, nonce: 'abcdef0123456789' }));
    const board = scanRecords([...handshake(d), heartbeat], { room: OFFER_ROOM });
    expect(board.knownGaps.map((g) => g.gap)).toEqual(['heartbeat']);
    expect(board.rejections).toEqual([]);
  });
});

describe('following the board', () => {
  /** One stored record, written the way the service writes it: the nonce a bare number. */
  function line(record: RoomRecord): string {
    return (
      `{"seq":${record.seq},"ts":${JSON.stringify(record.ts)},"from":${JSON.stringify(record.from)},` +
      `"text":${JSON.stringify(record.text)},"nonce":${String(record.nonce)},"sig":${JSON.stringify(record.sig)}}`
    );
  }

  it('reads the deal room of a contract once its accept arrives', async () => {
    const d = newDeal();
    const board = handshake(d);
    const deal = [post(d.payer, d.room, 1, 2, lockOf(d)), post(d.payee, d.room, 2, 3, revealOf(d))];
    const requested: string[] = [];
    let boardReads = 0;

    const fetch = async (url: string): Promise<Response> => {
      const parts = new URL(url).pathname.split('/');
      requested.push(parts.slice(2).join('/'));
      if (parts[3] === 'export') {
        const body = parts[2] === d.room ? deal.map(line).join('\n') + '\n' : '';
        return new Response(body, { status: 200 });
      }
      // The first board read opens the cursor on an empty room. The next one
      // is the cursor's poll, and carries the offer and the accept.
      const messages = boardReads++ === 0 ? [] : board;
      const page =
        `{"room":${JSON.stringify(parts[2])},"count":${messages.length},` +
        `"first_seq":${messages.length === 0 ? 'null' : '1'},"last_seq":${messages.length},` +
        `"generation":1,"messages":[${messages.map(line).join(',')}]}`;
      return new Response(page, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const transport = new Transport({ baseUrl: 'https://technocore.invalid', fetch });
    const follower = new Follower(transport, { dealRoomIntervalMs: 0 });
    const passes = follower.follow({ waitSeconds: 1 });
    const first = await passes.next();
    await passes.return(undefined);

    if (first.done === true) throw new Error('the follower yielded no pass');
    const pass = first.value;
    expect(requested).toContain(`${d.room}/export`);
    expect(pass.deals.bindings.map((b) => b.room)).toEqual([d.room]);
    expect(pass.deals.roomsRead).toBe(1);
    expect(pass.deals.stopped).toBeNull();
    expect(pass.deals.report.byStatus).toEqual({ claimed: 1 });
    expect(pass.report.byStatus).toEqual({ accepted: 1 });
  });
});
