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
 * The ring holds roughly 10 MiB. How many hours that covers depends on traffic.
 * The two measured windows were 1.6 hours on 2026-09-05 and 1.2 hours on
 * 2026-09-06, so a once-daily run samples about 5% to 7% of a day. The output
 * states its own window in seq and hours, so the accumulated history reads as a
 * series of samples rather than a continuous record.
 *
 * DEAL ROOMS
 *
 * Once the state machine accepts a contract, its later frames belong in the
 * contract's deal room (src/deal-rooms.ts). After the board, the run reads the
 * deal room of every accepted contract in the window through `/export`, one
 * read each, oldest contract first. It stops at the first refused read, a 429
 * included, retries nothing, and the file says how far it got.
 *
 * SIGNATURES
 *
 * Only a frame whose signature verifies, and whose `from` is the key that
 * signed it, is applied (src/frames.ts). Every other decoded frame is left out
 * and counted by kind under Signature policy. Those frames decoded, so they do
 * not count toward the decode rejection ceiling below.
 */

import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Transport } from 'technocore-client';
import { scanRecords, parseExportLine } from '../dist/src/frames.js';
import { buildThreads } from '../dist/src/threads.js';
import { audit } from '../dist/src/audit.js';
import { bindContracts, framesByRoom, readDealRooms, routeFrames } from '../dist/src/deal-rooms.js';

const ROOM = process.env['TCLK_ROOM'] ?? 'tclk-offers';
const OUT_DIR = process.env['TCLK_OUT_DIR'] ?? 'findings';

/**
 * The rejection rate above which this run refuses to write a file.
 *
 * MEASURED twice against the live ring on 2026-09-05: 82 rejections in 12,231
 * tclk lines (0.67%), and 113 in 16,331 (0.69%). That floor is a handful of agents
 * emitting frames with an extra field. It held across those two samples and has
 * not held since. Every run from 2026-09-08 to 2026-09-11 was between 51.0% and
 * 67.3%.
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
 * What was fixed in the tool that writes this file, and what each fix left
 * behind. Stated at the top of every findings file, because the limits decide
 * how the counts below can be read. The README carries the same list.
 */
const KNOWN_DEFECTS_BANNER = [
  '> [!NOTE]',
  '> **Four defects were found and fixed on 2026-09-11, UTC.** None is open. Each is listed with what',
  '> it left behind, since that decides how the counts below read. A findings file whose banner does',
  '> not carry this list was written by a tool with one of them still open.',
  '>',
  '> - **Fixed on 2026-09-11: later refusals are no longer all chained to the first.** Chains are kept',
  `>   per contract. In \`${ROOM}\`, a refusal the machine gives for any reason other than status is`,
  '>   listed under Anomalies. State machine refusals inside deal rooms are not listed in this file.',
  '>   Two limits remain. A frame refused for its status can have another fault the machine never',
  '>   reports. A frame that arrives after the status has moved past it, a late copy for example, can',
  '>   be chained to an unrelated earlier refusal. Either can be counted below as a downstream',
  '>   consequence.',
  '> - **Fixed on 2026-09-11: only a frame whose signature verifies moves a contract.** The tclk spec',
  '>   says only a verified frame is a commitment (SPEC.md, section 2). A frame whose record is',
  '>   unsigned, whose signature does not verify, whose `from` names another key, or whose signature',
  `>   this tool could not check is left out, in \`${ROOM}\` and in deal rooms alike. Signature policy`,
  '>   below counts each kind. One limit remains. An unsigned frame is left out even when its sender',
  '>   is honest, since the spec calls it data, not a commitment. A file whose banner does not list',
  '>   this fix counted frames this one leaves out, so the two do not compare.',
  "> - **Fixed on 2026-09-11: a stranger's words no longer reach this file through a decoder refusal.**",
  ">   Each refusal below is rebuilt from the decoder's fixed text. Every part a stranger chose, such",
  '>   as a field name, a value or a frame type, appears only as its byte length and SHA-256.',
  '> - **Fixed on 2026-09-11: one frame can no longer stop the run.** A lock whose type is `["lock"]`',
  '>   decodes as a lock, and the state machine returns nothing for it. The run used to throw on that',
  '>   and write no file. Each decoded frame is now checked against the types tclk declares, and one',
  '>   that fails is counted under Shape check rejections.',
];

/**
 * The version of the decoder that judged the lines, read from its own
 * package.json. A rejection rate means little without it. 0.1.0 already
 * refuses frames that later versions accept.
 */
