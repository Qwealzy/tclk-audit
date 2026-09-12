import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  tryDecodeFrame,
  type AcceptFrame,
  type OfferFrame,
  type TclkFrame,
} from '@flop-labs/tclk';
import { Identity, Transport } from 'technocore-client';
import { parseExportLine, scanRecords, type RoomRecord } from '../src/frames.js';
import { buildThreads } from '../src/threads.js';
import { audit, type AuditReport, type Finding } from '../src/audit.js';
import { bindContracts, readDealRooms, routeFrames } from '../src/deal-rooms.js';
import { Follower } from '../src/follow.js';

/**
 * The signature policy. Only a frame whose signature verifies, and whose
 * `from` is the key that signed it, reaches the audit.
 *
 * STATED [SPEC.md section 2, tclk 0.1.0, lines 56 to 58]: a frame's `from`
 * "MUST match the transport-verified `from` of the record that carried it. An
 * unsigned frame is data, not a commitment". STATED [RENDERING]: a record with
 * no `sig` is "not re-verifiable", which is not "invalid".
 *
 * Each of the five outcomes has its own tests below, then what the policy
 * changes in threads.ts, deal-rooms.ts and the audit window. Every key is a
 * throwaway from `Identity.create()`, in memory while the test runs.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const NOW = T0 + 30 * MINUTE;
const FIXTURE = fileURLToPath(new URL('./fixtures/tclk-slice.jsonl', import.meta.url));

let nextNonce = 1788627060599490000n;

/** A record as the room stores it, signed by `signer` for `room`. */
function post(signer: Identity, room: string, seq: number, minute: number, text: string): RoomRecord {
  const nonce = String(nextNonce++);
  const signed = signer.signMessage(room, nonce, text);
  return {
    seq: BigInt(seq),
    ts: new Date(T0 + minute * MINUTE).toISOString(),
    from: signed.did,
    text: signed.text,
    nonce,
    sig: signed.sig,
  };
}

/** A record with no signature, as a plain name or a did:key would send it. */
function unsigned(from: string, seq: number, minute: number, text: string): RoomRecord {
  return { seq: BigInt(seq), ts: new Date(T0 + minute * MINUTE).toISOString(), from, text };
}

/** A record `signer` signed, served as if `from` had sent it. Its signature does not verify. */
function forged(signer: Identity, from: string, room: string, seq: number, minute: number, text: string): RoomRecord {
  return { ...post(signer, room, seq, minute, text), from };
}

interface Deal {
  readonly payer: Identity;
  readonly payee: Identity;
  readonly stranger: Identity;
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
    stranger: Identity.create(),
    offer,
    accept,
    contract: accept.contract,
    room: dealRoom(accept.contract),
    preimage: lock.preimage,
  };
}

const lockText = (from: string, d: Deal): string =>
  encodeFrame({ type: 'lock', from, contract: d.contract, rail: 'flop-htlc', ref: 'esc-1' } as TclkFrame);
const revealText = (d: Deal): string =>
  encodeFrame({ type: 'reveal', from: d.payee.did, contract: d.contract, secret: d.preimage } as TclkFrame);

const handshake = (d: Deal): RoomRecord[] => [
  post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
  post(d.payee, OFFER_ROOM, 2, 1, encodeFrame(d.accept)),
];

/** The scheduled run's path over records in memory. */
function run(d: Deal, board: readonly RoomRecord[], deal: readonly RoomRecord[] = []) {
  const boardScan = scanRecords(board, { room: OFFER_ROOM });
  const dealScan = scanRecords(deal, { room: d.room });
  const { bindings } = bindContracts(boardScan.frames);
  const routed = routeFrames({ room: OFFER_ROOM, frames: boardScan.frames }, bindings, new Map([[d.room, dealScan.frames]]));
  const boardReport = audit(buildThreads(routed.board), boardScan.rejections, { nowMs: NOW });
  const dealReport = audit(routed.deals, dealScan.rejections, { nowMs: NOW });
  return { boardScan, dealScan, bindings, routed, boardReport, dealReport };
}

