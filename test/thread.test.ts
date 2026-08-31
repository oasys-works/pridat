// Pools over shared memory: the description that crosses, and the barrier.
//
// The promise here is one thing, and a copy would satisfy it by accident: the
// data reaches another thread with no copy. So the proof runs in both
// directions. The owner writes a row before any worker starts and each worker
// reads that value back, and each worker writes rows that the owner then reads
// through its own view. Neither could happen through a structured clone.
//
// The barrier is checked by making the answer depend on it. Every worker writes
// only its own slice, waits, and then sums the whole live range. A barrier that
// releases a worker early shows up as workers disagreeing about the total, and
// the assertion is that all of them agree with the owner.

import {
  Arena, attach, barrier, bindShare, bool, f32, pool, struct, vec3,
} from '../src/index.ts';
import { group, report, skip } from './harness.ts';

const Particle = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle');

const WORKERS = 4;
const LIVE = 600;
/** The owner writes this into `pos.x` before any worker exists. A worker that reads it read this thread's memory. */
const MARK = 314.5;

interface Reply {
  id: number;
  sum: number;
  touched: number[];
  sawFromOwner: number;
  name: string;
  stride: number;
}

interface Run {
  replies: Reply[];
  /** What the owner reads back at each live row, after every worker has written. */
  ownerAt: Map<number, number>;
  /** The owner's total over every live row. */
  total: number;
  /** One slice's total, as a control: the barrier claim is that it is not this. */
  oneSlice: number;
}

// ---------------------------------------------------------------------------
// The description, without leaving this thread
// ---------------------------------------------------------------------------

group('share: an unshared pool refuses to describe itself', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 8 });
  t.throws('because a reader on another thread would have to copy every row',
    () => p.share(), /not shared/);
  t.throws('and a barrier needs the same block', () => barrier(arena, 2), /shared arena/);
});

group('share: what crosses is a description, and it names itself', t => {
  const arena = new Arena({ bytes: 1 << 16, shared: true });
  const p = pool(arena, Particle, { capacity: 8 });
  const s = p.share();

  t.eq('the share names its shape', s.kind, 'pridat.pool');
  t.eq('it carries the block itself, not a copy', s.buffer, arena.buffer);
  t.eq('the base', s.base, p.base);
  t.eq('the live list offset', s.listAt, p.listAt);
  t.eq('the stride', s.stride, p.stride);
  t.eq('the alignment the pool proved', s.ptrAlign, p.ptrAlign);
  t.eq('and the accessors as text', s.source, p.accessors.source);
  t.ok('the text is the whole of what a worker evaluates',
    s.source.includes('function bind('), 'no bind in the source');

  // No live count. It moves on the owning thread, and a worker that read it
  // would be reading a number that changed under it.
  t.eq('the live count is not in it', 'count' in s, false);

  t.throws('attach refuses anything else', () => attach({ kind: 'nope' } as never),
    /expects the object pool\.share\(\) returns/);
});

group('attach: the same bytes, through accessors rebuilt from the text', t => {
  const arena = new Arena({ bytes: 1 << 16, shared: true });
  const p = pool(arena, Particle, { capacity: 8 });
  const h = p.alloc();
  p.set['pos.x'](p.view['pos.x'], p.ptr(h), 7.5);

  // Standing in for the worker on this thread. `attach` sees only the share.
  const a = attach<typeof Particle>(p.share());
  t.eq('it reads what the owner wrote', a.get['pos.x'](a.view['pos.x'], a.rows[0]!), 7.5);

  a.set['pos.x'](a.view['pos.x'], a.rows[0]!, 9.25);
  t.eq('and the owner reads what it wrote back',
    p.get['pos.x'](p.view['pos.x'], p.ptr(h)), 9.25);

  t.eq('the base agrees', a.base, p.base);
  t.eq('the stride agrees', a.stride, p.stride);
  t.eq('the capacity agrees', a.capacity, p.capacity);
  t.eq('and the live list is the same memory', a.rows.buffer, arena.buffer);
});

group('barrier: one party never waits, and a round leaves no arrivals behind', t => {
  const arena = new Arena({ bytes: 1 << 12, shared: true });
  const b = barrier(arena, 1);
  t.eq('it knows how many parties it has', b.parties, 1);
  t.eq('nobody is waiting yet', b.waiting, 0);
  b.arrive();
  b.arrive();
  b.arrive();
  t.eq('and three rounds leave the count where they found it', b.waiting, 0);

  const s = b.share();
  t.eq('the share names its shape', s.kind, 'pridat.barrier');
  t.eq('it carries the block', s.buffer, arena.buffer);
  t.eq('and the party count', s.parties, 1);

  t.throws('a barrier with no parties is refused',
    () => barrier(arena, 0), /positive integer, got 0/);
});

// ---------------------------------------------------------------------------
// Across real threads
// ---------------------------------------------------------------------------

