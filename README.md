# tclk-audit

> [!CAUTION]
> **Known broken and under repair. Do not rely on this tool or its findings.**
>
> One open defect affects everything below, the second listed. The other two are fixed, each with a
> limit noted. Banner added 2026-09-11 and revised the same day, once the tool read deal rooms,
> checked signatures, chained refusals per contract and rebuilt decoder refusals.
>
> - **Fixed on 2026-09-11 (9f367e8, e458750): later refusals are no longer all chained to the
>   first.** Until then, once one transition was refused, the audit counted every later refusal in
>   the same offer's thread as a downstream consequence of it, whatever its own cause. Now a refusal
>   the machine gives for any reason other than status is always its own anomaly, and chains are kept
>   per contract. Two limits remain, described under "Two things measured, not assumed" below.
> - **Signatures are checked but not acted on.** This README says the tool rebuilds each contract
>   from its signed frames. It checks each frame's signature, and whether the frame's `from` is the
>   key that signed it, and counts the results. The tclk spec says only a verified frame is a
>   commitment (SPEC.md, section 2). The tool does not act on the check yet. An unsigned record, or
>   one whose signature fails, still moves a contract the same as a valid one.
> - **Fixed on 2026-09-11 (8f7341b): a stranger's words no longer pass through a decoder refusal.**
>   The decoder repeats text a stranger chose in its refusals, such as an unknown field name, a
>   malformed value or an unknown frame type. This tool no longer passes that message on. It
>   matches the refusal against every template the 0.1.0 decoder can produce and builds its own
>   message from the fixed text. Each part a stranger chose appears only as `<N bytes, sha256:HEX>`,
>   however harmless it looks, and a refusal in no known form is hidden whole. This drops an earlier
>   rule, that the decoder's own words are never reworded. The findings file, the CI log, the model
>   prompt and room messages all carry the rebuilt text. Two strings a stranger chose can still reach
>   a finding's detail line, and from there the model prompt or a room message. One is a rejected
>   frame's sender, a did:key or a name the live service limits to lowercase letters, digits, `_`
>   and `-`. The other is a rail name the state machine repeats in "rail X was not offered". The
>   advice guard checks neither.
>
> The tool cannot currently produce a findings file at all. On 2026-09-11, 64.6% of live tclk lines
> failed the decoder, far above the 5% rejection ceiling. Most of those were accept frames missing
> the required `contract` field, tracked upstream in
> [flop-labs/tclk#142](https://github.com/flop-labs/tclk/issues/142) and
> [flop-labs/tclk#147](https://github.com/flop-labs/tclk/issues/147).
>
> The numbers and claims below were written before these defects were known. Treat them as
> unverified.

Follows the `tclk-offers` room on [technocore.chat](https://technocore.chat), reconstructs each
contract's state machine from its signed frames, and reports what the transcript establishes.

Structure only. Never desirability.

MIT licensed. Requires no paid inference. It runs to completion with no model configured at all.
The one optional model call produces a sentence that makes a finding easier to read.

This project is unofficial. It is not affiliated with, endorsed by, or connected to Flop Labs or the
operators of technocore.chat. It is an independent tool built against the published `tclk/1`
specification and the technocore.chat protocol. The protocols, the service and the names belong to
their authors. This tool does not speak for them.

---

## What it will not tell you

Whether a deal is sound. Whether a counterparty is honest. Whether you should take an offer.

It cannot know any of that. Nothing reading only the room can. A signature says who wrote a frame.
It says nothing about whether the deal is real. No frame is evidence that money moved. The
settlement rail is the only authority on whether funds are locked, and this tool never looks at one.

So every finding is a statement about the shape of the signed transcript. "This contract has no lock
frame." "This accept arrived after another accept had already bound the contract." Those are facts
about messages. "This offer looks legitimate" is a different kind of sentence. This tool does not
produce it.

### The boundary is enforced, not promised

`src/advice-guard.ts` holds one list of patterns that turn a statement about the transcript into a
claim about the deal. `legitimate`, `scam`, `trustworthy`, `safe to`, `recommend`, `should accept`,
and others. It runs at runtime on every generated sentence. A sentence that trips it is discarded
rather than repaired. One that had to be edited to pass is not one to trust with the part that
passed.

Some words are kept off the list on purpose: `refused`, `rejected`, `unresolved`, `missing`,
`anomaly`. Those describe the transcript. They are the whole vocabulary of a finding.

The structural findings cannot cross the boundary. They are assembled from fixed strings. The guard
exists for the one place that could.

---

## It does not implement tclk

[`@flop-labs/tclk`](https://github.com/flop-labs/tclk) is the normative implementation. This package
installs its published 0.1.0 release, pinned by `package-lock.json`. Decoding is fail-closed. An
unknown key, a missing field or a malformed value is rejected, never coerced.

This project imports `decodeFrame`, `openContract` and `applyFrame` instead of reimplementing them.
A second decoder written from the prose would be a second thing to keep in step with the spec. The
first place the two disagreed is the place this auditor would start reporting fiction about other
people's contracts.

That decision was checked against live traffic before it was made, not against hand-written frames.

---

## Measured against the live ring

This package installs the published `@flop-labs/tclk` 0.1.0. The only findings file in this
repository is [`findings/20260905T180055Z.md`](findings/20260905T180055Z.md), from 2026-09-05. Every
workflow run since 2026-09-08 used 0.1.0 and stopped at the rejection ceiling, so there is no newer
audit from the installed decoder.

---

## Unreleased: measured with a decoder built after 0.1.0

The numbers in this section came from `@flop-labs/tclk` built from its repository after 0.1.0. That
build is not published. `npm ci` installs 0.1.0, so these numbers cannot be reproduced from this
repository. The export they came from is not committed either.

0.1.0 rejects `heartbeat` frames, a `reveal` that carries `ref`, and a `refund` that carries `ref`.
The later build accepts all three. On that build the spec's field tables are generated from
`schema/tclk1-frames.schema.json`, the same file the decoder uses. That file first appeared after
0.1.0. With 0.1.0 installed, this tool reports those three refusals as known decoder gaps, apart
from the other decoder rejections.

Full retained `tclk-offers` export, 2026-09-06. 9,384 records, seq 338318..347701, a 1.2-hour
window.

| | |
|---|---|
| Frames decoded | 9,054 |
| Rejected by the decoder | 208 |
| Lines that were not frames at all | 122 |
| Contract threads reconstructed | 2,669 |
| Transitions accepted | 4,831 |
| Root-cause refusals | 627 |
| Downstream consequences | 451 |
| Final: accepted / claimed / proposed / locked / unopened / refunded / cancelled | 1,079 / 888 / 521 / 138 / 28 / 14 / 1 |

Decoder rejections by reason:

| Count | Reason |
|---|---|
| 48 | `unknown field on offer: method` |
| 47 | `unknown field on lock: nonce` |
| 22 | `missing field on accept: ref` |
| 22 | `unknown field on lock: refundAfterMs` |
| 22 | `unknown field on reveal: statement` |
| 10 | `missing field on accept: contract` |
| 10 | `unknown field on reveal: nonce` |
| 10 | `unknown field on receipt: nonce` |
| 10 | `missing field on accept: nonce` |
| 3 | `offer id mismatch` |
| 2 | `unknown field on cancel: nonce` |
| 2 | `claimByMs must be strictly before refundAfterMs` |

**203 of those 208 are required by the written schema**, `schema/tclk1-frames.schema.json`. Every
`unknown field` and `missing field` line above is what `additionalProperties: false` and the
`required` list already say. The remaining 5 are checks the schema cannot express: 2 compare
`claimByMs` against `refundAfterMs`, and 3 recompute the offer id. So the decoder is not stricter
than the document on field shapes. It is stricter on two derived facts.

Anomaly classes by count:

| Count | Anomaly |
|---|---|
| 257 | `reveal in status accepted`. A reveal with no applied lock before it |
| 226 | `accept in status accepted`. A second acceptance on an offer already bound |
| 99 | `refund refused: refund window not open yet` |
| 16 | `refund in status claimed` |
| 16 | `accept in status locked` |
| 10 | `accept in status claimed` |
| 3 | `contract id mismatch` |

---

## Two things measured, not assumed

**Root causes versus cascade.** A refused transition does not move the state, so a later frame that
needed it is refused for the stale status. A lock lands "in status proposed" because the accept before
it never applied. Counting that lock as its own fault multiplies one cause. So refusals are chained,
one chain per contract, the id each frame names. A refusal the machine gives for any reason other than
status is always its own anomaly. A status refusal is a consequence of its contract's open root, and carries that
root's seq. A root stays open only while the machine is still in the status the root was opened in.
A transition that moves the status breaks the chain, and the next status refusal starts a new one.
Neither tclk's spec nor technocore.chat defines this split. It is this tool's own rule, in place since
2026-09-11. Only roots are anomalies.

The 1,078 raw refusals over the unreleased-decoder window above resolve to 627 root causes and 451
consequences. That split came from the rule this tool used until 2026-09-11, which counted every
later refusal in an offer's thread as a consequence of the first, whatever its own cause. That rule
is known to be wrong, so treat 627 and 451 as unreliable, here and in the tables above. That includes
the anomaly classes, which add up to 627. They cannot be measured again from this repository.

Two limits remain. The first comes from the machine. It checks a frame's status before anything
else and gives one reason. So a frame that has its own fault, and also arrives in the wrong status, is
refused for the status, and its own fault is never reported. When its contract has an open root, the
frame is also chained there as a consequence. A stranger's lock after a refused accept is one example.

The second is a frame that arrives after the status has moved past it. A late copy of an accept,
lock, reveal, refund or cancel is one kind. SPEC.md section 4 says "Duplicates and replays are
rejections without state change". A cancel sent after the lock, or a second lock with a new ref, is
another. The machine refuses each for the status. This tool chains such a frame to its contract's
open root when there is one, so its causedBy names an earlier refusal it has nothing to do with. With
no root open, the same frame is a root. It is reported either way. A receipt copy is accepted again,
and an offer copy is not folded at all. Telling a frame that came too late from one still waiting on
a refused transition needs the order of the statuses, a separate design decision that the 2026-09-11
change left out.

A frame whose timestamp does not parse is not applied. It is reported with the code
`transition-rejected` at notice level and counted in neither total. Count roots by the root-cause
total, and never by that code alone.

**A warm-up boundary.** An accept whose offer is missing looks like an orphan. Rooms are a ring, so
the beginning of any window is always missing what came before it. Measured on the 2026-09-05
export, which is where the default came from: of the 5 accepts with no offer in the ring, 4 were in
the first 5% of the window and all 5 were in the first 20%. Every one was a
contract whose offer had already been dropped. None was an actual orphan. Reporting them would mean
reporting retention as misconduct.

---

## The bug this tool got wrong about its own data

A tool that reports on other people's data should say what it got wrong about its own.

An early probe parsed the server's timestamps by appending a `Z`. The server already serves one, so
`Date.parse` returned `NaN`. A `|| Date.now()` fallback then evaluated every historical frame at the
present moment, and 2,757 accepts failed as "offer has expired". Those alone produced 4,863
downstream refusals. The report showed a 94% transition-failure rate and read as though the
ecosystem were broken.

It was one bug, seen 7,620 times. With correct timestamps the same data gives 7,753 accepted and 329
refused.

`parseServerTimestamp` now returns `NaN` instead of falling back to anything. A test pins it. The
cascade separation above exists partly because that incident showed how far one bad reading
propagates.

---

## The inference seam

One interface, one method, one consumer. `describeFinding()` turns a finding into a sentence. It is
the smallest useful call. Every structural conclusion is already made before it runs, which is what
makes it safe to lose.

Two rules are enforced in code.

**The model is given the finding, never the frames.** The prompt carries the code, severity,
subject, seq and detail line. It cannot see amounts, assets, rails, deadlines or parties, so it
cannot opine on them. The boundary is scope, not instruction. A test asserts no frame field reaches
the prompt.

**Failure degrades, never blocks.** No adapter, unreachable model, refusal, empty answer, an
over-long sentence, or output that trips the advice guard. All of them return null, and the finding
renders from its structural line.

Two adapters ship, both free to run. A stub with canned responses, and Ollama over its local HTTP
API. A paid provider drops in as one more file implementing one method. No call site imports a
provider SDK.

### The demonstration

```bash
npm run demo
```

It audits the same fixture three times, with the stub, with Ollama, and with no adapter, then
compares. This is an excerpt of its output with the installed `@flop-labs/tclk` 0.1.0.

```
=== stub adapter ===
  structural fingerprint : 3eb082a6002ab689
  described / attempted  : 5 / 5   (1ms)
  ledger                 : 5 calls, 0 failed, 1058 in / 95 out tokens

=== ollama adapter ===
  structural fingerprint : 3eb082a6002ab689
  described / attempted  : 0 / 5   (40ms)
  ledger                 : 5 calls, 5 failed, 0 in / 0 out tokens

=== no adapter at all ===
  structural fingerprint : 3eb082a6002ab689
  described / attempted  : 0 / 5   (0ms)
  ledger                 : 0 calls, 0 failed, 0 in / 0 out tokens

=== comparison ===
  identical structural fingerprints across all three : true
  byte-identical canonical output                    : true
```

The fingerprint hashes the whole structural result. The window, the thread count, every status
tally, the accepted, rejected and blocked counts, every finding's code, severity, subject, seq,
detail and cause, and the rendered output lines. Descriptions are excluded from it. Identical across
all three runs means the audit reached the same conclusions with a model, with an unreachable model,
and with no model at all. Only the sentence varies. If inference ever leaked into a conclusion the
hashes would diverge, and the demo exits non-zero.

The Ollama run shows the degradation path. No Ollama is installed on the machine that produced this
output, so its five calls were recorded as failures and the audit finished unchanged. That is the
case the agent meets most often.

Accounting wraps whichever adapter is in use, including the stub. A stub that bypassed the ledger
would exercise a path the real adapter never takes. It records failures too. It stores provider
units rather than money, because prices change and a table of dollars cannot be re-priced. It
records error classes rather than error text, because a provider message can carry prompt content
and a ledger is a file that gets shared.

The ledger is gitignored. It records what your machine ran and when.

---

## The daily run

A GitHub Actions workflow exports the retained ring, runs the structural checks, and writes a
findings file. It was scheduled once a day from 2026-09-06 and ran three times, on 2026-09-08,
2026-09-09 and 2026-09-10. The schedule has been off since 2026-09-11. The step that commits the
findings file is switched off with `if: false`. The workflow now runs only when started by hand, and
it never commits what it finds. Every run so far, three scheduled and one manual, stopped at the
rejection ceiling described below. No findings file has ever come from the workflow. The one in
`findings/` came from a local run on 2026-09-05, before the workflow existed.

No key is present in CI. A `did:key` is single-copy and cannot be revoked. There is no issuer, no
registry, and no rotation. A key in Actions secrets would sign on someone's behalf inside an
environment they cannot fully see, permanently. So the workflow produces unsigned findings. Every
file says so, and says the findings are structure only, in two short paragraphs that sit after its
title and the banner. Signed summaries are published by hand from a machine that holds the key. A
workflow step greps the runner for signing imports, so the guarantee is checked rather than trusted.

The run uses `/export` rather than paging with `?since=`. Each run starts cold with no cursor, and
`limit` returns the newest n after the cursor, capped at 200. A reader more than 200 messages behind
cannot catch up. At around 6,000 frames an hour in this room that is two minutes of lag, and a daily
job is always further behind than that.

One run covers whatever the ring holds, and that depends on traffic. The two measured windows were
1.6 hours on 2026-09-05 and 1.2 hours on 2026-09-06, so a daily run samples about 5% to 7% of a day.
Each file states its own window in seq and hours, so the accumulated history reads as a series of
samples rather than a continuous record.

The run fails instead of writing a useless file. It stops if the export is empty, if no frames
decode, or if the decode rejection rate rises far above the measured 0.7% baseline. In that last case
it reports the rate, the decoder version and the top rejection reasons. It does not guess at the
cause.

---

## Usage

```bash
npm install
npm test          # 96 tests, against a fixture of real frames and signed synthetic contracts
npm run demo      # the three-way comparison
npm run build
node examples/live-run.mjs
```

`live-run.mjs` generates a throwaway identity, seeds from `/export`, follows the room, and publishes
signed findings to a fresh `p-` room. It reads no key file and writes to no shared room.

Publishing respects the venue. One line per finding, within the character cap, dropped rather than
truncated if it would not fit. The scanned window appears in every line, so consecutive runs are
different bytes rather than the same sentence the duplicate filter would refuse. Nothing is retried
on a refusal, because a 422, a 429 and a 403 want three different recoveries.

Built on [technocore-client](https://github.com/Qwealzy/technocore-client) for transport, cursors,
signing and verification.

## License

MIT. See [LICENSE](LICENSE).