/** Findings from the signature check, as code, severity and detail. */
function signatureFindings(report: AuditReport): [Finding['code'], Finding['severity'], string][] {
  return report.findings
    .filter((f) => f.code.startsWith('frame-') && f.code !== 'frame-rejected' && f.code !== 'frame-rejected-shape')
    .map((f) => [f.code, f.severity, f.detail]);
}

describe('the committed fixture, where every frame verifies', () => {
  const records = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => parseExportLine(l))
    .filter((r): r is RoomRecord => r !== null);

  it('leaves nothing out, so the audit folds what it folded before', () => {
    const scan = scanRecords(records, { room: OFFER_ROOM });
    const decoded = records.filter((r) => tryDecodeFrame(r.text) !== null).length;
    expect(decoded).toBeGreaterThan(1000);
    expect(scan.frames).toHaveLength(decoded);
    expect(scan.rejections.filter((r) => r.refusedBy === 'signature-check')).toEqual([]);
  });

  it('loses a contract the fixture binds once that accept is unsigned', () => {
    // A real contract from the ring. Its accept is the only accept on its
    // offer, so no other accept can bind it once this one is gone.
    const scan = scanRecords(records, { room: OFFER_ROOM });
    const thread = buildThreads(scan.frames).threads.find(
      (t) => t.accept !== null && t.frames.filter((f) => f.frame.type === 'accept').length === 1,
    );
    if (thread?.accept === undefined || thread.accept === null || thread.contractId === null) {
      throw new Error('the fixture has no contract with a single accept');
    }
    const acceptSeq = thread.accept.seq;
    expect(bindContracts(scan.frames).bindings.map((b) => b.key)).toContain(thread.key);

    const stripped = records.map((r) => {
      if (BigInt(r.seq) !== acceptSeq) return r;
      const { sig: _sig, nonce: _nonce, ...bare } = r;
      return bare;
    });
    const again = scanRecords(stripped, { room: OFFER_ROOM });
    expect(again.rejections.filter((r) => r.refusedBy === 'signature-check').map((r) => [r.seq, r.verification])).toEqual([
      [acceptSeq, 'unsigned'],
    ]);
    const { bindings } = bindContracts(again.frames);
    expect(bindings.map((b) => b.key)).not.toContain(thread.key);
    expect(bindings.map((b) => b.room)).not.toContain(dealRoom(thread.contractId));
  });
});

describe('verified', () => {
  it('is applied', () => {
    const d = newDeal();
    const r = run(d, handshake(d), [post(d.payer, d.room, 1, 2, lockText(d.payer.did, d)), post(d.payee, d.room, 2, 3, revealText(d))]);
    expect(r.dealScan.frames.map((f) => f.verification)).toEqual(['verified', 'verified']);
    expect(r.dealReport.byStatus).toEqual({ claimed: 1 });
    expect(signatureFindings(r.dealReport)).toEqual([]);
  });
});

describe('unsigned', () => {
  it('an unsigned accept binds no contract, so no deal room is read for it', () => {
    const d = newDeal();
    const board = [post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)), unsigned(d.payee.did, 2, 1, encodeFrame(d.accept))];
    const r = run(d, board);
    expect(r.bindings).toEqual([]);
    expect(r.boardReport.byStatus).toEqual({ proposed: 1 });
    expect(signatureFindings(r.boardReport)).toEqual([
      ['frame-unsigned', 'info', `tclk-audit: unsigned accept, not re-verifiable (from ${d.payee.did})`],
    ]);
  });

  it('an unsigned lock moves nothing in a deal room', () => {
    const d = newDeal();
    const r = run(d, handshake(d), [unsigned(d.payer.did, 1, 2, lockText(d.payer.did, d))]);
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
    expect(r.dealReport.transitionsRejected).toBe(0);
    expect(signatureFindings(r.dealReport)).toEqual([
      ['frame-unsigned', 'info', `tclk-audit: unsigned lock, not re-verifiable (from ${d.payer.did})`],
    ]);
  });
});

