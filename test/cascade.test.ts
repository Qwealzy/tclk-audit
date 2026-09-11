import { describe, expect, it } from 'vitest';
import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  type AcceptFrame,
  type OfferFrame,
  type TclkFrame,
} from '@flop-labs/tclk';
import { Identity } from 'technocore-client';
import { scanRecords, type RoomRecord } from '../src/frames.js';
import { buildThreads } from '../src/threads.js';
import { audit, type AuditReport } from '../src/audit.js';
import { bindContracts, routeFrames } from '../src/deal-rooms.js';

/**
 * Root causes and consequences, one chain per contract.
 *
 * Neither tclk's SPEC.md nor technocore.chat says when a refusal is the
 * consequence of an earlier one. The rule under test is this package's own,
 * written out in src/audit.ts. Every contract is built and signed here by
 * throwaway identities from `Identity.create()`, which live in memory while
 * the test runs.
 *
 * Several cases put frames in one room and call `audit` on `buildThreads`
 * directly. That tests the fold on its own, whatever room a frame came from.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const NOW = T0 + 90 * MINUTE;

let nextNonce = 1788627060599450000n;

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

const line = (frame: Record<string, unknown>): string => encodeFrame(frame as unknown as TclkFrame);

interface Deal {
  readonly payer: Identity;
  readonly payee: Identity;
  readonly stranger: Identity;
  readonly offer: OfferFrame;
  readonly accept: AcceptFrame;
  readonly contract: string;
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
  return { payer, payee, stranger: Identity.create(), offer, accept, contract: accept.contract, preimage: lock.preimage };
}

const lockBy = (who: Identity, contract: string, ref = 'esc-1'): string =>
  line({ type: 'lock', from: who.did, contract, rail: 'flop-htlc', ref });
const revealBy = (who: Identity, d: Deal, contract = d.contract): string =>
  line({ type: 'reveal', from: who.did, contract, secret: d.preimage });

/** The fold over one room's frames, rooms aside. */
function fold(records: readonly RoomRecord[]): AuditReport {
  const scan = scanRecords(records, { room: OFFER_ROOM });
  return audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
}

/** The scheduled run's path: the handshake on the board, the rest in the deal room. */
function foldDealRoom(d: Deal, dealRecords: (room: string) => RoomRecord[]): AuditReport {
  const board = scanRecords(
    [post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)), post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(d.accept))],
    { room: OFFER_ROOM },
  );
  const room = dealRoom(d.contract);
  const { bindings } = bindContracts(board.frames);
  const deal = scanRecords(dealRecords(room), { room });
  const routed = routeFrames({ room: OFFER_ROOM, frames: board.frames }, bindings, new Map([[room, deal.frames]]));
  return audit(routed.deals, deal.rejections, { nowMs: NOW });
}

/** Every refusal the fold reported, in the fields the rule decides. */
function refusals(report: AuditReport) {
  return report.findings
    .filter((f) => f.code === 'transition-rejected' || f.code === 'transition-blocked')
    .map((f) => ({ seq: f.seq, code: f.code, severity: f.severity, detail: f.detail, causedBy: f.causedBy }));
}

const anomaly = (seq: bigint, detail: string) => ({
  seq,
  code: 'transition-rejected',
  severity: 'anomaly',
  detail,
  causedBy: undefined,
});
const consequence = (seq: bigint, detail: string, causedBy: bigint) => ({
  seq,
  code: 'transition-blocked',
  severity: 'info',
  detail,
  causedBy,
});

describe('a refusal for its own reason is never a consequence', () => {
  it('reports a second accept and a later non-payer lock as two anomalies', () => {
    // A second, valid accept on the same offer is refused for the status. A
    // lock from a key that is not the payer's is refused for that. The second
    // refusal has its own cause, and used to be counted as the first one's.
    const d = newDeal();
    const late = Identity.create();
    const second = makeAccept(d.offer, { from: late.did, statement: d.accept.statement });
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(d.accept)),
      post(late, OFFER_ROOM, 3, 2, encodeFrame(second)),
      post(d.stranger, OFFER_ROOM, 4, 3, lockBy(d.stranger, d.contract)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(3n, 'accept refused: accept in status accepted'),
      anomaly(4n, 'lock refused: only the payer locks'),
    ]);
    expect(report.transitionsRejected).toBe(2);
    expect(report.transitionsBlocked).toBe(0);
  });

  it('keeps it an anomaly right after an open root in the same contract', () => {
    const d = newDeal();
    const report = foldDealRoom(d, (room) => [
      post(d.stranger, room, 1, 2, lockBy(d.stranger, d.contract)),
      post(d.payer, room, 2, 3, lockBy(d.payer, '0x' + 'cd'.repeat(32))),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(1n, 'lock refused: only the payer locks'),
      anomaly(2n, 'lock refused: lock names a different contract'),
    ]);
  });
});

