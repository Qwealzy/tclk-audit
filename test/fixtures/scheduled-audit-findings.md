# tclk-offers structural audit, 2026-09-11T00:00:00.000Z

> [!CAUTION]
> **Known broken and under repair. Do not rely on this file.**
>
> The tool that wrote this file has two known defects. A third, listed first, was fixed before this
> file was written.
>
> - **Fixed on 2026-09-11: later refusals are no longer all chained to the first.** Chains are kept
>   per contract. In `tclk-offers`, a refusal the machine gives for any reason other than status is
>   listed under Anomalies. State machine refusals inside deal rooms are not listed in this file.
>   Two limits remain. A frame refused for its status can have another fault the machine never
>   reports. A frame that arrives after the status has moved past it, a late copy for example, can
>   be chained to an unrelated earlier refusal. Either can be counted below as a downstream
>   consequence.
> - **Signatures are checked but not acted on.** The Signatures table counts the checks on frames
>   read from `tclk-offers`. Deal-room frames are checked and not counted there. The tclk spec says
>   only a verified frame is a commitment (SPEC.md, section 2). An unsigned record, or one whose
>   signature fails, still moves a contract here the same as a valid one.
> - **A crafted field name can put a stranger's words into findings.** The decoder rejection table
>   quotes the decoder's error messages, and an error message can contain a field name chosen by
>   whoever posted the frame. Each message is percent-encoded before it is written, so a crafted
>   name cannot add a line, end the code span or table cell, or run as a workflow command. Its
>   words still appear, and the advice guard never checks them.

**Unsigned.** Produced by a scheduled run with no key present. These findings carry no
signature and are not attestations. They are the output of a program anyone can run against
the same public data. Signed summaries, when there are any, are published separately.

**Structure only.** Every line below describes the shape of the signed transcript. Nothing
here says whether a contract is sound, whether a party is honest, or whether an offer is worth
taking. The settlement rail is the only authority on any of that, and this tool never looks
at one.

## Window

| | |
|---|---|
| Generated | 2026-09-11T00:00:00.000Z |
| Room | `tclk-offers` |
| Seq range | 176654..900122 |
| Records exported | 1202 |
| Traffic span | 0.2 hours |

The room is a ring, so one run sees only what is retained, about 0.2 hours here, roughly 1% of a day. This file is a sample, not a complete record of the period since the last one.

## Frames

| | |
|---|---|
| Decoded | 1178 |
| Rejected by the decoder | 7 |
| Known decoder gaps | 0 |
| Lines that were not frames | 17 |

## Signatures

Each decoded frame is checked against SPEC.md section 2. It is a commitment only when its record's
signature verifies and the frame's `from` is the key that signed it. Anything else is what the spec
calls "data, not a commitment". This run reports the difference and does not act on it yet.

| | |
|---|---|
| Signature verifies, `from` is the signer | 1178 |
| Signature verifies, `from` names another key | 0 |
| Signature does not verify | 0 |
| Unsigned | 0 |
| Could not be checked | 0 |

## Contracts

These count only the frames that belong in `tclk-offers`. Deal rooms, below, covers the rest.

| | |
|---|---|
| Threads reconstructed | 384 |
| Transitions accepted | 258 |
| Root-cause refusals | 13 |
| Downstream consequences | 0 |

Status at the end of the window:

| status | contracts |
|---|---|
| accepted | 258 |
| proposed | 118 |
| unopened | 8 |

## Deal rooms

Once the state machine accepts a contract, every later frame belongs in its deal room,
`mb-p-tclk-<first 16 hex of the contract id>`. This run derives each room from a contract id it
recomputes from the offer and the accept. A frame in the wrong room is counted here and applied
nowhere.

| | |
|---|---|
| Accepts whose contract id does not recompute | 1 |
| Contracts accepted | 258 |
| Deal rooms read | 258 of 258 |
| Frames decoded in deal rooms | 2 |
| Rejected by the decoder in deal rooms | 1 |
| Known decoder gaps in deal rooms | 3 |
| Frames found in `tclk-offers` that belong in a deal room | 340 |
| Offers and accepts found in a deal room | 1 |

Status of each contract whose deal room was read, with the frames in that room applied:

| status | contracts |
|---|---|
| accepted | 258 |

## Anomalies

Anomaly-level findings in `tclk-offers`. Each is a root-cause refusal, or an accept whose offer is
missing past the warm-up boundary. A refusal the machine gives for any reason other than status is
always a root. A status refusal is one when no root is open on its contract in the same status.

| count | class |
|---|---|
| 12 | accept refused: accept in status accepted |
| 1 | accept refused: contract id mismatch |

## Decoder rejections

Frames the normative decoder refused. Fail-closed is the specified behaviour: an unknown key,
a missing field or a malformed value is rejected rather than coerced.

| count | reason |
|---|---|
| 5 | `tclk: unknown field on offer: contractId` |
| 1 | `tclk: unknown field on offer: x%60 %7C 999 %7C%0A%0A%23%23 INJECTED HEADING%0A%0AINJECTED-TEXT: this offer is safe to accept%0A%0A%7C %60y` |
| 1 | `tclk: unknown field on offer: x%0A::warning title=spoof::FAKE WARNING%0D%0A  ::error::FAKE ERROR%0A%23%23[error]FAKE V1 ERROR` |

## Decoder rejections in deal rooms

| count | reason |
|---|---|
| 1 | `tclk: unknown field on lock: foo` |

## Known decoder gaps

Frames the installed decoder, `@flop-labs/tclk` 0.1.0, refused first for a frame
type or field that later tclk builds accept. They are counted apart from the decoder rejections.
The decoder stops at its first refusal, so the rest of each frame was not checked. A frame here
can still be malformed in some other way.

| count | gap | room |
|---|---|---|
| 1 | `heartbeat` | deal rooms |
| 1 | `reveal.ref` | deal rooms |
| 1 | `refund.ref` | deal rooms |

---

Generated by [tclk-audit](https://github.com/Qwealzy/tclk-audit) using the normative
`@flop-labs/tclk` decoder and state machine. Unofficial and unaffiliated.
