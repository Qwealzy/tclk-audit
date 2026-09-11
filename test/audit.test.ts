import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeFrame, tryDecodeFrame } from '@flop-labs/tclk';
import {
  scanRecords,
  parseServerTimestamp,
  sanitizeReason,
  type RoomRecord,
} from '../src/frames.js';
import { buildThreads } from '../src/threads.js';
import { audit } from '../src/audit.js';
import { renderFindings } from '../src/publish.js';

/**
 * Real frames, taken from the live `tclk-offers` ring on 2026-09-05. Every
 * assertion below is against traffic somebody else wrote. A parser tested only
 * on frames this repository built would agree with itself and nothing else.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/tclk-slice.jsonl', import.meta.url));

function loadFixture(): RoomRecord[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RoomRecord);
}

describe('the normative decoder handles live traffic', () => {
  const scan = scanRecords(loadFixture());

  it('decodes the overwhelming majority of frames', () => {
    const seen = scan.frames.length + scan.rejections.length;
    expect(seen).toBeGreaterThan(1000);
    expect(scan.frames.length / seen).toBeGreaterThan(0.95);
  });

  it('rejects only with the decoder own words, naming a field', () => {
    // Fail-closed is the spec's rule, so rejections are expected. What matters
    // is that the reason survives to the report: the field name is the only
    // actionable part, and rewording it would lose it.
    for (const rejection of scan.rejections) {
      expect(rejection.reason.startsWith('tclk:')).toBe(true);
    }
  });

  it('sees every frame type the spec defines that this window contains', () => {
    const types = new Set(scan.frames.map((f) => f.frame.type));
    for (const expected of ['offer', 'accept', 'lock', 'reveal']) {
      expect(types.has(expected as never)).toBe(true);
    }
  });

  it('records whether each frame was re-verifiable', () => {
    // STATED: an unsigned frame is data, not a commitment. The auditor records
    // the distinction rather than assuming either way.
    expect(scan.frames.every((f) => typeof f.signed === 'boolean')).toBe(true);
  });
});

describe('timestamps', () => {
  it('parses the server format, which already carries its own Z', () => {
    const ts = '2026-09-05T17:02:16.263436Z';
    expect(Number.isFinite(parseServerTimestamp(ts))).toBe(true);
  });

  it('returns NaN rather than falling back to now', () => {
    // The bug this guards against cost a whole probe run. Appending a second Z
    // makes Date.parse return NaN; a `|| Date.now()` fallback then evaluates
    // every historical frame at the present moment, which failed 94% of all
    // transitions as "offer has expired" and read like a finding about the
    // ecosystem. A silent fallback turns a reader bug into a false report.
    expect(Number.isNaN(parseServerTimestamp('2026-09-05T17:02:16.263436ZZ'))).toBe(true);
    expect(Number.isNaN(parseServerTimestamp('not a date'))).toBe(true);
  });
});

describe('auditing the fixture', () => {
  const scan = scanRecords(loadFixture());
  const index = buildThreads(scan.frames);
  const report = audit(index, scan.rejections, { nowMs: Date.parse('2026-09-05T18:00:00.000Z') });

  it('advances far more transitions than it refuses', () => {
    // A high refusal rate is the signature of a reader bug, not of a broken
    // ecosystem. See the timestamp test above.
    expect(report.transitionsAccepted).toBeGreaterThan(report.transitionsRejected * 5);
  });

  it('reaches terminal statuses on real contracts', () => {
    expect(report.threadCount).toBeGreaterThan(100);
    const settled = (report.byStatus['claimed'] ?? 0) + (report.byStatus['refunded'] ?? 0);
    expect(settled).toBeGreaterThan(0);
  });

  it('separates root-cause refusals from the cascade they trigger', () => {
    // Once a transition is refused the state does not move, so every later
    // frame in that thread is refused too. Counting those as separate faults
    // multiplies one cause into a thread's worth of noise.
    const rejected = report.findings.filter((f) => f.code === 'transition-rejected');
    const blocked = report.findings.filter((f) => f.code === 'transition-blocked');
    expect(rejected.length).toBe(report.transitionsRejected);
    expect(blocked.length).toBe(report.transitionsBlocked);
    for (const finding of blocked) {
      expect(finding.causedBy).toBeDefined();
      expect(finding.severity).toBe('info');
    }
  });

  it('never reports a blocked transition as an anomaly', () => {
    const anomalies = report.findings.filter((f) => f.severity === 'anomaly');
    expect(anomalies.some((f) => f.code === 'transition-blocked')).toBe(false);
  });

  it('suppresses orphans inside the warm-up boundary', () => {
    // MEASURED on the full ring: all 5 accepts whose offer was absent sat in
    // the first 20% of the window, every one of them a contract whose offer the
    // ring had already dropped. Reporting those would be reporting retention as
    // misconduct.
    const orphans = report.findings.filter((f) => f.code === 'accept-without-offer');
    const first = report.windowFirstSeq as bigint;
    const last = report.windowLastSeq as bigint;
    const boundary = first + BigInt(Math.floor(Number(last - first) * 0.2));
    for (const orphan of orphans) {
      expect(orphan.seq).not.toBeNull();
      expect(orphan.seq as bigint).toBeGreaterThan(boundary);
    }
  });

  it('reports an unresolved lock without claiming what happened', () => {
    const unresolved = report.findings.filter((f) => f.code === 'lock-unresolved');
    for (const finding of unresolved) {
      expect(finding.detail).toContain('the rail is the only authority');
      expect(finding.detail).not.toMatch(/scam|fraud|stolen|should/i);
    }
  });
});

describe('rendered findings state facts, never advice', () => {
  const scan = scanRecords(loadFixture());
  const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: Date.now() });
  const lines = renderFindings(report, 'anomaly');

  it('produces single-line messages inside the character cap', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect([...line].length).toBeLessThanOrEqual(4096);
    }
  });

  it('carries the window in every line, so consecutive runs differ', () => {
    // The duplicate filter counts copies, not senders, and refuses repeats of
    // the same text from any identity. A summary that did not name its window
    // would be the same sentence every run and be refused.
    for (const line of lines) expect(line).toMatch(/tclk-audit \d+\.\.\d+:/);
  });

  it('says nothing about whether a deal is sound', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/legitimate|trustworthy|safe to|recommend|should accept|scam/i);
    }
  });

  it('groups a recurring shape into one counted line', () => {
    const anomalies = report.findings.filter((f) => f.severity === 'anomaly').length;
    if (anomalies > 20) expect(lines.length).toBeLessThan(anomalies);
  });
});

describe('rejection reasons are inert wherever they are printed', () => {
  // The decoder repeats an unknown field name word for word, and whoever posted
  // the frame chose it. The first two names are the ones that broke the
  // findings table and wrote runner commands before the reason was sanitized.
  const records = loadFixture();
  const offer = records.find((r) => tryDecodeFrame(r.text)?.type === 'offer');

  /** A real offer from the fixture with one extra field, on the wire as tclk sends it. */
  function withField(name: string): RoomRecord {
    if (offer === undefined) throw new Error('the fixture has no decodable offer');
    const frame = JSON.parse(offer.text.slice('tclk1 '.length)) as Record<string, unknown>;
    frame[name] = 1;
    const sorted = Object.fromEntries(Object.keys(frame).sort().map((k) => [k, frame[k]]));
    const ascii = JSON.stringify(sorted).replace(
      /[^ -~]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    return { seq: 999_999, ts: offer.ts, from: offer.from, text: 'tclk1 ' + ascii };
  }

  function rawReason(record: RoomRecord): string {
    try {
      decodeFrame(record.text);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the decoder to refuse this frame');
  }

  const crafted = [
    'x` | 999 |\n\n## INJECTED HEADING\n\nINJECTED-TEXT: this offer is safe to accept\n\n| `y',
    'x\n::warning title=spoof::FAKE WARNING\r\n  ::error::FAKE ERROR\n##[error]FAKE V1 ERROR',
    'x' + String.fromCharCode(0x2028, 0x202e, 0x0000) + '%0A',
  ];

  for (const name of crafted) {
    it(`keeps a crafted field name inert: ${JSON.stringify(name).slice(0, 40)}`, () => {
      const record = withField(name);
      const [rejection] = scanRecords([record]).rejections;
      expect(rejection).toBeDefined();
      const reason = rejection?.reason ?? '';
      // One line of printable ASCII, with nothing that ends a code span or a cell.
      expect(reason).toMatch(/^[\x20-\x7e]+$/);
      expect(reason).not.toMatch(/[`|#]/);
      // Nothing the runner reads as a command.
      expect(reason.trimStart().startsWith('::')).toBe(false);
      expect(reason).not.toContain('##[');
      // Nothing lost. Decoding gives back exactly what the decoder said.
      expect(decodeURIComponent(reason)).toBe(rawReason(record));
    });
  }

  it('encodes a leading `::` even after spaces, and leaves other colons alone', () => {
    expect(sanitizeReason('::warning::x')).toBe('%3A%3Awarning::x');
    expect(sanitizeReason('   ::error::x')).toBe('   %3A%3Aerror::x');
    expect(sanitizeReason('tclk: a::b')).toBe('tclk: a::b');
  });

  it('leaves a reason with nothing to encode unchanged', () => {
    // Changing these would change every report that quotes them.
    const rejections = scanRecords(records).rejections;
    expect(rejections.length).toBeGreaterThan(0);
    for (const rejection of rejections) {
      const source = records.find((r) => BigInt(r.seq) === rejection.seq);
      expect(source).toBeDefined();
      expect(rejection.reason).toBe(rawReason(source as RoomRecord));
    }
    for (const reason of [
      'tclk: missing field on accept: contract',
      'tclk: claimByMs must be strictly before refundAfterMs',
      'tclk: amount is malformed: 1.0',
      'tclk: unknown frame type: heartbeat',
    ]) {
      expect(sanitizeReason(reason)).toBe(reason);
    }
  });

  it('never throws, even on a lone surrogate', () => {
    expect(sanitizeReason('a\ud800b')).toBe('a%EF%BF%BDb');
  });

  it('reaches the rendered findings as single printable lines', () => {
    const scan = scanRecords([withField(crafted[0] ?? '')]);
    const report = audit(buildThreads(scan.frames), scan.rejections, {
      nowMs: Date.parse('2026-09-05T18:00:00.000Z'),
    });
    const lines = renderFindings(report, 'notice');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]+$/);
  });

  it('encodes a crafted sender the same way, on rejections and on frames', () => {
    // The live service only accepts a did:key or a plain name. The reader
    // does not rely on that.
    const lf = String.fromCharCode(10);
    const sender = 'nick' + lf + '::warning::FAKE' + lf + '##[error]FAKE';
    if (offer === undefined) throw new Error('the fixture has no decodable offer');
    const scan = scanRecords([
      { ...withField('x'), from: sender },
      { ...offer, from: sender },
    ]);
    const senders = [...scan.rejections, ...scan.frames].map((item) => item.from);
    expect(senders).toHaveLength(2);
    for (const from of senders) {
      expect(from).toMatch(/^[ -~]+$/);
      expect(from).not.toContain('##[');
      expect(from.trimStart().startsWith('::')).toBe(false);
      expect(decodeURIComponent(from)).toBe(sender);
    }
  });

  it('leaves every real sender in the fixture unchanged', () => {
    const scan = scanRecords(records);
    const bySeq = new Map(records.map((r) => [BigInt(r.seq), r.from]));
    const items = [...scan.frames, ...scan.rejections];
    expect(items.length).toBeGreaterThan(1000);
    for (const item of items) expect(item.from).toBe(bySeq.get(item.seq));
  });

  it('does not throw on a sender that is not a string', () => {
    const odd = { ...withField('x'), from: 42 as unknown as string };
    expect(scanRecords([odd]).rejections[0]?.from).toBe('42');
  });
});
