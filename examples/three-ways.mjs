/**
 * The seam demonstration.
 *
 * Runs the identical fixture three times, with the stub, with Ollama, and with
 * no adapter, then compares the findings. If the abstraction is real, the
 * structural output is byte-identical across all three. The only difference is
 * whether a description sentence is attached.
 *
 * A test asserting equality would pass without anyone seeing that the findings
 * really are the same. This is a demonstration so you can see it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  scanRecords,
  parseExportLine,
  buildThreads,
  audit,
  renderFindings,
  describeFindings,
  StubAdapter,
  OllamaAdapter,
  withAccounting,
  MemoryLedger,
  summarise,
} from '../dist/src/index.js';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/tclk-slice.jsonl', import.meta.url));
const NOW = Date.parse('2026-09-05T18:00:00.000Z');

function runAudit() {
  const records = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => parseExportLine(l))
    .filter((r) => r !== null);
  const scan = scanRecords(records, { room: 'tclk-offers' });
  return audit(buildThreads(scan.frames), scan.rejections, { nowMs: NOW });
}

/** The structural output. Descriptions are excluded from it. */
function fingerprint(report) {
  const canonical = JSON.stringify({
    window: [String(report.windowFirstSeq), String(report.windowLastSeq)],
    threads: report.threadCount,
    byStatus: report.byStatus,
    accepted: report.transitionsAccepted,
    rejected: report.transitionsRejected,
    blocked: report.transitionsBlocked,
    findings: report.findings.map((f) => [
      f.code,
      f.severity,
      f.subject,
      f.seq === null ? null : String(f.seq),
      f.detail,
      f.causedBy === undefined ? null : String(f.causedBy),
    ]),
    lines: renderFindings(report, 'anomaly'),
  });
  return { hash: createHash('sha256').update(canonical).digest('hex').slice(0, 16), canonical };
}

async function run(label, adapterFactory) {
  const ledger = new MemoryLedger();
  const base = adapterFactory();
  // Every adapter goes through accounting, including the stub. A stub that
  // bypassed the ledger would exercise a path the real one never takes.
  const adapter = base === null ? undefined : withAccounting(base, ledger);

  const report = runAudit();
  const anomalies = report.findings.filter((f) => f.severity === 'anomaly').slice(0, 5);

  const started = Date.now();
  const described = await describeFindings(anomalies, adapter === undefined ? {} : { adapter });
  const elapsed = Date.now() - started;

  const fp = fingerprint(report);
  const withText = described.filter((d) => d.text !== null).length;
  const skips = new Map();
  for (const d of described) if (d.skipped !== null) skips.set(d.skipped, (skips.get(d.skipped) ?? 0) + 1);

  console.log(`\n=== ${label} ===`);
  console.log(`  structural fingerprint : ${fp.hash}`);
  console.log(`  findings               : ${report.findings.length}`);
  console.log(`  described / attempted  : ${withText} / ${described.length}   (${elapsed}ms)`);
  console.log(`  skip reasons           : ${skips.size === 0 ? 'none' : [...skips].map(([k, v]) => `${k} x${v}`).join(', ')}`);
  const ls = summarise(ledger);
  console.log(`  ledger                 : ${ls.calls} calls, ${ls.failed} failed, ` +
    `${ls.inputTokens} in / ${ls.outputTokens} out tokens`);
  console.log(`  ledger by tag          : ${JSON.stringify(ls.byTag)}`);
  for (const [i, d] of described.entries()) {
    if (d.text !== null) console.log(`    [${i}] ${d.text.slice(0, 96)}`);
  }
  return { label, fp, described };
}

const runs = [];
runs.push(await run('stub adapter', () => new StubAdapter({
  responses: {
    'describe:transition-rejected': 'A frame was refused by the state machine at this point in the transcript.',
    'describe:accept-without-offer': 'Frames reference an offer that is not present in the scanned window.',
    'describe:lock-unresolved': 'The transcript records a lock and no later frame resolving it.',
  },
  defaultText: 'The transcript records this step and nothing further.',
})));
runs.push(await run('ollama adapter', () => new OllamaAdapter({ model: 'llama3.2' })));
runs.push(await run('no adapter at all', () => null));

console.log('\n=== comparison ===');
const [a, b, c] = runs;
const same = a.fp.hash === b.fp.hash && b.fp.hash === c.fp.hash;
console.log('  identical structural fingerprints across all three :', same);
console.log('  byte-identical canonical output                    :',
  a.fp.canonical === b.fp.canonical && b.fp.canonical === c.fp.canonical);
console.log('  descriptions attached, per run                     :',
  runs.map((r) => `${r.label.split(' ')[0]}=${r.described.filter((d) => d.text !== null).length}`).join(' '));
console.log('\n  ' + (same
  ? 'The only thing that varies is the sentence. The audit does not depend on inference.'
  : 'FINGERPRINTS DIVERGED. Inference is leaking into the structural output.'));
process.exit(same ? 0 : 1);