function installedDecoderVersion() {
  let dir = dirname(createRequire(import.meta.url).resolve('@flop-labs/tclk'));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@flop-labs/tclk') return pkg.version;
    } catch {
      // No package.json at this level. Keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

/**
 * How a run ended, for the workflow to read. Three outcomes, two exit codes.
 *
 *   - `written`: a findings file exists. Exit 0, and the commit step takes it.
 *   - `ceiling-stop`: the run measured its input and refused to write. Exit 0,
 *     because refusing is the decision the ceiling exists to make. A red run
 *     for a working guard trains a reader to ignore red, and the next real
 *     fault arrives in that noise.
 *   - `error`: something the run does not handle. Exit 1, and the job is red.
 *
 * An exception nobody caught writes no outcome at all. The job is red then
 * too, and the commit step, which runs only on `written`, stays out.
 */
/**
 * Neither of these throws. They write the runner's own files, and a failure
 * there says nothing about the audit. One that threw inside `fail` would
 * re-enter the handler that called it, and the run would die reporting the
 * write instead of what went wrong.
 */
function setOutcome(outcome) {
  appendLine(process.env['GITHUB_OUTPUT'], `outcome=${outcome}`);
}

/** A line in the job summary, when the runner gives one. */
function summary(text) {
  appendLine(process.env['GITHUB_STEP_SUMMARY'], text);
}

function appendLine(file, text) {
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, `${text}\n`, 'utf8');
  } catch {
    // Nothing to do here, and nothing worth failing the run over.
  }
}

/**
 * The run refused to write a file, on purpose. It says so and ends green.
 * The ::notice:: prefix puts the line in the run's annotations, where a
 * reader sees it without opening the log.
 */
function stop(message) {
  console.log(`::notice::scheduled-audit: ${message}`);
  summary(`**No findings file.** ${message}`);
  setOutcome('ceiling-stop');
  process.exit(0);
}

function fail(message, error) {
  // The ::error:: prefix surfaces this in the Actions log and the job summary.
  // Without it the message sits in step output nobody opens.
  //
  // Only the error's class is added, never its message. technocore-client
  // builds a transport error's message from the first line of the server's
  // response body, and that is remote text. Printed as it came, a body opening
  // with `::` would be a workflow command in this log. src/deal-rooms.ts keeps
  // the class name for the same reason.
  const kind = error === undefined ? '' : ` (${error?.constructor?.name ?? typeof error})`;
  console.error(`::error::scheduled-audit: ${message}${kind}`);
  summary(`**Failed.** ${message}${kind}`);
  setOutcome('error');
  process.exit(1);
}

/**
 * Anything thrown that nothing else catches. Without this the run still ends
 * red, since node exits non-zero, and the commit step still stays out, since it
 * asks for `written`. This names the outcome instead of leaving it unset.
 *
 * The class and where it was thrown are printed. The message is not. A message
 * can carry text from a room, as the 0.1.0 decoder's refusals do, and this line
 * goes to a public log.
 */
function unexpected(error) {
  fail(`unhandled ${error?.constructor?.name ?? typeof error}${throwSite(error)}`);
}

/**
 * Where an error was thrown, as one frame of its stack, or nothing.
 *
 * A stack starts with `Name: message`, and a message can run to several lines.
 * So the message is cut off the front before a frame is looked for. Searching
 * the whole stack would let a message carrying a line that starts with `at`
 * put itself in this log. The frame is then kept to printable ASCII, with no
 * leading `::`, since the runner reads such a line as a command.
 */
function throwSite(error) {
  const stack = String(error?.stack ?? '');
  const head = `${error?.name ?? ''}: ${error?.message ?? ''}`;
  const frames = stack.startsWith(head) ? stack.slice(head.length) : stack;
  const frame = frames.split('\n').find((line) => /^\s+at \S/.test(line));
  if (frame === undefined) return '';
  const printable = frame.trim().replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
  return printable.startsWith('::') ? '' : ` ${printable}`;
}

process.on('uncaughtException', unexpected);
process.on('unhandledRejection', unexpected);

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
  // STATED: the export body is cut back to the last complete line, so a torn
  // tail is expected rather than a fault. parseExportLine returns null for it,
  // and keeps a 19-digit nonce exact.
  const record = parseExportLine(line);
  if (record !== null) records.push(record);
}

if (body.trim().length === 0) fail(`export of /r/${ROOM} was empty`);
if (records.length === 0) fail(`export of /r/${ROOM} contained no parseable records`);

const scan = scanRecords(records, { room: ROOM });

