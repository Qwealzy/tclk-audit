import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OFFER_ROOM, encodeFrame, generateHashLock, makeAccept, makeOffer, type TclkFrame } from '@flop-labs/tclk';
import { Identity } from 'technocore-client';
import { parseExportLine, scanRecords, type RoomRecord } from '../src/frames.js';
import { bindContracts } from '../src/deal-rooms.js';
import { slot } from './support/slot.js';

/**
 * The scheduled run, end to end and offline.
 *
 * scripts/scheduled-audit.mjs fetches /export, audits it and writes a findings
 * file. Here it runs in a child process with test/support/fake-fetch.mjs
 * preloaded. The preload serves the export from a local file, refuses every
 * other request and fixes the clock, so the same input always gives the same
 * bytes.
 *
 * The script imports ../dist/src, so it is copied next to a fresh build of src
 * under node_modules/.cache. It runs against the current source, whatever
 * dist/ holds.
 *
 * The input is the committed fixture plus five crafted rejections. The first
 * two carry the field names that broke the findings table and wrote runner
 * commands before rejection reasons were encoded. The other three put the
 * attack in a field value, in the frame type, and in a field name of over
 * 3,000 characters. test/fixtures/crafted-shapes.jsonl adds three board
 * records. An offer, an accept that comes after the offer expired, and a
 * stranger's lock whose type is `["lock"]`, naming that accept's contract. The
 * expected file was recorded from the same run. When the script or its banner
 * changes on purpose, record it again and check the diff.
 *
 * Every deal room exports as empty except one. test/fixtures/
 * deal-room-synthetic.jsonl is ten records in the deal room of the first
 * contract the fixture binds. They were signed once by throwaway keys that were
 * never written down. Three are frames 0.1.0 refuses for a known decoder gap.
 * Then come an accept in the wrong room, a lock from a key that is not the
 * payer's, and a lock with an unknown field that the decoder rejects. The last
 * four are frames 0.1.0 decodes in a shape tclk does not declare. Their types
 * are `["lock"]`, `[["reveal"]]` and `["cancel"]`, and the fourth is a receipt
 * whose outcome is `["claimed"]`.
 *
 * Before the shape check, the stranger's lock on the board stopped this run
 * with a TypeError, and so did each of the first three in the deal room on its
 * own. The run wrote nothing, and printed no `::error::` line.
 */

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const NOW = '2026-09-11T00:00:00.000Z';
const STAMP = '20260911T000000Z';
const BUILD = at('node_modules', '.cache', 'scheduled-audit-test');

let scratch = '';

/** Non-empty lines of a file, without the CR a Windows checkout may add. */
function lines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(LF)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outDir: string;
  /** What the run wrote to GITHUB_OUTPUT, as the workflow would read it. */
  readonly outcome: string | null;
  /** What it wrote to GITHUB_STEP_SUMMARY. */
  readonly summary: string;
}

function runScheduledAudit(
  name: string,
  exportLines: readonly string[],
  rooms: Readonly<Record<string, string>> = {},
  build: string = BUILD,
): Run {
  const exportPath = join(scratch, name + '.jsonl');
  const roomsPath = join(scratch, name + '-rooms.json');
  const outDir = join(scratch, name + '-out');
  // The two files a GitHub runner gives a step. The run appends to them.
  const outputPath = join(scratch, name + '-output.txt');
  const summaryPath = join(scratch, name + '-summary.md');
  writeFileSync(exportPath, exportLines.join(LF) + LF);
  writeFileSync(roomsPath, JSON.stringify(rooms));
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['TCLK_MAX_REJECTION_RATE'];
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(at('test', 'support', 'fake-fetch.mjs')).href,
      join(build, 'scripts', 'scheduled-audit.mjs'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...env,
        FAKE_EXPORT: exportPath,
        FAKE_ROOMS: roomsPath,
        FAKE_NOW: NOW,
        TCLK_ROOM: 'tclk-offers',
        TCLK_OUT_DIR: outDir,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    },
  );
  const written = readFileSync(outputPath, 'utf8');
  const match = /^outcome=(.*)$/m.exec(written);
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    outDir,
    outcome: match?.[1]?.trim() ?? null,
    summary: readFileSync(summaryPath, 'utf8'),
  };
}