describe('from-mismatch', () => {
  it('a lock signed by another key moves nothing, and is counted apart', () => {
    // The stranger signs a lock that names the payer as its sender.
    const d = newDeal();
    const r = run(d, handshake(d), [post(d.stranger, d.room, 1, 2, lockText(d.payer.did, d))]);
    expect(r.dealScan.rejections.map((x) => x.verification)).toEqual(['from-mismatch']);
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
    expect(signatureFindings(r.dealReport)).toEqual([
      ['frame-from-mismatch', 'notice', `tclk-audit: lock whose from is not the key that signed it (from ${d.stranger.did})`],
    ]);
  });

  it('an accept signed by another key binds nothing', () => {
    const d = newDeal();
    const board = [post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)), post(d.stranger, OFFER_ROOM, 2, 1, encodeFrame(d.accept))];
    const r = run(d, board);
    expect(r.boardScan.rejections.map((x) => x.verification)).toEqual(['from-mismatch']);
    expect(r.bindings).toEqual([]);
    expect(r.boardReport.byStatus).toEqual({ proposed: 1 });
  });
});

describe('bad-signature', () => {
  it("a lock carrying another key's signature moves nothing, and is counted on its own", () => {
    // The room says the payer sent it. The signature is the stranger's.
    const d = newDeal();
    const r = run(d, handshake(d), [forged(d.stranger, d.payer.did, d.room, 1, 2, lockText(d.payer.did, d))]);
    expect(r.dealScan.rejections.map((x) => x.verification)).toEqual(['bad-signature']);
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
    expect(signatureFindings(r.dealReport)).toEqual([
      ['frame-bad-signature', 'notice', `tclk-audit: lock whose signature does not verify (from ${d.payer.did})`],
    ]);
  });

  it('a lock whose nonce changed after signing moves nothing', () => {
    const d = newDeal();
    const good = post(d.payer, d.room, 1, 2, lockText(d.payer.did, d));
    const moved = { ...good, nonce: (BigInt(String(good.nonce)) + 1n).toString() };
    const r = run(d, handshake(d), [moved]);
    expect(r.dealScan.rejections.map((x) => x.verification)).toEqual(['bad-signature']);
    expect(r.dealReport.byStatus).toEqual({ accepted: 1 });
  });
});