// A rejection is the decoder's, the shape check's after the decoder had
// accepted the line, or the signature check's after that (src/frames.ts). All
// are lines this run does not apply. They are reported apart, since only the
// first are the decoder's.
const byDecoder = (rejections) => rejections.filter((r) => r.refusedBy === 'decoder');
const byShapeCheck = (rejections) => rejections.filter((r) => r.refusedBy === 'shape-check');
const bySignatureCheck = (rejections) => rejections.filter((r) => r.refusedBy === 'signature-check');
const decoderRejected = byDecoder(scan.rejections).length;
const shapeRefused = byShapeCheck(scan.rejections).length;
const signatureRefused = bySignatureCheck(scan.rejections).length;

// Three ways a run can produce nothing useful. Each stops before anything is
// written. A missing file for a day is a visible gap. A file full of zeroes is
// a lie that accumulates.
//
// The two that measured the export and refused it, here and at the ceiling
// below, end green. The reading was the job, and it was done. An export that
// could not be read at all, was empty, or held no parseable record is not a
// reading. Something upstream is wrong, and that stays red.

if (scan.frames.length === 0) {
  stop(
    `no usable frames in ${records.length} records: ` +
      `${decoderRejected} rejected by the decoder, ` +
      `${shapeRefused} refused by the shape check, ${signatureRefused} left out by the signature check, ` +
      `${scan.knownGaps.length} known decoder gaps, ${scan.nonFrameCount} not tclk lines`,
  );
}

// A known decoder gap is still a line the installed decoder could not read,
// so it counts toward the ceiling the same as any other refusal. So does a
// line the shape check refused. If the decoder and the shape check ever
// disagree about most of the traffic, this run stops instead of hiding it. A
// frame the signature check left out decoded and passed the shape check, so it
// counts as a line here and not as a refusal.
const refused = [...byDecoder(scan.rejections), ...byShapeCheck(scan.rejections), ...scan.knownGaps];
const tclkLines = scan.frames.length + signatureRefused + refused.length;
const rejectionRate = tclkLines === 0 ? 1 : refused.length / tclkLines;

if (rejectionRate > REJECTION_RATE_CEILING) {
  // A rate this far above the floor means most tclk lines did not decode with
  // the installed decoder. That has had more than one cause. The decoder can be
  // older than the traffic, or the traffic can fail every version of the
  // schema. The message states what was measured and leaves the cause to the
  // reader.
  const reasons = new Map();
  for (const rejection of refused) {
    reasons.set(rejection.reason, (reasons.get(rejection.reason) ?? 0) + 1);
  }
  const top = [...reasons]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${count}x ${reason}`)
    .join('; ');
  stop(
    `decode rejection rate ${(rejectionRate * 100).toFixed(1)}% exceeds the ` +
      `${(REJECTION_RATE_CEILING * 100).toFixed(0)}% ceiling. ` +
      `${refused.length} of ${tclkLines} tclk lines in the export failed the installed ` +
      `decoder, @flop-labs/tclk ${installedDecoderVersion()}` +
      (shapeRefused === 0
        ? ''
        : `, or passed it and failed this reader's shape check (${shapeRefused} of them)`) +
      `, so no findings file was written. Top reasons: ${top}`,
  );
}

const nowMs = Date.now();
const { bindings, mismatches } = bindContracts(scan.frames);
const dealRooms = [...new Set(bindings.map((b) => b.room))];
const reads = await readDealRooms(transport, dealRooms);
const routed = routeFrames({ room: ROOM, frames: scan.frames }, bindings, framesByRoom(reads));
const dealScans = [...reads.scans.values()];

const index = buildThreads(routed.board);
const report = audit(index, scan.rejections, { nowMs });
const dealReport = audit(
  routed.deals,
  dealScans.flatMap((s) => s.rejections),
  { nowMs },
);

// Every tclk line in the export, as the window was counted before frames were
// split by room. A frame in the wrong room, or one the signature check left
// out, is still part of the ring.
const windowSeqs = [...scan.frames, ...scan.rejections, ...scan.knownGaps].map((item) => item.seq);
const windowFirst = windowSeqs.reduce((a, b) => (b < a ? b : a), windowSeqs[0]);
const windowLast = windowSeqs.reduce((a, b) => (b > a ? b : a), windowSeqs[0]);

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
const rejections = tally(byDecoder(scan.rejections), (r) => r.reason);

