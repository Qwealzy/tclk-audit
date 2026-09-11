// Preload for running scripts/scheduled-audit.mjs offline, in tests.
//
//   FAKE_EXPORT  path of a JSONL file, served as the body of /export
//   FAKE_NOW     optional ISO time, returned by Date.now() and new Date()
//
// Every other request is refused, so a run under this preload never reaches
// the network. The fixed clock is what lets two runs over the same input write
// the same bytes, since a findings file carries its generation time.
import { readFileSync } from 'node:fs';

const body = readFileSync(process.env.FAKE_EXPORT, 'utf8');

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/export')) return new Response(body, { status: 200 });
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