describe('a real chain stays one root and its consequences', () => {
  it('chains a second status refusal when the status never moved', () => {
    const d = newDeal();
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 1, lockBy(d.payer, d.contract)),
      post(d.payee, OFFER_ROOM, 3, 2, revealBy(d.payee, d)),
      post(d.payee, OFFER_ROOM, 4, 3, encodeFrame(d.accept)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(2n, 'lock refused: lock in status proposed'),
      consequence(3n, 'reveal refused: reveal in status proposed', 2n),
    ]);
    expect(report.transitionsRejected).toBe(1);
    expect(report.transitionsBlocked).toBe(1);
  });

  it('chains a lock to the expired accept before it', () => {
    // The case the rule was written for. The accept is refused for its own
    // reason, and the lock that needed it is refused for the status.
    const d = newDeal();
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 61, encodeFrame(d.accept)),
      post(d.payer, OFFER_ROOM, 3, 62, lockBy(d.payer, d.contract)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(2n, 'accept refused: offer has expired'),
      consequence(3n, 'lock refused: lock in status proposed', 2n),
    ]);
  });

  it('keeps a chain on its first root when another fault comes in between', () => {
    const d = newDeal();
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 1, lockBy(d.payer, d.contract)),
      post(d.stranger, OFFER_ROOM, 3, 2, line({ type: 'cancel', from: d.stranger.did, contract: d.contract })),
      post(d.payee, OFFER_ROOM, 4, 3, revealBy(d.payee, d)),
      post(d.payee, OFFER_ROOM, 5, 4, encodeFrame(d.accept)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(2n, 'lock refused: lock in status proposed'),
      anomaly(3n, 'cancel refused: cancel from a non-party'),
      consequence(4n, 'reveal refused: reveal in status proposed', 2n),
    ]);
  });
});

describe('a transition that moves the status breaks the chain', () => {
  it('starts a new root after it, and chains later refusals to the new one', () => {
    const d = newDeal();
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 1, lockBy(d.payer, d.contract)),
      post(d.payee, OFFER_ROOM, 3, 2, encodeFrame(d.accept)),
      post(d.payee, OFFER_ROOM, 4, 3, revealBy(d.payee, d)),
      post(d.payer, OFFER_ROOM, 5, 4, line({ type: 'refund', from: d.payer.did, contract: d.contract })),
    ]);
    // The accept moved the contract from proposed to accepted between the lock
    // and the reveal, so the reveal is a new root and not the lock's
    // consequence. The refund comes with the status unmoved since the reveal.
    expect(refusals(report)).toEqual([
      anomaly(2n, 'lock refused: lock in status proposed'),
      anomaly(4n, 'reveal refused: reveal in status accepted'),
      consequence(5n, 'refund refused: refund in status accepted', 4n),
    ]);
    expect(report.transitionsAccepted).toBe(1);
    expect(report.transitionsRejected).toBe(2);
    expect(report.transitionsBlocked).toBe(1);
  });

  it('breaks it when a frame naming another contract moves the status', () => {
    // The machine keeps one status for the offer. The offerer's cancel names
    // the second contract and still moves that status from proposed to
    // cancelled, so the next status refusal on the first contract is a new root.
    const d = newDeal();
    const late = Identity.create();
    const other = makeAccept(d.offer, { from: late.did, statement: d.accept.statement });
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 1, lockBy(d.payer, d.contract)),
      post(d.payer, OFFER_ROOM, 3, 2, line({ type: 'cancel', from: d.payer.did, contract: other.contract })),
      post(d.payer, OFFER_ROOM, 4, 3, lockBy(d.payer, d.contract, 'esc-2')),
      post(d.payee, OFFER_ROOM, 5, 4, encodeFrame(d.accept)),
      post(late, OFFER_ROOM, 6, 5, encodeFrame(other)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(2n, 'lock refused: lock in status proposed'),
      anomaly(4n, 'lock refused: lock in status cancelled'),
      consequence(5n, 'accept refused: accept in status cancelled', 4n),
      anomaly(6n, 'accept refused: accept in status cancelled'),
    ]);
    expect(report.byStatus).toEqual({ cancelled: 1 });
  });
});

describe('each contract carries its own chain', () => {
  it('does not chain one contract refusal to a root in another', () => {
    // The second accept names its own contract. Its refusal is a root there.
    // The payee's reveal names the first contract, which has no open root.
    const d = newDeal();
    const late = Identity.create();
    const second = makeAccept(d.offer, { from: late.did, statement: d.accept.statement });
    const report = fold([
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(d.accept)),
      post(late, OFFER_ROOM, 3, 2, encodeFrame(second)),
      post(d.payee, OFFER_ROOM, 4, 3, revealBy(d.payee, d)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(3n, 'accept refused: accept in status accepted'),
      anomaly(4n, 'reveal refused: reveal in status accepted'),
    ]);
  });
});

describe('in a deal room', () => {
  it('reports a stranger lock and a later stranger reveal as two anomalies', () => {
    // The payer's own lock comes in between, so the stranger's reveal is
    // refused for who sent it. It used to be counted as the first refusal's.
    const d = newDeal();
    const report = foldDealRoom(d, (room) => [
      post(d.stranger, room, 1, 2, lockBy(d.stranger, d.contract)),
      post(d.payer, room, 2, 3, lockBy(d.payer, d.contract, 'esc-2')),
      post(d.stranger, room, 3, 4, revealBy(d.stranger, d)),
    ]);
    expect(refusals(report)).toEqual([
      anomaly(1n, 'lock refused: only the payer locks'),
      anomaly(3n, 'reveal refused: only the payee reveals'),
    ]);
    expect(report.byStatus).toEqual({ locked: 1 });
  });
});
