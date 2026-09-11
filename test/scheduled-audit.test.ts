import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
import { OFFER_ROOM } from '@flop-labs/tclk';
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
  readonly stderr: string;
  readonly outDir: string;
}

function runScheduledAudit(
  name: string,
  exportLines: readonly string[],
  rooms: Readonly<Record<string, string>> = {},
): Run {
  const exportPath = join(scratch, name + '.jsonl');
  const roomsPath = join(scratch, name + '-rooms.json');
  const outDir = join(scratch, name + '-out');
  writeFileSync(exportPath, exportLines.join(LF) + LF);
  writeFileSync(roomsPath, JSON.stringify(rooms));

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['TCLK_MAX_REJECTION_RATE'];
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(at('test', 'support', 'fake-fetch.mjs')).href,
      join(BUILD, 'scripts', 'scheduled-audit.mjs'),
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
      },
    },
  );
  return { status: run.status, stderr: run.stderr, outDir };
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

  it('stops at the rejection ceiling, writes nothing, and prints one inert error line', () => {
    expect(crafted).toHaveLength(5);
    // Sixty copies of each crafted rejection take the rate past the 5% ceiling.
    const many = crafted.flatMap((line, i) =>
      Array.from({ length: 60 }, (_, n) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        record['seq'] = 800_000 + i * 100 + n;
        return JSON.stringify(record);
      }),
    );
    const run = runScheduledAudit('ceiling', [...fixture, ...many]);
    expect(run.status).toBe(1);
    expect(existsSync(run.outDir)).toBe(false);

    // The runner splits on LF and on CR, and reads each line for commands.
    const printed = run.stderr
      .split(LF)
      .flatMap((line) => line.split(CR))
      .filter((line) => line.length > 0);
    expect(printed).toHaveLength(1);
    const line = printed[0] ?? '';
    expect(line.startsWith('::error::scheduled-audit: decode rejection rate')).toBe(true);
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
});
