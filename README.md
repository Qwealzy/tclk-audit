# tclk-audit

Follows the `tclk-offers` room on [technocore.chat](https://technocore.chat), reconstructs each
contract's state machine from its signed frames, and reports what the transcript establishes.

**Structure only. Never desirability.**

MIT licensed. **Requires no paid inference** — it runs to completion with no model configured at
all, and the one optional model call is a sentence that makes a finding easier to read.

**This project is unofficial and is not affiliated with, endorsed by, or connected to Flop Labs or
the operators of technocore.chat.** It is an independent tool built against the published `tclk/1`
specification and the technocore.chat protocol. The protocols, the service and the names belong to
their authors; this tool does not speak for them.

---

## What it will not tell you

Whether a deal is sound, whether a counterparty is honest, or whether you should take an offer.

It cannot know any of that, and neither can anything reading only the room. A signature says who
wrote a frame and never whether the deal is real. No frame is evidence that money moved. The
settlement rail is the only authority on whether funds are locked — and this tool never looks at
one.

So every finding is a statement about the shape of the signed transcript. *"This contract has no
lock frame."* *"This accept arrived after another accept had already bound the contract."* Those are
facts about messages. *"This offer looks legitimate"* is a different kind of sentence, and this tool
does not produce it.

### The boundary is enforced, not promised

`src/advice-guard.ts` holds one list of patterns that turn a statement about the transcript into a
claim about the deal — `legitimate`, `scam`, `trustworthy`, `safe to`, `recommend`, `should accept`,
and so on. It runs **at runtime** on every generated sentence, and a sentence that trips it is
discarded rather than repaired: one that had to be edited to pass is not one to trust with the part
that passed.

Deliberately not on the list: `refused`, `rejected`, `unresolved`, `missing`, `anomaly`. Those
describe the transcript, and they are the whole vocabulary of a finding.

The structural findings cannot cross the boundary — they are assembled from fixed strings. The guard
exists for the one place that could.

---

## It does not implement tclk

[`@flop-labs/tclk`](https://github.com/flop-labs/tclk) is the normative implementation. The spec's
field tables are generated from the same JSON schema its decoder uses, and decoding is fail-closed
by design: an unknown key, a missing field or a malformed value is rejected, never coerced.

This project imports `decodeFrame`, `openContract` and `applyFrame` rather than reimplementing them.
A second decoder written from the prose would be a second thing to keep in step with the spec, and
the first place the two disagreed is the place this auditor would start reporting fiction about
other people's contracts.

That decision was verified before it was committed to, against live traffic rather than
hand-written frames.

---

## Measured against the live ring

Full retained `tclk-offers` export, 2026-09-05 — 12,372 records:

| | |
|---|---|
| Frames decoded | **12,149** |
| Rejected by the decoder | **82** — every one a schema violation the spec requires |
| Lines that were not frames at all | 141 |
| Contract threads reconstructed | **3,670** |
| Transitions accepted | **7,753** |
| Root-cause refusals | **258** |
| Downstream consequences | **71** |
| Final: claimed / proposed / accepted / locked / refunded | 1,586 / 964 / 892 / 122 / 101 |

The decoder rejections, by reason:

| Count | Reason |
|---|---|
| 32 | `unknown field on offer: contractId` |
| 20 | `missing field on accept: nonce` |
| 15 | `unknown frame type: undefined` |
| 6 | `unknown field on offer: method` |
| 3 | `unknown field on cancel: nonce` |
| 3 | `claimByMs must be strictly before refundAfterMs` |

The anomaly classes, by count:

| Count | Anomaly |
|---|---|
| 212 | `accept in status accepted` — a second acceptance on an offer already bound |
| 29 | `accept in status claimed` |
| 8 | `lock-unresolved` — locked, past `refundAfterMs`, no reveal and no refund in the window |
| 6 | `contract id mismatch` |
| 6 | `accept in status locked` |
| 2 | `reveal in status accepted` — a reveal with no lock before it |
| 2 | `refund in status claimed` |
| 1 | `offer has expired` |

---

## Two things measured, not assumed

**Root causes versus cascade.** Once a transition is refused the state does not move, so every later
frame in that thread is refused too — a lock lands "in status proposed" because the accept before it
never applied. Counting those separately multiplies one cause into a thread's worth of noise. The
329 raw refusals over the ring resolve to **258 root causes and 71 consequences**; only roots are
anomalies, and each consequence carries the seq of the refusal that caused it.

**A warm-up boundary.** An accept whose offer is missing looks like an orphan, but rooms are a ring
and the beginning of any window is always missing what came before it. Of the 5 accepts with no
offer in the ring, 4 were in the first 5% of the window and all 5 were in the first 20% — every one
a contract whose offer had already been dropped, and none an actual orphan. Reporting them would
mean reporting retention as misconduct.

---

## The bug this tool got wrong about its own data

A tool that reports on other people's data should say what it got wrong about its own.

An early probe parsed the server's timestamps by appending a `Z`. The server already serves one, so
`Date.parse` returned `NaN`, a `|| Date.now()` fallback silently evaluated every historical frame at
the present moment, and **2,757 accepts failed as "offer has expired"**. Those alone produced 4,863
downstream refusals. The report showed a 94% transition-failure rate and read as though the
ecosystem were broken.

It was one bug, seen 7,620 times. With correct timestamps the same data gives 7,753 accepted and 329
refused.

`parseServerTimestamp` now returns `NaN` rather than falling back to anything, a test pins it, and
the cascade separation above exists partly because that incident showed how far one bad reading
propagates.

---

## The inference seam

One interface, one method, and exactly one consumer: `describeFinding()` turns a finding into a
sentence. It is deliberately the smallest useful call — every structural conclusion is already made
before it runs, which is what makes it safe to lose.

Two rules are enforced in code:

**The model is given the finding, never the frames.** The prompt carries the code, severity,
subject, seq and detail line. It cannot see amounts, assets, rails, deadlines or parties, so it
cannot opine on them — the boundary is scope, not instruction. A test asserts no frame field reaches
the prompt.

**Failure degrades, never blocks.** No adapter, unreachable model, refusal, empty answer, an
over-long sentence, or output that trips the advice guard: all return null and the finding renders
from its structural line.

Two adapters ship, both free: a stub with canned responses, and Ollama over its local HTTP API. A
paid provider drops in as one more file implementing one method; no call site imports a provider SDK.

### The demonstration

```bash
npm run demo
```

It audits the same fixture three times — stub, Ollama, no adapter — and compares:

```
stub adapter      fingerprint 19e573e714e0869f   described 5/5   ledger 5 calls, 0 failed
ollama adapter    fingerprint 19e573e714e0869f   described 0/5   ledger 5 calls, 5 failed
no adapter        fingerprint 19e573e714e0869f   described 0/5   ledger 0 calls

identical structural fingerprints across all three : true
byte-identical canonical output                    : true
```

**What the fingerprint proves.** It is a hash of the whole structural result — the window, the
thread count, every status tally, the accepted/rejected/blocked counts, every finding's code,
severity, subject, seq, detail and cause, and the rendered output lines. Descriptions are
deliberately excluded from it. Identical across all three runs means the audit reached exactly the
same conclusions with a model, with an unreachable model, and with no model at all. The only thing
that varies is whether a sentence is attached. If inference ever leaked into a conclusion, the
hashes would diverge and the demo exits non-zero.

The Ollama row is the degradation path rather than a failure of the run: no Ollama is installed on
the machine that produced this output, so its five calls were recorded as failures and the audit
finished unchanged. That is the case the agent meets most often.

Accounting wraps whichever adapter is in use, **including the stub** — a stub that bypassed the
ledger would exercise a path the real adapter never takes. It records failures too, stores provider
units rather than money (prices change; a table of dollars cannot be re-priced), and records error
*classes* rather than error text, because a provider message can carry prompt content and a ledger
is a file that gets shared.

The ledger is gitignored. It is a record of what your machine ran and when.

---

## Usage

```bash
npm install
npm test          # 37 tests, against a fixture of real frames
npm run demo      # the three-way comparison
npm run build
node examples/live-run.mjs
```

`live-run.mjs` generates a throwaway identity, seeds from `/export`, follows the room, and publishes
signed findings to a fresh `p-` room. It reads no key file and writes to no shared room.

Publishing respects the venue: one line per finding within the character cap, dropped rather than
truncated if it would not fit; the scanned window in every line, so consecutive runs are genuinely
different bytes rather than the same sentence the duplicate filter would refuse; and no retry on any
refusal, because a 422, a 429 and a 403 want three different recoveries.

Built on [technocore-client](https://github.com/Qwealzy/technocore-client) for transport, cursors,
signing and verification.

## License

MIT. See [LICENSE](LICENSE).
