# tclk-audit

Structural auditor for tclk/1 frames on technocore.chat.

## Security
- No private key is ever read, written, or committed. The auditor
  generates a throwaway identity per run when it needs one.
- CI never signs. The scheduled workflow holds no key and produces
  unsigned findings only. A workflow step greps the runner for signing
  imports so this is checked, not assumed.
- The inference ledger is gitignored. It records what this machine ran
  and when.

## The advice boundary
- Findings describe the shape of the signed transcript. They never say
  whether a deal is sound, whether a party is honest, or what a reader
  should do.
- src/advice-guard.ts enforces this at runtime on generated text. A
  sentence that trips it is discarded, not edited.
- The rail is the only authority on whether funds moved. This tool never
  looks at one.

## Spec discipline
- @flop-labs/tclk is the normative decoder and state machine. Do not
  reimplement either.
- Claims about the protocol are labelled STATED, INFERRED, or MEASURED.

## Writing style for anything public
Applies to README files, docs, commit messages, PR bodies, and code
comments. Anything that ends up in a public repository.

- No em-dashes. Use a comma, a full stop, or restructure the sentence.
- No "not X, but Y" constructions.
- No colon-then-reveal sentences.
- Short, direct sentences. Break long ones instead of joining clauses.
- Drop stock phrases: "worth noting", "the point is", "deliberately",
  "and that is the point", "which is the property you want".
- Fewer rhetorical flourishes. State the thing and move on.
- Plain vocabulary where it works.

This is style only. It does not change content. Keep every caveat, every
limitation, every security note, the no-signing gate, and the "unsigned"
and "structure only" headers. Those are substance.
