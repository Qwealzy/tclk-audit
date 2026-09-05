import { randomBytes } from 'node:crypto';
import { Transport, Identity } from 'technocore-client';
import { Follower } from './dist/src/follow.js';
import { audit } from './dist/src/audit.js';
import { buildThreads } from './dist/src/threads.js';
import { publishFindings, renderFindings, createNonceSource } from './dist/src/publish.js';

const transport = new Transport();
// Ephemeral identity, generated here and discarded. No key file is read.
const identity = Identity.create();
const room = 'p-' + randomBytes(10).toString('hex');
console.log('auditor did :', identity.did);
console.log('findings room:', room, '\n');

const follower = new Follower(transport, { room: 'tclk-offers', windowFrames: 3000 });
const seeded = await follower.seedFromExport();
console.log('seeded from export:', seeded, 'frames');

// One pass over the seeded window.
const controller = new AbortController();
setTimeout(() => controller.abort(), 25000);

let passes = 0;
for await (const pass of follower.follow({ waitSeconds: 10, signal: controller.signal })) {
  passes += 1;
  const r = pass.report;
  console.log(`\npass ${passes}: +${pass.arrived.length} frames | threads ${r.threadCount} | ` +
    `ok ${r.transitionsAccepted} refused ${r.transitionsRejected} blocked ${r.transitionsBlocked}` +
    (pass.gap ? ` | GAP ${pass.gap.missing} (${pass.gap.causes.join('/')})` : ''));

  const lines = renderFindings(r, 'anomaly');
  console.log('lines to publish:', lines.length);
  for (const l of lines.slice(0, 3)) console.log('   ' + l.slice(0, 118));

  const outcomes = await publishFindings(transport, identity, r,
    { room, minSeverity: 'anomaly', maxLines: 4 }, createNonceSource());
  const tally = {};
  for (const o of outcomes) tally[o.kind] = (tally[o.kind] ?? 0) + 1;
  console.log('publish outcomes:', JSON.stringify(tally));
  break;
}

// Read the findings back and confirm they verify.
const { verifyStoredMessage } = await import('technocore-client');
const page = await transport.readRoomPage(room, { limit: 20 });
console.log('\npublished findings read back:', page.count);
let verified = 0;
for (const m of page.messages) {
  if (m.sig && m.nonce && verifyStoredMessage({ room, nonce: m.nonce, text: m.text, did: m.from, sig: m.sig })) verified++;
}
console.log('signatures that verify      :', verified, '/', page.count);
console.log('budget after run            :', JSON.stringify(transport.budget.read.state), '/', JSON.stringify(transport.budget.write.state));
