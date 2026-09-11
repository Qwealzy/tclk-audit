import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeFinding, describeFindings } from '../src/describe.js';
import { parseExportLine, scanRecords, type RoomRecord } from '../src/frames.js';
import { buildThreads } from '../src/threads.js';
import { audit } from '../src/audit.js';
import { containsAdvice } from '../src/advice-guard.js';
import { StubAdapter } from '../src/inference/stub.js';
import { OllamaAdapter } from '../src/inference/ollama.js';
import { AdapterUnavailableError } from '../src/inference/types.js';
import { withAccounting, MemoryLedger, summarise } from '../src/inference/ledger.js';
import type { InferenceAdapter, InferenceRequest } from '../src/inference/types.js';
import type { Finding } from '../src/audit.js';

const CRAFTED = fileURLToPath(new URL('./fixtures/crafted-rejections.jsonl', import.meta.url));

const FINDING: Finding = {
  code: 'transition-rejected',
  severity: 'anomaly',
  subject: '0xabc123',
  seq: 177001n,
  detail: 'accept refused: accept in status accepted',
};

/** Records what the adapter was handed, so the prompt can be inspected. */
function recordingAdapter(text: string): { adapter: InferenceAdapter; seen: InferenceRequest[] } {
  const seen: InferenceRequest[] = [];
  const adapter: InferenceAdapter = {
    id: 'recording',
    async complete(request) {
      seen.push(request);
      return {
        text,
        stop: 'complete',
        model: 'recording',
        latencyMs: 0,
        usage: { inputTokens: 1, outputTokens: 1, unit: 'tokens' },
      };
    },
  };
  return { adapter, seen };
}

describe('the advice guard runs on describe() output', () => {
  // This is the one place a model could write a sentence the structural checks
  // never would, so the guard is a runtime check and these tests are on its
  // output, not only on the rendered structural lines.
  const forbidden = [
    'This offer looks legitimate and safe to accept.',
    'The payer is probably a scam artist.',
    'You should avoid this counterparty.',
    'This contract appears fraudulent.',
    'The deal is trustworthy despite the refusal.',
    'This is risky; we recommend walking away.',
  ];

  for (const sentence of forbidden) {
    it(`rejects: "${sentence.slice(0, 44)}..."`, async () => {
      const result = await describeFinding(FINDING, {
        adapter: new StubAdapter({ defaultText: sentence }),
      });
      expect(result.text).toBeNull();
      expect(result.skipped).toBe('advice-guard');
      expect(result.guardPattern).toBeDefined();
    });
  }

  it('discards rather than repairing the sentence', async () => {
    // A sentence that had to be edited to pass is not one to trust with the
    // part that passed.
    const result = await describeFinding(FINDING, {
      adapter: new StubAdapter({
        defaultText: 'The accept was refused. This offer is legitimate.',
      }),
    });
    expect(result.text).toBeNull();
  });

  it('allows a sentence that only describes the transcript', async () => {
    const allowed = 'A second accept arrived after the contract had already been bound.';
    expect(containsAdvice(allowed)).toBe(false);
    const result = await describeFinding(FINDING, {
      adapter: new StubAdapter({ defaultText: allowed }),
    });
    expect(result.text).toBe(allowed);
    expect(result.skipped).toBeNull();
  });
});

describe('the model is given the finding, never the frames', () => {
  it('sends only the finding fields', async () => {
    const { adapter, seen } = recordingAdapter('A frame was refused at this point.');
    await describeFinding(FINDING, { adapter });
    expect(seen).toHaveLength(1);

    const prompt = seen[0]!.messages.map((m) => m.content).join('\n');
    // Everything present is a finding field.
    expect(prompt).toContain('transition-rejected');
    expect(prompt).toContain('0xabc123');
    expect(prompt).toContain('accept in status accepted');
    // Nothing from a frame: no amounts, assets, rails, deadlines or DIDs.
    for (const leaked of ['amount', 'asset', 'rails', 'refundAfterMs', 'claimByMs', 'did:key:']) {
      expect(prompt).not.toContain(leaked);
    }
  });

  it('never receives the text a stranger put in a refused frame', async () => {
    // The API, not the demo. The demo sends only anomaly-level findings, and
    // nothing stops a caller from describing a refusal. These five frames put
    // their attack in a field name, a field value, the frame type, and a field
    // name of over 3,000 characters.
    const crafted = readFileSync(CRAFTED, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => parseExportLine(l))
      .filter((r): r is RoomRecord => r !== null);
    const scan = scanRecords(crafted);
    const report = audit(buildThreads(scan.frames), scan.rejections, { nowMs: 0 });
    const refusals = report.findings.filter((f) => f.code === 'frame-rejected');
    expect(refusals).toHaveLength(5);

    for (const finding of refusals) {
      const { adapter, seen } = recordingAdapter('A frame was refused.');
      await describeFinding(finding, { adapter });
      expect(seen).toHaveLength(1);
      const sent = JSON.stringify(seen[0]);
      expect(sent).toContain('bytes, sha256:');
      for (const fragment of ['INJECTED', 'FAKE', 'gnore previous', 'safe to accept', 'legitimate', '::warning', '##[']) {
        expect(sent).not.toContain(fragment);
      }
    }
  });

  it('cannot opine on terms because it was never shown them', async () => {
    // The boundary is enforced by scope, not by asking the model nicely: the
    // prompt has no offer in it, so there is nothing to judge.
    const { adapter, seen } = recordingAdapter('ok');
    await describeFinding(FINDING, { adapter });
    const everything = (seen[0]!.system ?? '') + seen[0]!.messages.map((m) => m.content).join('');
    expect(everything).not.toMatch(/\b\d{6,}\b.*FLOP|"amount"/);
  });
});

