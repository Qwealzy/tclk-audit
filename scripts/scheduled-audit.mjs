#!/usr/bin/env node
/**
 * The scheduled run. Fetch, audit, write a findings file. Nothing else.
 *
 * NO SIGNING HAPPENS HERE.
 *
 * This script does not import the signing type, does not read a key file, and
 * does not write to any room. A did:key is single-copy and cannot be revoked.
 * There is no issuer to tell and nothing to invalidate. A key in Actions
 * secrets would sign on someone's behalf inside an environment they cannot
 * fully see, permanently. The findings this produces are unsigned, the file
 * says so, and signed summaries are published by hand from a machine that
 * holds the key.
 *
 * The workflow greps this file for signing imports, so the guarantee is
 * checked rather than promised.
 *
 * WHY /export AND NOT ?since=
 *
 * Each run starts cold with no cursor. `limit` returns the newest n after the
 * cursor rather than the next n, capped at 200. A reader more than 200
 * messages behind cannot catch up through `?since=`. At around 6,000 frames an
 * hour in this room that is two minutes of lag, and a daily job is always
 * further behind. `/export` is one read and returns the whole retained ring.
 * It is the only thing that works from cold.
 *
 * WHAT ONE RUN COVERS
 *
 * The ring holds roughly 10 MiB, which at current traffic is about two hours.
 * A once-daily run samples roughly a tenth of a day. The output states its own
 * window in seq and hours, so the accumulated history reads as a series of
 * samples rather than a continuous record.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { Transport } from 'technocore-client';
import { scanRecords } from '../dist/src/frames.js';
import { buildThreads } from '../dist/src/threads.js';
import { audit } from '../dist/src/audit.js';

const ROOM = process.env['TCLK_ROOM'] ?? 'tclk-offers';
const OUT_DIR = process.env['TCLK_OUT_DIR'] ?? 'findings';

/**
 * The rejection rate above which this run refuses to write a file.
 *
 * MEASURED twice against the live ring on 2026-09-05: 82 rejections in 12,231
 * tclk lines (0.67%), and 113 in 16,331 (0.69%). That floor is a handful of agents
 * emitting frames with an extra field. It is stable.
 *
 * The ceiling is 5%, roughly seven times the observed rate. The failure this
 * guards against is not gradual. If the frame schema moves under us, or the
 * decoder's idea of a valid frame diverges from what the ecosystem emits, the
 * rate jumps to a large fraction of all frames at once. It does not drift from
 * 0.7% to 1.2%. A threshold tuned for small drift would fire on ordinary
 * variance and be muted within a month, which is worse than having none.
 *
 * A cron job that quietly writes empty or meaningless findings for months is
 * worse than one that stops, so this stops.
 */
const REJECTION_RATE_CEILING = Number(process.env['TCLK_MAX_REJECTION_RATE'] ?? '0.05');

/**
 * Known defects, stated at the top of every findings file until they are fixed.
 * The README carries the same list.
 */
const KNOWN_DEFECTS_BANNER = [
  '> [!CAUTION]',
  '> **Known broken and under repair. Do not rely on this file.**',
  '>',
  '> The tool that wrote this file has three known defects.',
  '>',
  '> - **No signature verification happens.** The tool never verifies a signature. It never checks',
  ">   that a frame's `from` matches the key that signed the record, which the tclk spec requires",
  '>   (SPEC.md, section 2). Unsigned records and records whose signature fails are counted the same',
  '>   as valid ones.',
  '> - **It reads the wrong room.** The tclk spec moves every frame from `lock` onward into the',
  ">   contract's deal room, `mb-p-tclk-<first 16 hex of contract id>`. The tool reads only",
  '>   `tclk-offers`. The claimed, locked and refunded counts below come from frames it found there.',
  "> - **A crafted field name can put a stranger's words into findings.** The decoder rejection table",
  ">   quotes the decoder's error messages, and an error message can contain a field name chosen by",
  '>   whoever posted the frame. Each message is percent-encoded before it is written, so a crafted',
  '>   name cannot add a line, end the code span or table cell, or run as a workflow command. Its',
  '>   words still appear, and the advice guard never checks them.',
];

function fail(message, error) {
  // The ::error:: prefix surfaces this in the Actions log and the job summary.
  // Without it the message sits in step output nobody opens.
  console.error(`::error::scheduled-audit: ${message}`);
  if (error !== undefined) console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

const transport = new Transport();

let body;
try {
  const reply = await transport.requestText(
    `${transport.baseUrl}/r/${ROOM}/export`,
    undefined,
    { bucket: 'read' },
  );
  body = reply.body;
} catch (error) {
  // The origin has been seen serving 503 from the edge for minutes at a time.
  // A failed fetch writes nothing. A missing file for a day is honest. An
  // empty or partial one is not.
  fail(`could not export /r/${ROOM}`, error);
}

const records = [];
for (const line of body.split('\n')) {
  if (line.length === 0) continue;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.text === 'string') records.push(parsed);
  } catch {
    // STATED: the export body is cut back to the last complete line, so a torn
    // tail is expected rather than a fault.
  }
}

if (body.trim().length === 0) fail(`export of /r/${ROOM} was empty`);
if (records.length === 0) fail(`export of /r/${ROOM} contained no parseable records`);

const scan = scanRecords(records);

// Three ways a run can produce nothing useful. Each fails before anything is
// written. A missing file for a day is a visible gap. A file full of zeroes is
// a lie that accumulates.

if (scan.frames.length === 0) {
  fail(
    `no frames decoded from ${records.length} records: ` +
      `${scan.rejections.length} rejected, ${scan.nonFrameCount} not tclk lines`,
  );
}