// What checking each decoded frame's signature and sender found. Only the
// verified ones were applied above. The rest are rejections from the signature
// check, each carrying what it found.
function signatureCounts(scans) {
  const counts = { verified: 0, 'from-mismatch': 0, 'bad-signature': 0, unsigned: 0, unverifiable: 0 };
  for (const s of scans) {
    counts.verified += s.frames.length;
    for (const r of bySignatureCheck(s.rejections)) counts[r.verification ?? 'unverifiable'] += 1;
  }
  return counts;
}
const boardSignatures = signatureCounts([scan]);
const dealSignatures = signatureCounts(dealScans);
const signatureRow = (label, kind, note) =>
  `| ${label} | ${boardSignatures[kind]} | ${dealSignatures[kind]} | ${note} |`;
const badSignatures = boardSignatures['bad-signature'] + dealSignatures['bad-signature'];

const wrongRoomOnBoard = routed.wrongRoom.filter((w) => w.room === ROOM).length;
const dealRejections = tally(
  dealScans.flatMap((s) => byDecoder(s.rejections)),
  (r) => r.reason,
);
const dealRejectionCount = dealScans.reduce((n, s) => n + byDecoder(s.rejections).length, 0);
const dealShapeRefused = dealScans.reduce((n, s) => n + byShapeCheck(s.rejections).length, 0);
const shapeRejections = tally(
  [
    ...byShapeCheck(scan.rejections).map((r) => ({ reason: r.reason, where: `\`${ROOM}\`` })),
    ...dealScans.flatMap((s) => byShapeCheck(s.rejections).map((r) => ({ reason: r.reason, where: 'deal rooms' }))),
  ],
  (r) => `| \`${r.reason}\` | ${r.where} |`,
);
const knownGaps = tally(
  [
    ...scan.knownGaps.map((g) => ({ gap: g.gap, where: `\`${ROOM}\`` })),
    ...dealScans.flatMap((s) => s.knownGaps.map((g) => ({ gap: g.gap, where: 'deal rooms' }))),
  ],
  (g) => `| \`${g.gap}\` | ${g.where} |`,
);

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
  `| Seq range | ${windowFirst ?? '?'}..${windowLast ?? '?'} |`,
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
  `| Decoded | ${scan.frames.length + signatureRefused} |`,
  `| Rejected by the decoder | ${decoderRejected} |`,
  `| Refused by the shape check after decoding | ${shapeRefused} |`,
  `| Known decoder gaps | ${scan.knownGaps.length} |`,
  `| Lines that were not frames | ${scan.nonFrameCount} |`,
  '',
  '## Signature policy',
  '',
  "Each decoded frame is checked against SPEC.md section 2. It is a commitment only when its record's",
  "signature verifies and the frame's `from` is the key that signed it. Anything else is what the spec",
  'calls "data, not a commitment". This run applies only the commitments. Every other decoded frame',
  `is left out of the audit, in \`${ROOM}\` and in deal rooms alike, and counted here.`,
  '',
  `| | \`${ROOM}\` | deal rooms | |`,
  '|---|---|---|---|',
  signatureRow('Signature verifies, `from` is the signer', 'verified', 'applied'),
  signatureRow(
    'Signature verifies, `from` names another key',
    'from-mismatch',
    'left out. It breaks a MUST in SPEC.md section 2',
  ),
  signatureRow('Signature does not verify', 'bad-signature', 'left out'),
  signatureRow('Unsigned', 'unsigned', 'left out. Not re-verifiable, which is not the same as invalid'),
  signatureRow('Could not be checked', 'unverifiable', "left out. A limit of this tool, not the sender's"),
  '',
  'Signatures that do not verify are counted on their own. A sudden rise there more likely means a',
  'fault in this tool than many senders at once. A nonce that loses digits on the way in fails a good',
  'signature, for example.',
  '',
  '## Contracts',
  '',
  `These count only the frames that belong in \`${ROOM}\` and whose signature verifies. Deal rooms,`,
  'below, covers the rest.',
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
  '## Deal rooms',
  '',
  'Once the state machine accepts a contract, every later frame belongs in its deal room,',
  '`mb-p-tclk-<first 16 hex of the contract id>`. This run derives each room from a contract id it',
  'recomputes from the offer and the accept. A frame in the wrong room is counted here and applied',
  'nowhere. Every count here is over verified frames, so an accept left out by the signature check',
  'is not among the mismatches either.',
  '',
  '| | |',
  '|---|---|',
  `| Accepts whose contract id does not recompute | ${mismatches.length} |`,
  `| Contracts accepted | ${bindings.length} |`,
  `| Deal rooms read | ${reads.scans.size} of ${dealRooms.length} |`,
  `| Frames decoded in deal rooms | ${dealScans.reduce((n, s) => n + s.frames.length + bySignatureCheck(s.rejections).length, 0)} |`,
  `| Rejected by the decoder in deal rooms | ${dealRejectionCount} |`,
  `| Refused by the shape check in deal rooms | ${dealShapeRefused} |`,
  `| Known decoder gaps in deal rooms | ${dealScans.reduce((n, s) => n + s.knownGaps.length, 0)} |`,
  `| Frames found in \`${ROOM}\` that belong in a deal room | ${wrongRoomOnBoard} |`,
  `| Offers and accepts found in a deal room | ${routed.wrongRoom.length - wrongRoomOnBoard} |`,
  '',
  ...(reads.stopped === null
    ? []
    : [
        `Reading stopped at a refused read (${reads.stopped.error}). The deal rooms after it were not read.`,
        '',
      ]),
  'Status of each contract whose deal room was read, with the frames in that room applied:',
  '',
  '| status | contracts |',
  '|---|---|',
  ...Object.entries(dealReport.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `| ${status} | ${count} |`),
  '',
];