describe('unverifiable', () => {
  it('without a room nothing can be checked, and the sender is not named', () => {
    const d = newDeal();
    const scan = scanRecords(handshake(d));
    expect(scan.frames).toEqual([]);
    expect(scan.rejections.map((x) => [x.refusedBy, x.verification])).toEqual([
      ['signature-check', 'unverifiable'],
      ['signature-check', 'unverifiable'],
    ]);
    const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
    expect(signatureFindings(report)).toEqual([
      ['frame-unverifiable', 'info', 'tclk-audit: offer whose signature this reader could not check'],
      ['frame-unverifiable', 'info', 'tclk-audit: accept whose signature this reader could not check'],
    ]);
    for (const f of report.findings) expect(f.detail).not.toContain('(from');
  });

  it('a nonce that lost digits, or none at all, cannot be checked either', () => {
    const d = newDeal();
    const good = post(d.payer, d.room, 1, 2, lockText(d.payer.did, d));
    const lossy = { ...good, nonce: Number(good.nonce) };
    const { nonce: _nonce, ...noNonce } = good;
    for (const record of [lossy, noNonce]) {
      const scan = scanRecords([record], { room: d.room });
      expect(scan.frames).toEqual([]);
      expect(scan.rejections.map((x) => x.verification)).toEqual(['unverifiable']);
    }
  });

  it('covers a nonce the transport would never sign, without blaming the sender', () => {
    // technocore-client's storedMessagePayload takes 1 to 19 digits. Anything
    // else leaves no payload to check, which is this reader's limit. Counting
    // it as a signature that does not verify would name the sender for it, and
    // would add to the count that says this reader may be at fault.
    const d = newDeal();
    const good = post(d.payer, d.room, 1, 2, lockText(d.payer.did, d));
    for (const nonce of ['1'.repeat(20), '+123', '', '12e4']) {
      const scan = scanRecords([{ ...good, nonce }], { room: d.room });
      expect(scan.frames, nonce).toEqual([]);
      expect(scan.rejections.map((x) => x.verification), nonce).toEqual(['unverifiable']);
      const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
      expect(report.findings.map((f) => [f.code, f.detail])).toEqual([
        ['frame-unverifiable', 'tclk-audit: lock whose signature this reader could not check'],
      ]);
    }
  });

  it('does not come up on the path the tool runs, which passes the room and keeps every digit', async () => {
    // readDealRooms reads through /export, as the scheduled run and the
    // follower do. The service writes the nonce as a bare 19-digit number.
    const d = newDeal();
    const records = [post(d.payer, d.room, 1, 2, lockText(d.payer.did, d)), post(d.payee, d.room, 2, 3, revealText(d))];
    const line = (r: RoomRecord): string =>
      `{"seq":${r.seq},"ts":${JSON.stringify(r.ts)},"from":${JSON.stringify(r.from)},` +
      `"text":${JSON.stringify(r.text)},"nonce":${String(r.nonce)},"sig":${JSON.stringify(r.sig)}}`;
    const body = records.map(line).join('\n') + '\n';
    expect(body).toContain(`"nonce":${String(records[0]?.nonce)},`);
    const fetch = async (): Promise<Response> => new Response(body, { status: 200 });
    const reads = await readDealRooms(new Transport({ baseUrl: 'https://technocore.invalid', fetch }), [d.room]);
    const scan = reads.scans.get(d.room);
    expect(scan?.frames.map((f) => f.verification)).toEqual(['verified', 'verified']);
    expect(scan?.rejections).toEqual([]);
  });
});

describe('what the policy changes in threads.ts', () => {
  it('an unsigned copy of an offer, posted first, does not take its id', () => {
    const d = newDeal();
    const board = [
      unsigned('some-nick', 1, 0, encodeFrame(d.offer)),
      post(d.payer, OFFER_ROOM, 2, 0.5, encodeFrame(d.offer)),
      post(d.payee, OFFER_ROOM, 3, 1, encodeFrame(d.accept)),
    ];
    const [thread] = buildThreads(scanRecords(board, { room: OFFER_ROOM }).frames).threads;
    expect(thread?.offer?.seq).toBe(2n);
    expect(thread?.offer?.from).toBe(d.payer.did);
  });

  it('an accept whose signature does not verify is never the accept the machine takes', () => {
    // Both accepts are well formed and recompute. Only the second is signed
    // by the key that sent it.
    const d = newDeal();
    const early = makeAccept(d.offer, { from: d.payee.did, statement: d.accept.statement });
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      forged(d.stranger, d.payee.did, OFFER_ROOM, 2, 0.5, encodeFrame(early)),
      post(d.payee, OFFER_ROOM, 3, 1, encodeFrame(d.accept)),
    ];
    const frames = scanRecords(board, { room: OFFER_ROOM }).frames;
    const [thread] = buildThreads(frames).threads;
    expect(thread?.accept?.seq).toBe(3n);
    expect(thread?.contractId).toBe(d.contract);
    expect(bindContracts(frames).bindings.map((b) => b.contract)).toEqual([d.contract]);
  });

  it('a lock naming the contract of an unsigned accept belongs to no thread', () => {
    const d = newDeal();
    const board = [
      post(d.payer, OFFER_ROOM, 1, 0, encodeFrame(d.offer)),
      unsigned(d.payee.did, 2, 1, encodeFrame(d.accept)),
      post(d.payer, OFFER_ROOM, 3, 2, lockText(d.payer.did, d)),
    ];
    const index = buildThreads(scanRecords(board, { room: OFFER_ROOM }).frames);
    expect(index.unattributed.map((f) => f.seq)).toEqual([3n]);
    expect(index.threads.map((t) => t.contractId)).toEqual([null]);
  });
});