const tclkLines = scan.frames.length + scan.rejections.length;
const rejectionRate = tclkLines === 0 ? 1 : scan.rejections.length / tclkLines;

if (rejectionRate > REJECTION_RATE_CEILING) {
  // At this magnitude the schema has moved. A few agents misbehaving does not
  // reach it. This is worth knowing on the day, not at a quarterly review.
  const reasons = new Map();
  for (const rejection of scan.rejections) {
    reasons.set(rejection.reason, (reasons.get(rejection.reason) ?? 0) + 1);
  }
  const top = [...reasons]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${count}x ${reason}`)
    .join('; ');
  fail(
    `decode rejection rate ${(rejectionRate * 100).toFixed(1)}% exceeds the ` +
      `${(REJECTION_RATE_CEILING * 100).toFixed(0)}% ceiling ` +
      `(${scan.rejections.length}/${tclkLines}); the frame schema may have moved. Top reasons: ${top}`,
  );
}

const index = buildThreads(scan.frames);
const report = audit(index, scan.rejections, { nowMs: Date.now() });

const times = records.map((r) => Date.parse(r.ts)).filter((n) => Number.isFinite(n));
const spanHours =
  times.length < 2 ? null : (Math.max(...times) - Math.min(...times)) / 3_600_000;

function tally(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const anomalies = tally(
  report.findings.filter((f) => f.severity === 'anomaly'),
  (f) => f.detail.replace(/\bseq \d+\b/g, 'seq N'),
);
const rejections = tally(scan.rejections, (r) => r.reason);

const generatedAt = new Date().toISOString();
// Sortable, and colon-free so the name is valid on every filesystem. A second
// run on the same day adds a file instead of overwriting the first. This
// repository exists to accumulate a record, so replacing an earlier sample is
// the wrong default.
const stamp = generatedAt.replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z');

const lines = [
  `# ${ROOM} structural audit, ${generatedAt}`,
  '',
  ...KNOWN_DEFECTS_BANNER,
  '',
  '**Unsigned.** Produced by a scheduled run with no key present. These findings carry no',
  'signature and are not attestations. They are the output of a program anyone can run against',
  'the same public data. Signed summaries, when there are any, are published separately.',
  '',
  '**Structure only.** Every line below describes the shape of the signed transcript. Nothing',
  'here says whether a contract is sound, whether a party is honest, or whether an offer is worth',
  'taking. The settlement rail is the only authority on any of that, and this tool never looks',
  'at one.',
  '',
  '## Window',
  '',
  '| | |',
  '|---|---|',
  `| Generated | ${generatedAt} |`,
  `| Room | \`${ROOM}\` |`,
  `| Seq range | ${report.windowFirstSeq ?? '?'}..${report.windowLastSeq ?? '?'} |`,
  `| Records exported | ${records.length} |`,
  spanHours === null
    ? '| Traffic span | unknown |'
    : `| Traffic span | ${spanHours.toFixed(1)} hours |`,
  '',
  spanHours === null
    ? ''
    : `The room is a ring, so one run sees only what is retained, about ${spanHours.toFixed(
        1,
      )} hours here,` +
      ` roughly ${Math.round((spanHours / 24) * 100)}% of a day. This file is a sample, not a` +
      ' complete record of the period since the last one.',
  '',
  '## Frames',
  '',
  '| | |',
  '|---|---|',
  `| Decoded | ${scan.frames.length} |`,
  `| Rejected by the decoder | ${scan.rejections.length} |`,
  `| Lines that were not frames | ${scan.nonFrameCount} |`,
  '',
  '## Contracts',
  '',
  '| | |',
  '|---|---|',
  `| Threads reconstructed | ${report.threadCount} |`,
  `| Transitions accepted | ${report.transitionsAccepted} |`,
  `| Root-cause refusals | ${report.transitionsRejected} |`,
  `| Downstream consequences | ${report.transitionsBlocked} |`,
  '',
  'Status at the end of the window:',
  '',
  '| status | contracts |',
  '|---|---|',
  ...Object.entries(report.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `| ${status} | ${count} |`),
  '',
];

if (anomalies.length > 0) {
  lines.push(
    '## Anomalies',
    '',
    'A refused transition whose cause is not an earlier refusal in the same thread.',
    '',
    '| count | class |',
    '|---|---|',
    ...anomalies.map(([reason, count]) => `| ${count} | ${reason} |`),
    '',
  );
} else {
  lines.push('## Anomalies', '', 'None in this window.', '');
}

if (rejections.length > 0) {
  lines.push(
    '## Decoder rejections',
    '',
    'Frames the normative decoder refused. Fail-closed is the specified behaviour: an unknown key,',
    'a missing field or a malformed value is rejected rather than coerced.',
    '',
    '| count | reason |',
    '|---|---|',
    ...rejections.map(([reason, count]) => `| ${count} | \`${reason}\` |`),
    '',
  );
}

lines.push(
  '---',
  '',
  'Generated by [tclk-audit](https://github.com/Qwealzy/tclk-audit) using the normative',
  '`@flop-labs/tclk` decoder and state machine. Unofficial and unaffiliated.',
  '',
);

mkdirSync(OUT_DIR, { recursive: true });
const path = `${OUT_DIR}/${stamp}.md`;
writeFileSync(path, lines.join('\n'), 'utf8');

console.log(`wrote ${path}`);
console.log(
  `  window ${report.windowFirstSeq}..${report.windowLastSeq} | ` +
    `${scan.frames.length} frames | ${report.threadCount} threads | ` +
    `${report.transitionsAccepted} ok / ${report.transitionsRejected} refused / ` +
    `${report.transitionsBlocked} blocked`,
);
console.log(`  read budget after run: ${JSON.stringify(transport.budget.read)}`);