beforeAll(() => {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(join(BUILD, 'scripts'), { recursive: true });
  execFileSync(
    process.execPath,
    [
      at('node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      at('tsconfig.json'),
      '--outDir',
      join(BUILD, 'dist'),
    ],
    { stdio: 'pipe' },
  );
  copyFileSync(at('scripts', 'scheduled-audit.mjs'), join(BUILD, 'scripts', 'scheduled-audit.mjs'));
  scratch = mkdtempSync(join(tmpdir(), 'tclk-audit-scheduled-'));
}, 120_000);

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('the scheduled run, offline', () => {
  const fixture = lines(at('test', 'fixtures', 'tclk-slice.jsonl'));
  const crafted = lines(at('test', 'fixtures', 'crafted-rejections.jsonl'));
  const shapes = lines(at('test', 'fixtures', 'crafted-shapes.jsonl'));
  const synthetic = at('test', 'fixtures', 'deal-room-synthetic.jsonl');

  /** The deal room of the first contract the fixture binds, and that contract. */
  function firstBinding(): { room: string; contract: string } {
    const records = fixture.map((l) => parseExportLine(l)).filter((r): r is RoomRecord => r !== null);
    const [binding] = bindContracts(scanRecords(records, { room: OFFER_ROOM }).frames).bindings;
    if (binding === undefined) throw new Error('the fixture binds no contract');
    return { room: binding.room, contract: binding.contract };
  }

  it('writes the same findings file as the recorded run', () => {
    const { room, contract } = firstBinding();
    // The synthetic records name the contract they were made for. If the
    // binding moves, this fails here instead of serving an unread file.
    expect(lines(synthetic).some((l) => l.includes(contract.slice(2)))).toBe(true);
    const run = runScheduledAudit('passes', [...fixture, ...crafted, ...shapes], { [room]: synthetic });
    expect(run.status, run.stderr).toBe(0);
    // The outcome the commit step asks for. Only this one lets it run.
    expect(run.outcome).toBe('written');
    expect(run.summary).toContain(`**Wrote \`${STAMP}.md\`.**`);
    expect(readdirSync(run.outDir)).toEqual([STAMP + '.md']);

    const written = readFileSync(join(run.outDir, STAMP + '.md'), 'utf8');
    const expected = readFileSync(at('test', 'fixtures', 'scheduled-audit-findings.md'), 'utf8')
      .split(CR + LF)
      .join(LF);
    expect(written).toBe(expected);
  }, 60_000);

  it('keeps going past decoded frames of the wrong shape, and writes its file', () => {
    const { room } = firstBinding();
    const run = runScheduledAudit('shapes', [...fixture, ...shapes], { [room]: synthetic });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(readdirSync(run.outDir)).toEqual([STAMP + '.md']);

    const written = readFileSync(join(run.outDir, STAMP + '.md'), 'utf8');
    expect(written).toContain('| Refused by the shape check after decoding | 1 |');
    expect(written).toContain('| Refused by the shape check in deal rooms | 4 |');
    // Each type and outcome appears only as the length and hash of its JSON.
    const typeRow = (json: string, where: string) =>
      `| 1 | \`tclk-audit: type must be a string: ${slot(json)}\` | ${where} |`;
    for (const row of [
      typeRow('["lock"]', '`tclk-offers`'),
      typeRow('["lock"]', 'deal rooms'),
      typeRow('[["reveal"]]', 'deal rooms'),
      typeRow('["cancel"]', 'deal rooms'),
      `| 1 | \`tclk-audit: receipt.outcome must be a string: ${slot('["claimed"]')}\` | deal rooms |`,
    ]) {
      expect(written).toContain(row);
    }
  }, 60_000);

  it('applies only verified frames, counts the rest by kind, and flags bad signatures', () => {
    // Throwaway keys, in memory while the test runs. The board gets an offer,
    // an unsigned accept for it, and one frame of each other kind. The deal room
    // of the first contract the fixture binds gets a lock of three kinds.
    const { room, contract } = firstBinding();
    const [payer, payee, stranger] = [Identity.create(), Identity.create(), Identity.create()];
    const offer = makeOffer({
      from: payer.did,
      role: 'payer',
      amount: '5',
      asset: 'FLOP',
      lock: 'hash',
      rails: ['flop-htlc'],
      claimByMs: Date.parse('2026-09-05T17:30:00Z'),
      refundAfterMs: Date.parse('2026-09-05T18:00:00Z'),
      expiresMs: Date.parse('2026-09-05T17:10:00Z'),
    });
    const accept = makeAccept(offer, { from: payee.did, statement: generateHashLock().hash });
    const frame = (f: Record<string, unknown>): string => encodeFrame(f as unknown as TclkFrame);
    const cancelAs = (from: string): string => frame({ type: 'cancel', from, contract: accept.contract });
    const lockAs = (from: string): string =>
      frame({ type: 'lock', from, contract, rail: 'flop-htlc', ref: 'esc-1' });

    let nonce = 1788627060599500000n;
    /** One stored line. `signer` signs, `from` is what the room reports. */
    function line(
      forRoom: string,
      seq: number,
      text: string,
      signer: Identity | null,
      from: string,
      withNonce = true,
    ): string {
      const n = String(nonce++);
      const parts = [`"seq":${seq}`, '"ts":"2026-09-05T16:59:00.000000Z"', `"from":${JSON.stringify(from)}`];
      if (signer === null) return `{${[...parts, `"text":${JSON.stringify(text)}`].join(',')}}`;
      const signed = signer.signMessage(forRoom, n, text);
      parts.push(`"text":${JSON.stringify(signed.text)}`);
      if (withNonce) parts.push(`"nonce":${n}`);
      parts.push(`"sig":${JSON.stringify(signed.sig)}`);
      return `{${parts.join(',')}}`;
    }

    const board = [
      line(OFFER_ROOM, 900201, encodeFrame(offer), payer, payer.did),
      line(OFFER_ROOM, 900202, encodeFrame(accept), null, payee.did),
      line(OFFER_ROOM, 900203, cancelAs(payer.did), stranger, stranger.did),
      line(OFFER_ROOM, 900204, cancelAs(payer.did), stranger, payer.did),
      line(OFFER_ROOM, 900205, cancelAs(payer.did), payer, payer.did, false),
    ];
    const dealPath = join(scratch, 'signatures-deal.jsonl');
    writeFileSync(
      dealPath,
      [
        line(room, 1, lockAs(payer.did), null, payer.did),
        line(room, 2, lockAs(payer.did), stranger, stranger.did),
        line(room, 3, lockAs(payer.did), stranger, payer.did),
      ].join(LF) + LF,
    );

    const run = runScheduledAudit('signatures', [...fixture, ...board], { [room]: dealPath });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(readdirSync(run.outDir)).toEqual([STAMP + '.md']);

    const written = readFileSync(join(run.outDir, STAMP + '.md'), 'utf8');
    for (const row of [
      '| Decoded | 1183 |',
      '| Signature verifies, `from` is the signer | 1179 | 0 | applied |',
      '| Signature verifies, `from` names another key | 1 | 1 | left out. It breaks a MUST in SPEC.md section 2 |',
      '| Signature does not verify | 1 | 1 | left out |',
      '| Unsigned | 1 | 1 | left out. Not re-verifiable, which is not the same as invalid |',
      "| Could not be checked | 1 | 0 | left out. A limit of this tool, not the sender's |",
      // The unsigned accept binds nothing, so the count is the fixture's own.
      '| Contracts accepted | 258 |',
      '| Frames decoded in deal rooms | 3 |',
    ]) {
      expect(written).toContain(row);
    }
    // Nothing in the deal room moved its contract.
    expect(written).toMatch(/with the frames in that room applied:\n\n\| status \| contracts \|\n\|---\|---\|\n\| accepted \| 258 \|\n/);

    const warnings = run.stdout.split(LF).filter((l) => l.startsWith('::warning::'));
    expect(warnings).toEqual([
      '::warning::scheduled-audit: 2 frame(s) carry a signature that does not verify, and were left out. ' +
        'A sudden rise more likely means a fault in this tool than many senders at once.',
    ]);
  }, 60_000);

  /**
   * The reason each crafted record should get, from the part of it a stranger
   * chose. The first two carry a crafted field name, the third a crafted
   * contract value, the fourth a crafted frame type, the fifth a field name of
   * over 3,000 characters.
   */
  function craftedReasons(): string[] {
    const offerKeys = new Set(['amount', 'asset', 'claimByMs', 'expiresMs', 'from', 'id', 'job', 'lock', 'nonce', 'rails', 'refundAfterMs', 'role', 'type']);
    return crafted.map((line, i) => {
      const frame = JSON.parse((JSON.parse(line) as { text: string }).text.slice(6)) as Record<string, unknown>;
      const keys = Object.keys(frame);
      if (i < 2) return `tclk: unknown field on offer: ${slot(keys.find((k) => !offerKeys.has(k)) ?? '')}`;
      if (i === 2) return `tclk: contract is malformed: ${slot(String(frame['contract']))}`;
      if (i === 3) return `tclk: unknown frame type: ${slot(String(frame['type']))}`;
      return `tclk: unknown field on cancel: ${slot(keys.find((k) => k.length > 3000) ?? '')}`;
    });
  }

  /** Sixty copies of each crafted rejection take the rate past the 5% ceiling. */
  function overTheCeiling(): string[] {
    return crafted.flatMap((line, i) =>
      Array.from({ length: 60 }, (_, n) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        record['seq'] = 800_000 + i * 100 + n;
        return JSON.stringify(record);
      }),
    );
  }

  it('stops at the rejection ceiling green, writes nothing, and prints one inert notice', () => {
    expect(crafted).toHaveLength(5);
    const run = runScheduledAudit('ceiling', [...fixture, ...overTheCeiling()]);
    // Refusing to write is the decision the ceiling exists to make, so the run
    // ends green and says why. A red run here would train a reader to ignore red.
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.outcome).toBe('ceiling-stop');
    expect(run.summary).toContain('**No findings file.** decode rejection rate');
    expect(existsSync(run.outDir)).toBe(false);

    // The runner splits on LF and on CR, and reads each line for commands.
    const printed = run.stdout
      .split(LF)
      .flatMap((line) => line.split(CR))
      .filter((line) => line.startsWith('::'));
    expect(printed).toHaveLength(1);
    const line = printed[0] ?? '';
    expect(line.startsWith('::notice::scheduled-audit: decode rejection rate')).toBe(true);
    // It states what was measured, the decoder included, and guesses no cause.
    const installed = JSON.parse(
      readFileSync(at('node_modules', '@flop-labs', 'tclk', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(line).toContain(
      'tclk lines in the export failed the installed decoder, @flop-labs/tclk ' +
        installed.version +
        ', so no findings file was written.',
    );
    expect(line).not.toContain('moved');
    // Each crafted refusal is there, as fixed text with the stranger's part
    // shown only as its length and hash.
    for (const reason of craftedReasons()) expect(line).toContain(`60x ${reason}`);
    // None of what the strangers wrote is.
    for (const fragment of ['INJECTED', 'FAKE', 'gnore previous', '::warning', '##[', 'safe to accept', 'legitimate']) {
      expect(line).not.toContain(fragment);
    }
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  }, 60_000);

  it('stays red when the export cannot be read, which is not a decision it made', () => {
    // An empty export is not a reading of the room. Something upstream is
    // wrong, and that is the case the red run is for.
    const run = runScheduledAudit('empty-export', []);
    expect(run.status).toBe(1);
    expect(run.outcome).toBe('error');
    expect(run.stdout).not.toContain('::notice::');
    expect(run.stderr).toContain('::error::scheduled-audit: export of /r/tclk-offers was empty');
    expect(existsSync(run.outDir)).toBe(false);
  }, 60_000);

  it('stays red when something throws where nothing catches it', () => {
    // The same input as the green ceiling run above. The only difference is a
    // decode that throws, injected into a copy of the build rather than into
    // src, so this proves the split is a real distinction and not a blanket
    // green.
    const broken = join(BUILD, '..', 'scheduled-audit-test-broken');
    rmSync(broken, { recursive: true, force: true });
    cpSync(BUILD, broken, { recursive: true });
    const framesPath = join(broken, 'dist', 'src', 'frames.js');
    const patched = readFileSync(framesPath, 'utf8').replace(
      'export function scanRecords(',
      'export function scanRecords() {\n    throw new TypeError("injected decode failure");\n}\nexport function unusedScanRecords(',
    );
    writeFileSync(framesPath, patched);

    const run = runScheduledAudit('injected', [...fixture, ...overTheCeiling()], {}, broken);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('::notice::');
    expect(run.outcome).toBe('error');
    expect(run.stderr).toContain('::error::scheduled-audit: unhandled TypeError at ');
    // The class and the place, never the message, which can carry room text.
    expect(run.stderr).not.toContain('injected decode failure');
    expect(existsSync(run.outDir)).toBe(false);
    rmSync(broken, { recursive: true, force: true });
  }, 60_000);

  it('keeps a crafted exception message out of the log, even one shaped like a stack', () => {
    // A stack reads `Name: message` before its frames, and a message can run
    // to several lines. One carrying a line that starts with `at` would put
    // itself in the log if the whole stack were searched for a frame.
    const broken = join(BUILD, '..', 'scheduled-audit-test-stacky');
    rmSync(broken, { recursive: true, force: true });
    cpSync(BUILD, broken, { recursive: true });
    const framesPath = join(broken, 'dist', 'src', 'frames.js');
    const crafted = '\\n    at ::error title=INJECTED::SECRET-ROOM-TEXT (/x.js:1:1)';
    const patched = readFileSync(framesPath, 'utf8').replace(
      'export function scanRecords(',
      `export function scanRecords() {\n    throw new TypeError("tclk: unknown field on offer: ${crafted}");\n}\nexport function unusedScanRecords(`,
    );
    writeFileSync(framesPath, patched);

    const run = runScheduledAudit('stacky', [...fixture], {}, broken);
    expect(run.status).toBe(1);
    expect(run.outcome).toBe('error');
    const printed = run.stderr + run.stdout + run.summary;
    expect(printed).toContain('unhandled TypeError');
    for (const fragment of ['INJECTED', 'SECRET-ROOM-TEXT', 'unknown field on offer']) {
      expect(printed, fragment).not.toContain(fragment);
    }
    // One line, and the runner reads no command out of it.
    const commands = run.stderr.split(LF).filter((l) => l.startsWith('::'));
    expect(commands).toHaveLength(1);
    rmSync(broken, { recursive: true, force: true });
  }, 60_000);

  it('never prints a transport error message, which carries the server response', () => {
    // technocore-client builds a transport error's message from the first line
    // of the response body. A body opening with `::` would be a workflow
    // command in this log, so only the error's class is printed.
    const preload = join(scratch, 'hostile-fetch.mjs');
    writeFileSync(
      preload,
      [
        'globalThis.fetch = async () =>',
        '  new Response("::error title=INJECTED::body text a stranger chose", { status: 503 });',
      ].join(LF) + LF,
    );
    const outDir = join(scratch, 'hostile-out');
    const outputPath = join(scratch, 'hostile-output.txt');
    writeFileSync(outputPath, '');
    const run = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, join(BUILD, 'scripts', 'scheduled-audit.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, TCLK_ROOM: 'tclk-offers', TCLK_OUT_DIR: outDir, GITHUB_OUTPUT: outputPath },
      },
    );
    expect(run.status).toBe(1);
    expect(readFileSync(outputPath, 'utf8')).toContain('outcome=error');
    expect(run.stderr).toContain('::error::scheduled-audit: could not export /r/tclk-offers');
    for (const fragment of ['INJECTED', 'stranger chose']) {
      expect(run.stderr, fragment).not.toContain(fragment);
    }
    expect(run.stderr.split(LF).filter((l) => l.startsWith('::'))).toHaveLength(1);
    expect(existsSync(outDir)).toBe(false);
  }, 60_000);
});