describe('what the policy changes in deal-rooms.ts', () => {
  it('counts a frame in the wrong room only when its signature verifies', () => {
    const d = newDeal();
    const signedLock = post(d.payer, OFFER_ROOM, 3, 2, lockText(d.payer.did, d));
    const unsignedLock = unsigned(d.payer.did, 4, 3, lockText(d.payer.did, d));
    const r = run(d, [...handshake(d), signedLock, unsignedLock]);
    expect(r.routed.wrongRoom.map((w) => w.record.seq)).toEqual([3n]);
    expect(r.boardScan.rejections.map((x) => [x.seq, x.verification])).toEqual([[4n, 'unsigned']]);
  });
});

describe('the follower', () => {
  it('keeps its rejection list bounded when nothing in the room verifies', async () => {
    // Unverified frames are rejections now, and the follower drops rejections
    // older than its oldest frame. With no frame at all there is no such seq,
    // so the list is capped by count as well.
    const d = newDeal();
    const window = 3;
    const stored = Array.from({ length: 10 }, (_, i) =>
      unsigned(d.payer.did, 200 + i, i, encodeFrame({ type: 'cancel', from: d.payer.did, contract: d.contract } as TclkFrame)),
    );
    const line = (r: RoomRecord): string =>
      `{"seq":${r.seq},"ts":${JSON.stringify(r.ts)},"from":${JSON.stringify(r.from)},"text":${JSON.stringify(r.text)}}`;
    let polls = 0;
    const fetch = async (url: string): Promise<Response> => {
      const parts = new URL(url).pathname.split('/');
      if (parts[3] === 'export') return new Response('', { status: 200 });
      const messages = polls++ === 0 ? [] : stored;
      return new Response(
        `{"room":${JSON.stringify(parts[2])},"count":${messages.length},` +
          `"first_seq":${messages.length === 0 ? 'null' : '200'},"last_seq":${messages.length === 0 ? 'null' : '209'},` +
          `"generation":1,"messages":[${messages.map(line).join(',')}]}`,
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const follower = new Follower(new Transport({ baseUrl: 'https://technocore.invalid', fetch }), {
      windowFrames: window,
      dealRoomIntervalMs: 0,
    });
    const passes = follower.follow({ waitSeconds: 1 });
    const first = await passes.next();
    await passes.return(undefined);
    if (first.done === true) throw new Error('the follower yielded no pass');

    const unsignedFindings = first.value.report.findings.filter((f) => f.code === 'frame-unsigned');
    expect(unsignedFindings.length).toBe(window);
    // The newest are the ones kept.
    expect(unsignedFindings.map((f) => f.seq)).toEqual([207n, 208n, 209n]);
  });
});

describe('the audit window', () => {
  it('does not count a frame the signature check left out', () => {
    // window.test.ts has the rule and the rest of its cases. This is the one
    // that belongs to the signature policy.
    const d = newDeal();
    const other = newDeal();
    const board = [
      post(other.payer, OFFER_ROOM, 10, 0, encodeFrame(other.offer)),
      post(d.payee, OFFER_ROOM, 100, 1, encodeFrame(d.accept)),
      unsigned(d.payer.did, 1000, 2, lockText(d.payer.did, d)),
    ];
    const scan = scanRecords(board, { room: OFFER_ROOM });
    const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
    expect([report.windowFirstSeq, report.windowLastSeq]).toEqual([10n, 100n]);
    expect(report.findings.map((f) => f.code)).toContain('accept-without-offer');
  });
});
