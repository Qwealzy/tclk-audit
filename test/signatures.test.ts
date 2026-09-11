import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeFrame, type TclkFrame } from '@flop-labs/tclk';
import { Identity } from 'technocore-client';
import { parseExportLine, scanRecords, type RoomRecord } from '../src/frames.js';

/**
 * Signatures and senders, checked against SPEC.md section 2 of tclk 0.1.0.
 * What the policy does with each outcome is in signature-policy.test.ts.
 *
 * The vectors are signed here by throwaway identities that exist only in
 * memory while the test runs. No key is read or written.
 */

const ROOM = 'tclk-offers';
const LF = String.fromCharCode(10);
/** 19 digits, past 2^53, so JSON.parse cannot hold it as a number. */
const NONCE = '1788627060599440453';
const FIXTURE = fileURLToPath(new URL('./fixtures/tclk-slice.jsonl', import.meta.url));

const signer = Identity.create();
const other = Identity.create();

/** A cancel frame sent as `from`, in tclk's canonical encoding. */
function cancelText(from: string): string {
  return encodeFrame({ type: 'cancel', from, contract: '0x' + 'a'.repeat(64) } as TclkFrame);
}

/** One `/export` line, built by hand so the nonce stays a JSON number literal. */
function exportLine(fields: { from: string; text: string; nonce?: string; sig?: string }): string {
  const parts = [
    '"seq":1',
    '"ts":"2026-09-05T16:50:22.764515Z"',
    '"from":' + JSON.stringify(fields.from),
    '"text":' + JSON.stringify(fields.text),
  ];
  if (fields.nonce !== undefined) parts.push('"nonce":' + fields.nonce);
  if (fields.sig !== undefined) parts.push('"sig":' + JSON.stringify(fields.sig));
  return '{' + parts.join(',') + '}';
}

/**
 * What checking one line's signature found. A verified frame is in `frames`.
 * Any other outcome is the one rejection, from the signature check.
 */
function verificationOf(line: string, options: { room?: string } = { room: ROOM }): string | undefined {
  const record = parseExportLine(line);
  if (record === null) throw new Error('the line did not parse');
  const scan = scanRecords([record], options);
  expect(scan.frames.length + scan.rejections.length).toBe(1);
  if (scan.frames.length === 1) return scan.frames[0]?.verification;
  expect(scan.rejections[0]?.refusedBy).toBe('signature-check');
  return scan.rejections[0]?.verification;
}

const fixture = readFileSync(FIXTURE, 'utf8')
  .split(LF)
  .filter((l) => l.length > 0)
  .map((l) => parseExportLine(l))
  .filter((r): r is RoomRecord => r !== null);

describe('nonces keep every digit', () => {
  it('round-trips a nonce past 2^53 to the same string', () => {
    const line = exportLine({ from: signer.did, text: cancelText(signer.did), nonce: NONCE, sig: 'x' });
    expect(line).toContain('"nonce":' + NONCE);
    expect(line).not.toContain('"nonce":"');

    const record = parseExportLine(line);
    expect(record?.nonce).toBe(NONCE);
    const again = JSON.parse(JSON.stringify({ nonce: record?.nonce })) as { nonce: string };
    expect(again.nonce).toBe(NONCE);

    // A plain JSON.parse loses digits. That is the failure being fixed.
    expect(String((JSON.parse(line) as { nonce: number }).nonce)).not.toBe(NONCE);
  });
});

describe('each frame carries what its signature check found', () => {
  it('marks a frame signed by the key its from names as verified', () => {
    const signed = signer.signMessage(ROOM, NONCE, cancelText(signer.did));
    const line = exportLine({ from: signer.did, text: signed.text, nonce: NONCE, sig: signed.sig });
    expect(verificationOf(line)).toBe('verified');
  });

  it('marks a frame whose from names another key as from-mismatch', () => {
    const signed = signer.signMessage(ROOM, NONCE, cancelText(other.did));
    const line = exportLine({ from: signer.did, text: signed.text, nonce: NONCE, sig: signed.sig });
    expect(verificationOf(line)).toBe('from-mismatch');
  });

  it('marks a signature that does not verify as bad-signature', () => {
    const signed = signer.signMessage(ROOM, NONCE, cancelText(signer.did));
    const wrongNonce = (BigInt(NONCE) + 1n).toString();
    const moved = exportLine({ from: signer.did, text: signed.text, nonce: wrongNonce, sig: signed.sig });
    expect(verificationOf(moved)).toBe('bad-signature');

    // Another key's signature over the same bytes does not verify for this sender.
    const forged = other.signMessage(ROOM, NONCE, cancelText(signer.did));
    const line = exportLine({ from: signer.did, text: forged.text, nonce: NONCE, sig: forged.sig });
    expect(verificationOf(line)).toBe('bad-signature');
  });

  it('marks a record with no signature as unsigned', () => {
    expect(verificationOf(exportLine({ from: 'some-nick', text: cancelText(signer.did) }))).toBe(
      'unsigned',
    );
  });

  it('marks a signed record it cannot check as unverifiable', () => {
    const signed = signer.signMessage(ROOM, NONCE, cancelText(signer.did));
    const line = exportLine({ from: signer.did, text: signed.text, nonce: NONCE, sig: signed.sig });
    expect(verificationOf(line, {})).toBe('unverifiable');

    // The same record after a plain JSON.parse, which rounded its nonce.
    const lossy = JSON.parse(line) as RoomRecord;
    expect(scanRecords([lossy], { room: ROOM }).rejections[0]?.verification).toBe('unverifiable');

    const noNonce = exportLine({ from: signer.did, text: signed.text, sig: signed.sig });
    expect(verificationOf(noNonce)).toBe('unverifiable');
  });
});

describe('the committed fixture', () => {
  it('verifies every decoded frame against the room it was read from', () => {
    const scan = scanRecords(fixture, { room: ROOM });
    expect(scan.frames.length).toBeGreaterThan(1000);
    const counts = new Map<string, number>();
    for (const f of scan.frames) counts.set(f.verification, (counts.get(f.verification) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ verified: scan.frames.length });
  });

  it('checks nothing when the room is not given, and so leaves every signed frame out', () => {
    const scan = scanRecords(fixture);
    expect(scan.frames).toEqual([]);
    const left = scan.rejections.filter((r) => r.refusedBy === 'signature-check');
    expect(left.length).toBeGreaterThan(1000);
    expect(left.every((r) => r.verification === 'unverifiable')).toBe(true);
  });
});
