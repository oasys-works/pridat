// The other side of `test/strings.test.ts`.
//
// It receives a description and never a byte: the arena's block and three byte
// offsets. If it can read the text the owner interned, the block crossed the
// boundary rather than a copy of it.
//
// It also interns after the message was sent, on the owner's side, and this
// worker still resolves the handle. That is what the shared count buys, and a
// snapshot in the message would fail it.

import { parentPort, workerData } from 'node:worker_threads';
import { attachStrings } from '../src/index.ts';
import type { StringsShare } from '../src/index.ts';

interface Job {
  strings: StringsShare;
  /** Handles the owner interned before this worker started. */
  before: number[];
}

const job = workerData as Job;
const text = attachStrings(job.strings);

let internThrew = false;
try {
  text.intern('a worker must not reach the index');
} catch {
  internThrew = true;
}

// The owner interns once more and then sends the handle. Waiting for it is what
// makes the check meaningful. This handle did not exist when the table was
// described, so resolving it proves the count is read from the block.
parentPort!.once('message', (m: { after: number }) => {
  parentPort!.postMessage({
    before: job.before.map(h => text.get(h)),
    after: text.get(m.after),
    // Read one handle twice. The second read comes from this thread's own
    // cache, and it must agree with the first.
    twice: text.get(job.before[0]!) === text.get(job.before[0]!),
    bytes: Array.from(text.utf8(job.before[0]!)),
    count: text.count,
    writer: text.writer,
    internThrew,
  });
});