if (anomalies.length > 0) {
  lines.push(
    '## Anomalies',
    '',
    `Anomaly-level findings in \`${ROOM}\`. Each is a root-cause refusal, or an accept whose offer is`,
    'missing past the warm-up boundary. A refusal the machine gives for any reason other than status is',
    'always a root. A status refusal is one when no root is open on its contract in the same status.',
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

if (dealRejections.length > 0) {
  lines.push(
    '## Decoder rejections in deal rooms',
    '',
    '| count | reason |',
    '|---|---|',
    ...dealRejections.map(([reason, count]) => `| ${count} | \`${reason}\` |`),
    '',
  );
}

if (shapeRejections.length > 0) {
  lines.push(
    '## Shape check rejections',
    '',
    `Frames the installed decoder, \`@flop-labs/tclk\` ${installedDecoderVersion()}, accepted and this tool then`,
    "refused. That decoder looks a frame's type up by its string form, so a type such as `[\"lock\"]` passes as",
    "a lock and skips the checks on a lock's own fields. It reads a receipt's `outcome` the same way. So each",
    'decoded frame is checked against the JavaScript types tclk declares. A frame that fails is counted here',
    'and applied nowhere.',
    '',
    '| count | reason | room |',
    '|---|---|---|',
    ...shapeRejections.map(([row, count]) => `| ${count} ${row}`),
    '',
  );
}

if (knownGaps.length > 0) {
  lines.push(
    '## Known decoder gaps',
    '',
    `Frames the installed decoder, \`@flop-labs/tclk\` ${installedDecoderVersion()}, refused first for a frame`,
    'type or field that later tclk builds accept. They are counted apart from the decoder rejections.',
    'The decoder stops at its first refusal, so the rest of each frame was not checked. A frame here',
    'can still be malformed in some other way.',
    '',
    '| count | gap | room |',
    '|---|---|---|',
    ...knownGaps.map(([row, count]) => `| ${count} ${row}`),
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
  `  window ${windowFirst}..${windowLast} | ` +
    `${scan.frames.length} frames | ${report.threadCount} threads | ` +
    `${report.transitionsAccepted} ok / ${report.transitionsRejected} refused / ` +
    `${report.transitionsBlocked} blocked`,
);
console.log(
  `  deal rooms ${reads.scans.size} of ${dealRooms.length} read | ` +
    `${routed.wrongRoom.length} frames in the wrong room` +
    (reads.stopped === null ? '' : ` | stopped at ${reads.stopped.error}`),
);
console.log(
  `  signatures left out: ${boardSignatures['from-mismatch'] + dealSignatures['from-mismatch']} from-mismatch, ` +
    `${badSignatures} bad-signature, ${boardSignatures.unsigned + dealSignatures.unsigned} unsigned, ` +
    `${boardSignatures.unverifiable + dealSignatures.unverifiable} unverifiable`,
);
console.log(`  read budget after run: ${JSON.stringify(transport.budget.read)}`);
summary(
  `**Wrote \`${stamp}.md\`.** Window ${windowFirst}..${windowLast}, ${scan.frames.length} frames, ` +
    `${report.threadCount} threads.`,
);
if (badSignatures > 0) {
  // The ::warning:: prefix puts this in the job summary. Signatures that do not
  // verify are the one count here that can point at this tool. The line is
  // fixed text and a number, nothing from a room.
  console.log(
    `::warning::scheduled-audit: ${badSignatures} frame(s) carry a signature that does not verify, ` +
      'and were left out. A sudden rise more likely means a fault in this tool than many senders at once.',
  );
}

// Last, once the file is on disk and everything is printed. Anything that
// throws before this line leaves the outcome unset, and the run ends red with
// the commit step out, which is what a half-finished run should do.
setOutcome('written');