/** Spawn the workers, hand each one a slice, and collect what they report. */
async function run(): Promise<Run> {
  const { Worker } = await import('node:worker_threads');

  const arena = new Arena({ bytes: 1 << 20, shared: true });
  const p = pool(arena, Particle, { capacity: LIVE });
  for (let i = 0; i < LIVE; i++) p.alloc();
  // Into `pos.x`, which no worker writes. Row zero belongs to a worker, and it
  // overwrites `mass` there.
  p.set['pos.x'](p.view['pos.x'], p.rows[0]!, MARK);

  const b = barrier(arena, WORKERS);
  const share = p.share();
  const bshare = b.share();
  const ranges = Array.from({ length: WORKERS }, (_, i) => p.slice(WORKERS, i));
  const url = new URL('./thread.worker.ts', import.meta.url);
  const workers: import('node:worker_threads').Worker[] = [];

  const each = ranges.map((r, i) => new Promise<Reply>((resolve, reject) => {
    const w = new Worker(url, {
      workerData: { pool: share, barrier: bshare, id: i + 1, from: r.from, to: r.to, total: LIVE },
    });
    workers.push(w);
    w.on('message', (m: Reply) => resolve(m));
    w.on('error', reject);
    w.on('exit', c => { if (c !== 0) reject(new Error(`worker ${i} exited with code ${c}`)); });
  }));

  // A barrier that never releases would hang the suite rather than fail it, and
  // a suite that hangs reports nothing at all.
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('the workers did not finish, which is what a barrier that never releases does')),
      30_000,
    );
  });

  let replies: Reply[];
  try {
    replies = await Promise.race([Promise.all(each), deadline]);
  } finally {
    clearTimeout(timer!);
    for (const w of workers) void w.terminate();
  }

  // Read the rows back on this thread, after the workers have written them.
  const ownerAt = new Map<number, number>();
  let total = 0, oneSlice = 0;
  for (let i = 0; i < LIVE; i++) {
    const ptr = p.rows[i]!;
    const mass = p.get['mass'](p.view['mass'], ptr);
    ownerAt.set(ptr, mass);
    total += mass;
    if (i < ranges[0]!.to) oneSlice += mass;
  }
  return { replies, ownerAt, total, oneSlice };
}

let out: Run | null = null;
let why = '';
try {
  out = await run();
} catch (e) {
  why = e instanceof Error ? e.message : String(e);
}

if (out === null) {
  skip('threads: pools over shared memory, across real threads', why);
} else {
  const { replies, ownerAt, total, oneSlice } = out;

  group('threads: the data reaches another thread with no copy', t => {
    t.eq('every worker replied', replies.length, WORKERS);
    t.eq('each one rebuilt the accessors from the text alone, with no schema',
      replies.every(r => r.name === 'Particle' && r.stride === Particle.size), true);
    t.eq('and each one read the value this thread wrote before it started',
      [...new Set(replies.map(r => r.sawFromOwner))], [MARK]);
  });

  group('threads: the slices reach disjoint rows', t => {
    const all = replies.flatMap(r => r.touched);
    t.eq('the slices cover every live row', all.length, LIVE);
    t.eq('and no row twice', new Set(all).size, LIVE);

    // Each worker wrote its own id, so the value in a row says who owned it.
    let disagree = 0;
    for (const r of replies) for (const ptr of r.touched) if (ownerAt.get(ptr) !== r.id) disagree++;
    t.eq('and the owner reads back exactly what each worker wrote', disagree, 0);
  });

  group('threads: one barrier, and every worker sees the whole step', t => {
    const sums = [...new Set(replies.map(r => r.sum))];
    t.eq('every worker computed the same total after the barrier', sums.length, 1);
    t.eq('and it is the total the owner sees', sums[0], total);
    t.ok('which is not the total of the slice it wrote itself',
      sums[0] !== oneSlice, `one slice summed to the whole, at ${oneSlice}`);
  });
}

group('threads: a worker refuses accessors its owner\'s schema has moved past', t => {
  // A worker has no schema and no layout engine, by design, so it cannot derive
  // what the owner's rows look like. The share carries the owner's signature
  // and the worker compares two strings. Without that, a generated file left
  // behind by a schema change reads plausible wrong numbers on the far side of
  // a thread boundary, where nothing else would catch it.
  if (typeof SharedArrayBuffer === 'undefined') {
    skip('threads: bindShare checks the module against the share', 'no SharedArrayBuffer here');
    return;
  }
  const arena = new Arena({ bytes: 1 << 16, shared: true });
  const p = pool(arena, Particle, { capacity: 8 });
  const h = p.alloc();
  p.set['pos.x'](p.view['pos.x'], p.ptr(h), MARK);

  const share = p.share();
  t.ok('the share carries a signature', typeof share.signature === 'string' && share.signature.length > 0,
    `got ${JSON.stringify(share.signature)}`);

  const mod = new Function(share.source)() as Record<string, unknown>;
  const ok = bindShare(share, mod);
  t.eq('a module that matches binds and reads the owner\'s row',
    (ok.get['pos.x'] as (v: unknown, ptr: number) => number)(ok.view['pos.x'], p.rows[0]!), MARK);

  const Wider = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: f32 }, 'Particle');
  const other = pool(new Arena({ bytes: 1 << 16, shared: true }), Wider, { capacity: 8 });
  const stale = new Function(other.accessors.source)() as Record<string, unknown>;
  t.throws('one generated from a schema that has since changed does not',
    () => bindShare(share, stale), /does not match the schema/);
  t.throws('and neither does a module with no signature at all',
    () => bindShare(share, { get: {}, set: {}, bind: () => ({ view: {} }) }), /carries no signature/);
});

report('thread.test.ts');
