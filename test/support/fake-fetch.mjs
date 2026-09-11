// Preload for running scripts/scheduled-audit.mjs offline, in tests.
//
//   FAKE_EXPORT  path of a JSONL file, served as the /export of TCLK_ROOM
//                (tclk-offers when unset)
//   FAKE_ROOMS   optional path of a JSON object that maps other room names to
//                JSONL files, served as those rooms' /export
//   FAKE_NOW     optional ISO time, returned by Date.now() and new Date()
//
// Any other room exports as empty. STATED [EXPORT]: "a missing room exports as
// empty". Every request that is not an /export is refused, so a run under this
// preload never reaches the network. The fixed clock is what lets two runs over
// the same input write the same bytes, since a findings file carries its
// generation time.
import { readFileSync } from 'node:fs';

const bodies = new Map();
bodies.set(process.env.TCLK_ROOM ?? 'tclk-offers', readFileSync(process.env.FAKE_EXPORT, 'utf8'));
if (process.env.FAKE_ROOMS !== undefined) {
  const files = JSON.parse(readFileSync(process.env.FAKE_ROOMS, 'utf8'));
  for (const [room, path] of Object.entries(files)) bodies.set(room, readFileSync(path, 'utf8'));
}

globalThis.fetch = async (url) => {
  // /r/<room>/export splits into '', 'r', <room>, 'export'.
  const parts = new URL(String(url)).pathname.split('/');
  if (parts.length === 4 && parts[1] === 'r' && parts[3] === 'export') {
    return new Response(bodies.get(parts[2]) ?? '', { status: 200 });
  }
  throw new Error('fake-fetch refused a request to ' + url);
};

if (process.env.FAKE_NOW !== undefined) {
  const fixed = Date.parse(process.env.FAKE_NOW);
  if (!Number.isFinite(fixed)) throw new Error('FAKE_NOW does not parse: ' + process.env.FAKE_NOW);
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() {
      return fixed;
    }
  };
}