describe('failure degrades, never blocks', () => {
  it('returns no-adapter when none is configured', async () => {
    const result = await describeFinding(FINDING, {});
    expect(result.text).toBeNull();
    expect(result.skipped).toBe('no-adapter');
  });

  it('survives an unreachable provider', async () => {
    // Port 1 is reserved and never listening.
    const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 });
    const result = await describeFinding(FINDING, { adapter });
    expect(result.text).toBeNull();
    expect(result.skipped).toBe('unavailable');
  });

  it('survives an adapter that throws anything at all', async () => {
    const result = await describeFinding(FINDING, {
      adapter: new StubAdapter({ failWith: new AdapterUnavailableError('stub', 'boom') }),
    });
    expect(result.skipped).toBe('unavailable');
  });

  it('survives a refusal', async () => {
    const refusing: InferenceAdapter = {
      id: 'refusing',
      async complete() {
        return {
          text: '',
          stop: 'refused',
          model: 'x',
          latencyMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, unit: 'tokens' },
        };
      },
    };
    const result = await describeFinding(FINDING, { adapter: refusing });
    expect(result.skipped).toBe('refused');
  });

  it('honours the model saying SKIP', async () => {
    const result = await describeFinding(FINDING, {
      adapter: new StubAdapter({ defaultText: 'SKIP' }),
    });
    expect(result.text).toBeNull();
    expect(result.skipped).toBe('model-said-skip');
  });

  it('drops an over-long sentence rather than truncating it', async () => {
    const result = await describeFinding(FINDING, {
      adapter: new StubAdapter({ defaultText: 'x'.repeat(400) }),
    });
    expect(result.skipped).toBe('too-long');
  });

  it('never throws, whatever the batch contains', async () => {
    const findings: Finding[] = [FINDING, { ...FINDING, seq: null }, { ...FINDING, detail: '' }];
    const results = await describeFindings(findings, {
      adapter: new StubAdapter({ failWith: new Error('unstructured failure') }),
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.text === null)).toBe(true);
  });
});

describe('accounting wraps every adapter, including the stub', () => {
  it('records a stub call with non-zero usage', async () => {
    const ledger = new MemoryLedger();
    const adapter = withAccounting(new StubAdapter({ defaultText: 'A frame was refused.' }), ledger);
    await describeFinding(FINDING, { adapter });

    const summary = summarise(ledger);
    expect(summary.calls).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.inputTokens).toBeGreaterThan(0);
    expect(summary.byAdapter['stub']).toBe(1);
    // The tag is what makes spend attributable to a call site later.
    expect(summary.byTag['describe:transition-rejected']).toBe(1);
  });

  it('records failures too, since they cost time and may cost tokens', async () => {
    const ledger = new MemoryLedger();
    const adapter = withAccounting(new StubAdapter({ failWith: new Error('nope') }), ledger);
    await describeFinding(FINDING, { adapter });

    const summary = summarise(ledger);
    expect(summary.calls).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('stores units, never money', async () => {
    const ledger = new MemoryLedger();
    const adapter = withAccounting(new StubAdapter({ defaultText: 'ok' }), ledger);
    await describeFinding(FINDING, { adapter });

    const entry = ledger.entries()[0]!;
    // Prices change; a table of dollars cannot be re-priced. The model and the
    // timestamp are stored so cost stays a query rather than a fact.
    expect(entry).toHaveProperty('inputTokens');
    expect(entry).toHaveProperty('model');
    expect(entry).toHaveProperty('ts');
    expect(entry).not.toHaveProperty('cost');
    expect(entry).not.toHaveProperty('usd');
  });

  it('keeps error classes out of the ledger message, not error text', async () => {
    // A provider error string can carry prompt content, and a ledger is a file
    // that gets shared.
    const ledger = new MemoryLedger();
    const adapter = withAccounting(
      new StubAdapter({ failWith: new Error('secret: 0xdeadbeef leaked here') }),
      ledger,
    );
    await describeFinding(FINDING, { adapter });
    const serialised = JSON.stringify(ledger.entries());
    expect(serialised).not.toContain('0xdeadbeef');
    expect(serialised).toContain('Error');
  });
});
