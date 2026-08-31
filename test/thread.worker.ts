// The other side of `test/thread.test.ts`.
//
// It receives a description and never a row: the arena's block, two byte
// offsets, and the accessors as text. It imports no schema and builds no
// layout, which is the whole point of sending the text.
//
// Two phases, and the barrier is what separates them. Every worker writes only
// the rows in its own slice, then waits, then reads the whole live range. The
// read can only be right if every other worker finished writing, so a barrier
// that releases early shows up as workers disagreeing about the total.

import { parentPort, workerData } from 'node:worker_threads';
import { attach, attachBarrier } from '../src/index.ts';

interface Job {
  pool: Parameters<typeof attach>[0];
  barrier: Parameters<typeof attachBarrier>[0];
  id: number;
  from: number;
  to: number;
  total: number;
}

const job = workerData as Job;
const p = attach(job.pool);
const b = attachBarrier(job.barrier);

const set = p.set['mass'] as (v: unknown, ptr: number, x: number) => void;
const get = p.get['mass'] as (v: unknown, ptr: number) => number;
const v = p.view['mass'];
const rows = p.rows;

// What this worker saw before it wrote anything. The owner put a value in row
// zero before the workers started, so reading it back here is the proof that
// the block crossed the boundary rather than a copy of it.
//
// It reads `pos.x` and not `mass`, because row zero belongs to one of these
// workers and that worker overwrites `mass` below. No worker writes `pos.x`.
const readMark = p.get['pos.x'] as (v: unknown, ptr: number) => number;
const sawFromOwner = readMark(p.view['pos.x'], rows[0]!);

// Phase one: claim the slice. Nothing outside `[from, to)` is touched.
const touched: number[] = [];
for (let i = job.from; i < job.to; i++) {
  const ptr = rows[i]!;
  set(v, ptr, job.id);
  touched.push(ptr);
}

b.arrive();

// Phase two: read every live row, not only this worker's. This is the part
// that needs the barrier to have held.
let sum = 0;
for (let i = 0; i < job.total; i++) sum += get(v, rows[i]!);

parentPort!.postMessage({
  id: job.id,
  sum,
  touched,
  sawFromOwner,
  name: p.name,
  stride: p.stride,
});
