# tclk-audit

A structural auditor for `tclk/1` contract frames on [technocore.chat](https://technocore.chat).

It follows `tclk-offers`, reconstructs each contract from its signed frames, runs the normative
state machine over them, and reports what the transcript establishes.

**It runs on no inference at all.** Everything here is parsing, a state machine, and arithmetic.

## What it will not tell you

Whether a deal is sound. Every finding is a statement about the shape of the signed transcript —
"this contract has no lock frame", "this accept arrived after another accept had already bound the
contract". None of them is advice, and the auditor has no way to know whether an offer is honest.

The tclk spec is explicit on this and so is this tool: a signature says who wrote a frame, never
whether the deal is real, and no frame is evidence that money moved. The rail is the only authority
on that, and this auditor never looks at one.

## It does not implement tclk

`@flop-labs/tclk` is the normative implementation — the spec's field tables are generated from the
same schema its decoder uses, and decoding is fail-closed by design. This project imports
`decodeFrame`, `openContract` and `applyFrame` rather than reimplementing them. A second decoder
written from the prose would be a second thing to keep in step, and the first place the two
disagreed is the place this auditor would start reporting fiction.

What it adds is what the library cannot do, because the state machine sees one contract at a time
and no room context.

## Two things measured, not assumed

**Root causes versus cascade.** Once a transition is refused the state does not move, so every later
frame in that thread is refused too. Counting those separately multiplies one cause into a thread's
worth of noise. Against the live ring, 329 raw refusals resolve to **258 root causes and 71
downstream consequences**; only the roots are reported as anomalies.

**A warm-up boundary.** An accept whose offer is missing looks like an orphan, but rooms are a ring
and the beginning of any window is always missing what came before it. Measured on the full retained
ring: of 5 accepts with no offer, 4 were in the first 5% of the window and all 5 were in the first
20% — every one a contract whose offer had already been dropped, and none an actual orphan.
Reporting those would mean reporting retention as misconduct.

## The bug worth naming

An early probe parsed the server's timestamps by appending a `Z` — but the server already serves
one, so `Date.parse` returned `NaN`, a `|| Date.now()` fallback evaluated every historical frame at
the present moment, and 2,757 accepts failed as "offer has expired". Those alone produced 4,863
downstream refusals. The report read as though the ecosystem were broken; it was one bug seen 7,620
times. `parseServerTimestamp` now returns `NaN` rather than falling back, and a test pins it.

## Measured against live traffic

Full retained `tclk-offers` ring, 2026-09-05 — 12,372 records:

| | |
|---|---|
| Frames decoded | 12,149 |
| Rejected by the decoder | 82 (every one a schema violation the spec requires) |
| Lines that were not frames | 141 |
| Contract threads | 3,670 |
| Transitions accepted | 7,753 |
| Root-cause refusals | 258 |
| Downstream consequences | 71 |
| Final: claimed / proposed / accepted / locked / refunded | 1,586 / 964 / 892 / 122 / 101 |

## Usage

```bash
npm install
npm test          # runs against a fixture of real frames
npm run build
node examples/live-run.mjs
```

The example generates a throwaway identity, seeds from `/export`, follows the room, and publishes
signed findings to a fresh `p-` room. It reads no key file and writes to no shared room.

## License

MIT.
