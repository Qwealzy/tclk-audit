# tclk-offers structural audit, 2026-09-11T00:00:00.000Z

> [!CAUTION]
> **Known broken and under repair. Do not rely on this file.**
>
> The tool that wrote this file has no open defect on this list. All three were fixed before this
> file was written.
>
> - **Fixed on 2026-09-11: later refusals are no longer all chained to the first.** Chains are kept
>   per contract. In `tclk-offers`, a refusal the machine gives for any reason other than status is
>   listed under Anomalies. State machine refusals inside deal rooms are not listed in this file.
>   Two limits remain. A frame refused for its status can have another fault the machine never
>   reports. A frame that arrives after the status has moved past it, a late copy for example, can
>   be chained to an unrelated earlier refusal. Either can be counted below as a downstream
>   consequence.
> - **Fixed on 2026-09-12: only a frame whose signature verifies moves a contract.** The tclk spec
>   says only a verified frame is a commitment (SPEC.md, section 2). A frame whose record is
>   unsigned, whose signature does not verify, whose `from` names another key, or whose signature
>   this tool could not check is left out, in `tclk-offers` and in deal rooms alike. Signature policy
>   below counts each kind. One limit remains. An unsigned frame is left out even when its sender
>   is honest, since the spec calls it data, not a commitment. A file written before 2026-09-12
>   counted frames this one leaves out, so counts across that date do not compare.
> - **Fixed on 2026-09-11: a stranger's words no longer reach this file through a decoder refusal.**
>   Each refusal below is rebuilt from the decoder's fixed text. Every part a stranger chose, such
>   as a field name, a value or a frame type, appears only as its byte length and SHA-256.

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
| Seq range | 176654..900128 |
| Records exported | 1208 |
| Traffic span | 0.2 hours |

The room is a ring, so one run sees only what is retained, about 0.2 hours here, roughly 1% of a day. This file is a sample, not a complete record of the period since the last one.

## Frames

| | |
|---|---|
| Decoded | 1180 |
| Rejected by the decoder | 10 |
| Refused by the shape check after decoding | 1 |
| Known decoder gaps | 0 |
| Lines that were not frames | 17 |

## Signature policy

Each decoded frame is checked against SPEC.md section 2. It is a commitment only when its record's
signature verifies and the frame's `from` is the key that signed it. Anything else is what the spec
calls "data, not a commitment". This run applies only the commitments. Every other decoded frame
is left out of the audit, in `tclk-offers` and in deal rooms alike, and counted here.

| | `tclk-offers` | deal rooms | |
|---|---|---|---|
| Signature verifies, `from` is the signer | 1180 | 2 | applied |
| Signature verifies, `from` names another key | 0 | 0 | left out. It breaks a MUST in SPEC.md section 2 |
| Signature does not verify | 0 | 0 | left out |
| Unsigned | 0 | 0 | left out. Not re-verifiable, which is not the same as invalid |
| Could not be checked | 0 | 0 | left out. A limit of this tool, not the sender's |

Signatures that do not verify are counted on their own. A sudden rise there more likely means a
fault in this tool than many senders at once. A nonce that loses digits on the way in fails a good
signature, for example.

## Contracts

These count only the frames that belong in `tclk-offers` and whose signature verifies. Deal rooms,
below, covers the rest.

| | |
|---|---|
| Threads reconstructed | 385 |
| Transitions accepted | 258 |
| Root-cause refusals | 14 |
| Downstream consequences | 0 |

Status at the end of the window:

| status | contracts |
|---|---|
| accepted | 258 |
| proposed | 119 |
| unopened | 8 |

## Deal rooms

Once the state machine accepts a contract, every later frame belongs in its deal room,
`mb-p-tclk-<first 16 hex of the contract id>`. This run derives each room from a contract id it
recomputes from the offer and the accept. A frame in the wrong room is counted here and applied
nowhere. Every count here is over verified frames, so an accept left out by the signature check
is not among the mismatches either.

| | |
|---|---|
| Accepts whose contract id does not recompute | 1 |
| Contracts accepted | 258 |
| Deal rooms read | 258 of 258 |
| Frames decoded in deal rooms | 2 |
| Rejected by the decoder in deal rooms | 1 |
| Refused by the shape check in deal rooms | 4 |
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
| 1 | accept refused: offer has expired |

## Decoder rejections

Frames the normative decoder refused. Fail-closed is the specified behaviour: an unknown key,
a missing field or a malformed value is rejected rather than coerced.

| count | reason |
|---|---|
| 5 | `tclk: unknown field on offer: <10 bytes, sha256:3eac7195c2fe3a05f3be9eb7aefa6cfd847a118bf76ad875d96008721ce60ea0>` |
| 1 | `tclk: unknown field on offer: <82 bytes, sha256:544844a0c13c0e1e9743fce44fd0889bf37458cdb7cc1b7d585fcedcaad7d549>` |
| 1 | `tclk: unknown field on offer: <83 bytes, sha256:b33cfeb9fcbce20404a0b1e839604a29c31bc4ddc3bf78a5527db3dd52b385a4>` |
| 1 | `tclk: contract is malformed: <66 bytes, sha256:398d9d27e05e118fed36d331c4873e0cfddc311d7142b12b21dc7ab4796c2dae>` |
| 1 | `tclk: unknown frame type: <74 bytes, sha256:72910e652d4ff4a790157b5eaf064fad7d20c37cfaba6c886d2dbb5e3729d6c6>` |
| 1 | `tclk: unknown field on cancel: <3190 bytes, sha256:75e41512f4e3995382c5bc5d25717e09802edfe15e85bfb17cfb53dc40c9400b>` |

## Decoder rejections in deal rooms

| count | reason |
|---|---|
| 1 | `tclk: unknown field on lock: <3 bytes, sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae>` |

## Shape check rejections

Frames the installed decoder, `@flop-labs/tclk` 0.1.0, accepted and this tool then
refused. That decoder looks a frame's type up by its string form, so a type such as `["lock"]` passes as
a lock and skips the checks on a lock's own fields. It reads a receipt's `outcome` the same way. So each
decoded frame is checked against the JavaScript types tclk declares. A frame that fails is counted here
and applied nowhere.

| count | reason | room |
|---|---|---|
| 1 | `tclk-audit: type must be a string: <8 bytes, sha256:0ae7f2076b489147b5311577ef675e95cbbcabb2b62f1c5f4c6c5841d424d6d6>` | `tclk-offers` |
| 1 | `tclk-audit: type must be a string: <8 bytes, sha256:0ae7f2076b489147b5311577ef675e95cbbcabb2b62f1c5f4c6c5841d424d6d6>` | deal rooms |
| 1 | `tclk-audit: type must be a string: <12 bytes, sha256:cfcd158b97b1edea6a719247eab379ad35aba1d39121b9bfba8f279986aa3686>` | deal rooms |
| 1 | `tclk-audit: type must be a string: <10 bytes, sha256:83de6c23768a3f3d45062c2222faf1b857db3f7d181fe29323cb7f73300ca16a>` | deal rooms |
| 1 | `tclk-audit: receipt.outcome must be a string: <11 bytes, sha256:4091eb069c1de1430f4f0bbfce13735b84e59c21bccf31903f402a87996bd9d8>` | deal rooms |

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
