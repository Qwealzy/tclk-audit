import { describe, expect, it } from 'vitest';
import {
  OFFER_ROOM,
  canonicalJson,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  type TclkFrame,
} from '@flop-labs/tclk';
import { Identity } from 'technocore-client';
import { scanRecords, type RoomRecord } from '../src/frames.js';
import { buildThreads } from '../src/threads.js';
import { audit, type AuditReport } from '../src/audit.js';

/**
 * What the audit's window is, and what may move it.
 *
 * The window is what the audit folded. Only a frame that decoded, passed the
 * shape check and verified is in it. It sets the warm-up boundary, and a thread
 * whose earliest frame sits inside that boundary is not reported as an orphan,
 * because the ring drops what came before any window (see `warmupFraction`).
 *
 * So a line that never became a frame must stay out of it. PROBED 2026-09-12
 * before this rule: one unsigned message reading `tclk1 {"type":"lock"}` moved
 * the boundary from 1040 to 1200 in a 1000..1200 window and hid an orphan
 * accept at 1100. A line the decoder refuses, one the shape check refuses and
 * one the signature check leaves out all did it, signed or not.
 *
 * A verified frame still sets the window, which is the point of the warm-up.
 * The last case below pins that.
 *
 * The findings file states a different and wider range, every tclk line in the
 * ring, and computes it itself. scheduled-audit.test.ts covers that one.
 *
 * Every key here is a throwaway from `Identity.create()`, in memory while the
 * test runs.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const NOW = T0 + 300 * MINUTE;

let nextNonce = 1788627060599700000n;

function post(signer: Identity, seq: number, text: string): RoomRecord {
  const nonce = String(nextNonce++);
  const signed = signer.signMessage(OFFER_ROOM, nonce, text);
  return {
    seq: BigInt(seq),
    ts: new Date(T0 + MINUTE).toISOString(),
    from: signed.did,
    text: signed.text,
    nonce,
    sig: signed.sig,
  };
}

function unsigned(from: string, seq: number, text: string): RoomRecord {
  return { seq: BigInt(seq), ts: new Date(T0 + MINUTE).toISOString(), from, text };
}

function newDeal() {
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
  return { payer, payee, offer, accept: makeAccept(offer, { from: payee.did, statement: lock.hash }) };
}

const deal = newDeal();
const orphan = newDeal();
const stranger = Identity.create();

/**
 * Four verified frames at seq 1000 to 1200. The accept at 1100 belongs to an
 * offer that is not here, so it is an orphan unless the warm-up boundary
 * reaches it. With this window the boundary is 1000 + (1200 - 1000) / 5, which
 * is 1040, and the orphan is reported.
 */
const base = (): RoomRecord[] => [
  post(deal.payer, 1000, encodeFrame(deal.offer)),
  post(deal.payee, 1010, encodeFrame(deal.accept)),
  post(orphan.payee, 1100, encodeFrame(orphan.accept)),
  post(deal.payer, 1200, encodeFrame({ type: 'cancel', from: deal.payer.did, contract: deal.accept.contract } as TclkFrame)),
];

/** A frame whose type is an array. The decoder takes it, the shape check does not. */
const arrayTypeLine = (): string =>
  'tclk1 ' +
  canonicalJson({ type: ['lock'], from: stranger.did, contract: '0x' + 'ab'.repeat(32), rail: 'flop-htlc', ref: 'r' });

/** A well-formed frame, so only its signature keeps it out. */
const wellFormedLine = (): string =>
  encodeFrame({ type: 'cancel', from: stranger.did, contract: deal.accept.contract } as TclkFrame);

function auditOf(records: readonly RoomRecord[]): { report: AuditReport; boundary: bigint | null } {
  const scan = scanRecords(records, { room: OFFER_ROOM });
  const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
  const boundary =
    report.windowFirstSeq === null || report.windowLastSeq === null
      ? null
      : report.windowFirstSeq + BigInt(Math.floor(Number(report.windowLastSeq - report.windowFirstSeq) * 0.2));
  return { report, boundary };
}

const orphanReported = (report: AuditReport): boolean =>
  report.findings.some((f) => f.code === 'accept-without-offer');

describe('the window covers what the audit folded', () => {
  it('reports the orphan accept when nothing else is in the room', () => {
    const { report, boundary } = auditOf(base());
    expect([report.windowFirstSeq, report.windowLastSeq]).toEqual([1000n, 1200n]);
    expect(boundary).toBe(1040n);
    expect(orphanReported(report)).toBe(true);
  });

  /** One extra line at seq 2000, of each kind a stranger can post for free. */
  const cheap: [string, () => RoomRecord, string][] = [
    ['an unsigned line the decoder refuses', () => unsigned('nick', 2000, 'tclk1 {"type":"lock"}'), 'frame-rejected'],
    ['a signed line the decoder refuses', () => post(stranger, 2000, 'tclk1 {"type":"lock"}'), 'frame-rejected'],
    ['an unsigned frame the shape check refuses', () => unsigned('nick', 2000, arrayTypeLine()), 'frame-rejected-shape'],
    ['a signed frame the shape check refuses', () => post(stranger, 2000, arrayTypeLine()), 'frame-rejected-shape'],
    ['an unsigned frame the signature check leaves out', () => unsigned(stranger.did, 2000, wellFormedLine()), 'frame-unsigned'],
    [
      'a frame whose signature does not verify',
      () => ({ ...post(stranger, 2000, wellFormedLine()), from: deal.payer.did }),
      'frame-bad-signature',
    ],
  ];

  it.each(cheap)('does not let %s move the boundary', (_label, record, code) => {
    const { report, boundary } = auditOf([...base(), record()]);
    expect([report.windowFirstSeq, report.windowLastSeq]).toEqual([1000n, 1200n]);
    expect(boundary).toBe(1040n);
    expect(orphanReported(report)).toBe(true);
    // The line is still reported. It is out of the window, not out of the file.
    expect(report.findings.map((f) => f.code)).toContain(code);
  });

  it('still lets a verified frame set the window, which is what the warm-up is for', () => {
    // The rule keeps out what a stranger gets for free. A real frame at 2000
    // widens the window, the boundary moves to 1200, and the accept at 1100 is
    // then inside it. STATED [RETENTION]: the start of any window is missing
    // what came before it, so an apparent orphan there is the ring, not misconduct.
    const later = newDeal();
    const { report, boundary } = auditOf([...base(), post(later.payer, 2000, encodeFrame(later.offer))]);
    expect([report.windowFirstSeq, report.windowLastSeq]).toEqual([1000n, 2000n]);
    expect(boundary).toBe(1200n);
    expect(orphanReported(report)).toBe(false);
  });

  it('has no window at all when nothing verified, and reports every line it refused', () => {
    const records = [
      unsigned('nick', 1000, 'tclk1 {"type":"lock"}'),
      unsigned('nick', 1100, arrayTypeLine()),
      unsigned(stranger.did, 1200, wellFormedLine()),
    ];
    const { report, boundary } = auditOf(records);
    expect([report.windowFirstSeq, report.windowLastSeq]).toEqual([null, null]);
    expect(boundary).toBeNull();
    expect(report.findings.map((f) => f.code)).toEqual([
      'frame-rejected',
      'frame-rejected-shape',
      'frame-unsigned',
    ]);
  });
});
