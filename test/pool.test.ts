// The arena and the pool, against the four things they promise.
//
// Two of the four are costs: iteration does not pay for the generation check,
// and a walk holds its cost as the pool empties. A correctness suite cannot
// measure either, and a timing asserted here would be a threshold sitting on a
// measurement, which this repository has been wrong about before. So this file
// asserts the structure that makes both true and leaves the timing alone. The
// live list is dense at every dead fraction, its entries are distinct and every
// one is live, and the generated source that a walk runs carries no generation
// load at all.
//
// The other two are checkable outright. A use after free throws and names the
// slot, and the arena's alignment promise is read back off the plan the
// generator produced from it.

import {
  accessors, accessorSource, Arena, array, bool, f32, packed, pool, poolPtrAlign, struct, u8,
  vec3, MAX_POOL_CAPACITY,
} from '../src/index.ts';
import type { Handle } from '../src/index.ts';
import { group, report, skip } from './harness.ts';

const Particle = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle');

/** A fixed seed, so a failure here reproduces exactly. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Arena: it says what it reserved against what it uses
// ---------------------------------------------------------------------------

group('arena: the bump pointer', t => {
  const a = new Arena({ bytes: 1024 });
  t.eq('a fresh arena has used nothing', a.used, 0);
  t.eq('it reserved what it was asked for', a.reserved, 1024);

  const p0 = a.alloc(100, 1);
  const p1 = a.alloc(100, 1);
  t.eq('the first allocation starts at zero', p0, 0);
  t.eq('the second follows the first', p1, 100);
  t.eq('used counts both', a.used, 200);

  const r = a.report();
  t.eq('the report agrees with used', r.used, 200);
  t.eq('free is the rest of the reservation', r.free, 824);
  t.eq('nothing was skipped to align', r.padding, 0);
  t.eq('one block, so the arena never moved', r.blocks, 1);
  t.eq('and no view is stale', r.epoch, 0);
});

group('arena: the alignment promise', t => {
  const a = new Arena({ bytes: 4096 });
  a.alloc(1, 1);
  for (const align of [1, 2, 4, 8, 16, 64]) {
    const p = a.alloc(3, align);
    t.eq(`a base asked to be ${align}-aligned is`, p % align, 0);
  }
  t.ok('the skipped bytes are reported, not hidden', a.report().padding > 0,
    `padding was ${a.report().padding}`);

  t.throws('an alignment that is not a power of two is refused',
    () => a.alloc(4, 6), /positive power of two, got 6/);
  t.throws('a negative size is refused',
    () => a.alloc(-1), /non-negative integer, got -1/);
});

group('arena: reserve is the default, and it says both numbers', t => {
  const a = new Arena({ bytes: 64 });
  t.eq('the declared policy is reserve', a.growth, 'reserve');
  a.alloc(48);
  t.throws('an allocation past the reservation stops',
    () => a.alloc(32), /arena is full/);
  t.throws('and the message names the reservation', () => a.alloc(32), /64 byte reservation/);
  t.eq('a refused allocation moves nothing', a.used, 48);
});

group('arena: reset takes every byte back', t => {
  const a = new Arena({ bytes: 128 });
  a.alloc(64, 8);
  a.alloc(32, 8);
  a.reset();
  t.eq('used is zero again', a.used, 0);
  t.eq('padding is zero again', a.report().padding, 0);
  t.eq('the block is the same one', a.reserved, 128);
  t.eq('so nothing bound to it went stale', a.epoch, 0);
  t.eq('and the next allocation starts over', a.alloc(8, 8), 0);
});

group('arena: growth moves the block and detaches the old one', t => {
  const a = new Arena({ bytes: 64, growth: 'grow' });
  const p = a.alloc(64);
  const before = a.buffer;
  new Uint8Array(before)[0] = 0xab;
  new Uint8Array(before)[63] = 0xcd;

  const q = a.alloc(64);
  t.eq('the second allocation follows the first', q, p + 64);
  t.ok('the block grew to hold it', a.reserved >= 128, `reserved ${a.reserved}`);
  t.eq('the epoch moved once', a.epoch, 1);
  t.eq('and the report counts two blocks', a.report().blocks, 2);

  const after = new Uint8Array(a.buffer);
  t.eq('the first byte moved with the block', after[0], 0xab);
  t.eq('so did the last one', after[63], 0xcd);
  t.ok('the old block is detached, so a stale view cannot read a moved row',
    before.byteLength === 0, `old block still holds ${before.byteLength} bytes`);
});

group('arena: growth stops where it was told to', t => {
  const a = new Arena({ bytes: 16, growth: 'grow', max: 64 });
  a.alloc(64);
  t.eq('it grows up to the declared max', a.reserved, 64);
  t.throws('and refuses to pass it', () => a.alloc(1), /declared max of 64/);
});

group('arena: shared memory reserves', t => {
  const a = new Arena({ bytes: 256, shared: true });
  t.ok('a shared arena is backed by a SharedArrayBuffer',
    a.buffer instanceof SharedArrayBuffer, `got ${a.buffer.constructor.name}`);
  t.eq('and it reports itself as shared', a.report().shared, true);
  t.throws('a shared arena that also grows is refused, because another thread holds the block',
    () => new Arena({ bytes: 16, shared: true, growth: 'grow' }), /shared arena cannot grow/);
});

group('arena: bad reservations are refused by name', t => {
  t.throws('a fractional reservation', () => new Arena({ bytes: 2.5 }),
    /non-negative integer, got 2.5/);
  t.throws('a reservation past the WASM ceiling',
    () => new Arena({ bytes: 0x1_0000_0001 }), /must not exceed/);
  t.throws('a max below the reservation',
    () => new Arena({ bytes: 128, max: 64 }), /arena max must be/);
});

// ---------------------------------------------------------------------------
// Pool: a use after free stops and names the place
// ---------------------------------------------------------------------------

group('pool: a handle round-trips to its bytes', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 100 });

  t.eq('a fresh pool is empty', p.count, 0);
  const h = p.alloc();
  t.eq('one row is live', p.count, 1);
  t.ok('the handle is not zero, so a zeroed field reads as absent', h !== 0, `h was ${h}`);
  t.eq('it is alive', p.alive(h), true);
  t.eq('its pointer is row zero of the pool', p.ptr(h), p.base);

  const v = p.view['pos.x'];
  p.set['pos.x'](v, p.ptr(h), 1.5);
  t.eq('what was written is what is read', p.get['pos.x'](v, p.ptr(h)), 1.5);

  p.write(h, { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 6 }, mass: 7, alive: true });
  t.eq('and a whole row moves in and out', p.read(h),
    { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 6 }, mass: 7, alive: true });
});

group('pool: a use after free stops and names the slot', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 100 });

  const a = p.alloc(), b = p.alloc();
  p.free(a);

  t.eq('the freed handle is no longer alive', p.alive(a), false);
  t.eq('the other one still is', p.alive(b), true);
  t.throws('reading through it throws', () => p.ptr(a), /That row was freed/);
  t.throws('and the message names the pool and the slot', () => p.ptr(a), /^Particle: .*Slot 0/);
  t.throws('freeing it twice throws too', () => p.free(a), /That row was freed/);
  t.throws('so does reading a whole row', () => p.read(a), /That row was freed/);

  t.throws('zero is not a handle', () => p.ptr(0), /A handle is a positive integer below 2\^53/);
  t.throws('nor is a fraction', () => p.ptr(1.5), /A handle is a positive integer below 2\^53/);
  t.throws('nor is a negative number', () => p.ptr(-1), /A handle is a positive integer below 2\^53/);
  t.eq('and none of those is alive', [p.alive(0), p.alive(1.5), p.alive(-1)], [false, false, false]);

  // A slot this pool has never issued is a different fault from a stale one,
  // and the message says which.
  t.throws('a handle naming a slot the pool never issued says so',
    () => p.ptr(1 * MAX_POOL_CAPACITY + 50), /has issued 2 of 100/);
});

group('pool: what a handle proves, and what it does not', t => {
  // Kept because it refutes. A handle is a generation above a slot and carries
  // no pool identity, so two pools of one schema issue the same numbers. This
  // asserts the shape of that gap so a later encoding change has to face it,
  // and so no message claims a check that is not here.
  const arena = new Arena({ bytes: 1 << 16 });
  const a = pool(arena, Particle, { capacity: 8 });
  const b = pool(arena, Particle, { capacity: 8 });

  const ha = a.alloc();
  const hb = b.alloc();
  t.eq('two pools with one history issue one number', ha, hb);

  b.set['mass'](b.view['mass'], b.ptr(hb), 7.5);
  t.ok('the pools hold different rows', a.ptr(ha) !== b.ptr(hb), `both at ${a.ptr(ha)}`);
  t.eq('so the wrong pool answers, and answers about its own row',
    a.get['mass'](a.view['mass'], a.ptr(ha)) !== 7.5, true);
  t.eq('and it does not stop', a.alive(hb), true);

  // What the check does prove. The message says only this much.
  t.throws('a value that is not a handle at all',
    () => a.ptr(-1), /^Particle: cannot read -1\. A handle is a positive integer below 2\^53\.$/);
  t.throws('a slot this pool never issued', () => a.ptr(3 * MAX_POOL_CAPACITY + 50), /has issued 1 of 8/);
  const stale = a.alloc();
  a.free(stale);
  t.throws('and a generation this pool has moved past', () => a.ptr(stale), /That row was freed/);
});

group('pool: a recycled slot does not answer to the old handle', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 8 });

  const first = p.alloc();
  const ptr = p.ptr(first);
  p.free(first);
  const second = p.alloc();

  t.eq('the slot came back', p.ptr(second), ptr);
  t.ok('under a different handle', second !== first, `both were ${first}`);
  t.eq('the new handle is alive', p.alive(second), true);
  t.eq('the old one is not, although the bytes are the same', p.alive(first), false);
  t.throws('and it still names the failure', () => p.ptr(first), /That row was freed/);
});

group('pool: the live list is dense, and stays dense as the pool empties', t => {
  const arena = new Arena({ bytes: 1 << 20 });
  const CAP = 512;
  const p = pool(arena, Particle, { capacity: CAP });

  const live: Handle[] = [];
  for (let i = 0; i < CAP; i++) live.push(p.alloc());

  const rnd = lcg(0x9e3779b9);
  // Free in a shuffled order, so the swap-remove is exercised from the middle
  // of the list and not only from its end.
  for (let i = live.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const tmp = live[i]!; live[i] = live[j]!; live[j] = tmp;
  }

  for (const dead of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
    const want = Math.round(CAP * (1 - dead));
    while (live.length > want) p.free(live.pop()!);

    t.eq(`at ${dead * 100}% dead the count is the live count`, p.count, want);

    // Density is the claim. Every entry below `count` is a live row, they are
    // distinct, and each one is a row of this pool. That is what makes a walk
    // pay for the live rows alone, whatever fraction is dead.
    const rows = p.rows;
    const seen = new Set<number>();
    let bad = 0;
    for (let i = 0; i < p.count; i++) {
      const ptr = rows[i]!;
      if (seen.has(ptr)) bad++;
      seen.add(ptr);
      if (ptr < p.base || ptr >= p.base + CAP * p.stride) bad++;
      if ((ptr - p.base) % p.stride !== 0) bad++;
    }
    t.eq(`at ${dead * 100}% dead every entry is a distinct row of this pool`, bad, 0);

    // And the list holds exactly the handles that are still out.
    const fromHandles = new Set(live.map(h => p.ptr(h)));
    t.eq(`at ${dead * 100}% dead the list is exactly the live rows`, seen, fromHandles);
  }
});

group('pool: iteration owes nothing for the generation check', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 64 });

  // The walk runs the generated source. If a generation load were in it this is
  // where it would be, and it is not: the check lives in `ptr`, and a walk over
  // `rows` never calls `ptr`. The header comment says "generated", so the
  // comments come off before the code is read.
  const code = p.accessors.source.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
  t.ok('no generated accessor loads a generation', !/gen/i.test(code),
    `found "gen" in: ${code.split('\n').filter(l => /gen/i.test(l)).join(' | ')}`);

  const h = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h), 2.5);
  const getMass = p.get['mass'], v = p.view['mass'], rows = p.rows;
  let sum = 0;
  for (let i = 0; i < p.count; i++) sum += getMass(v, rows[i]!);
  t.eq('and a walk over the list reads the row', sum, 2.5);

  // A walk must never observe a row move. Freeing one row moves a list entry
  // and no bytes, so every other row reads back what it held.
  const many: Handle[] = [];
  for (let i = 0; i < 20; i++) {
    const g = p.alloc();
    many.push(g);
    p.set['mass'](p.view['mass'], p.ptr(g), i);
  }
  p.free(many[5]!);
  p.free(many[0]!);
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    if (i === 0 || i === 5) continue;
    if (p.get['mass'](p.view['mass'], p.ptr(many[i]!)) !== i) moved++;
  }
  t.eq('and freeing a row moves no other row', moved, 0);
});

// ---------------------------------------------------------------------------
// Pool: the alignment promise reaches the generator
// ---------------------------------------------------------------------------

group('pool: the base alignment buys typed access', t => {
  const arena = new Arena({ bytes: 1 << 16 });

  // Three schemas, and the promise reaches two of them. This is the case the
  // generator gets wrong on its own: every site of `Tagged` sits at its natural
  // alignment, and it still falls to DataView when the base promises one byte.
  const Loose = packed({ x: f32, y: f32, z: f32 }, 'Loose');
  const Tagged = struct({ tag: u8, x: f32, y: f32, z: f32 }, 'Tagged');
  const Odd = packed({ tag: u8, x: f32, y: f32, z: f32 }, 'Odd');

  const loose = pool(arena, Loose, { capacity: 16 });
  t.eq('a packed vec3 has a 12 byte stride', loose.stride, 12);
  t.eq('so the pool proves four', loose.ptrAlign, 4);
  t.eq('and every site reads through a typed array', loose.report().dataview, []);
  t.eq('although the layout alone would have said one', Loose.align, 1);

  const tagged = pool(arena, Tagged, { capacity: 16 });
  t.eq('an ordinary tagged vec3 has a 16 byte stride', tagged.stride, 16);
  t.eq('the pool proves eight', tagged.ptrAlign, 8);
  t.eq('and it keeps typed access', tagged.report().dataview, []);

  // One case no allocator reaches. Only the declaration does, by not packing.
  const odd = pool(arena, Odd, { capacity: 16 });
  t.eq('a packed tagged vec3 has a 13 byte stride', odd.stride, 13);
  t.eq('no base alignment divides it', odd.ptrAlign, 1);
  t.eq('so its floats stay on DataView, and the trade is 16 bytes against 13',
    odd.report().dataview, ['x', 'y', 'z']);

  // The rows still read back correctly through the slower path.
  const h = odd.alloc();
  odd.set['y'](odd.view['y'], odd.ptr(h), 3.5);
  t.eq('and DataView reads what it wrote', odd.get['y'](odd.view['y'], odd.ptr(h)), 3.5);
});

group('pool: an array of pool rows is an array of rows', t => {
  // The generation lives beside the pool and not inside the row. So the bytes a
  // pool hands out are the bytes `test/repr.test.ts` compares with rustc, with
  // no header word taking the first field's place and no widened stride.
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 40 });
  const hs: Handle[] = [];
  for (let i = 0; i < 40; i++) {
    const h = p.alloc();
    hs.push(h);
    p.set['mass'](p.view['mass'], p.ptr(h), i + 0.5);
    p.set['pos.x'](p.view['pos.x'], p.ptr(h), i);
  }

  const r = p.report();
  t.eq('the rows take a stride each and no more', r.bytes, 40 * Particle.size);
  t.eq('the live list follows them, four bytes a slot', r.listBytes, 40 * 4);
  t.eq('and the arena holds exactly those two regions', arena.used, r.bytes + r.listBytes);
  t.eq('the list starts where the rows end', p.listAt, p.base + r.bytes);
  t.eq('so row i sits at i strides from the base', p.ptr(hs[7]!), p.base + 7 * Particle.size);

  // Read the same bytes through an accessor set that knows nothing about pools.
  const plain = accessors(Particle, { ptrAlign: p.ptrAlign });
  const b = plain.bind(arena.buffer);
  let disagree = 0;
  for (let i = 0; i < 40; i++) {
    const at = p.base + i * Particle.size;
    if (plain.get['mass'](b.view['mass'], at) !== i + 0.5) disagree++;
    if (plain.get['pos.x'](b.view['pos.x'], at) !== i) disagree++;
  }
  t.eq('a reader that never saw the pool finds every row where the stride says',
    disagree, 0);
});

group('pool: every row holds the alignment the pool promised', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  arena.alloc(1);            // push the next base off zero, so this proves the arena
  const p = pool(arena, Particle, { capacity: 64 });

  let bad = 0;
  for (let i = 0; i < 64; i++) if ((p.base + i * p.stride) % p.ptrAlign !== 0) bad++;
  t.eq('the promise covers every row and not only the base', bad, 0);
  t.ok('and the base itself moved off zero', p.base > 0, `base was ${p.base}`);
});

// ---------------------------------------------------------------------------
// Pool: slices reach disjoint rows
// ---------------------------------------------------------------------------

group('pool: a slice per worker covers the list once', t => {
  const arena = new Arena({ bytes: 1 << 20 });
  const p = pool(arena, Particle, { capacity: 300 });
  const hs: Handle[] = [];
  for (let i = 0; i < 300; i++) hs.push(p.alloc());
  for (let i = 0; i < 300; i += 3) p.free(hs[i]!);

  for (const parts of [1, 2, 3, 4, 7, 8]) {
    const seen = new Set<number>();
    let overlap = 0, prev = 0;
    for (let w = 0; w < parts; w++) {
      const { from, to } = p.slice(parts, w);
      if (from !== prev) overlap++;
      prev = to;
      for (let i = from; i < to; i++) {
        const ptr = p.rows[i]!;
        if (seen.has(ptr)) overlap++;
        seen.add(ptr);
      }
    }
    t.eq(`${parts} slices leave no gap and no overlap`, overlap, 0);
    t.eq(`${parts} slices end at the live count`, prev, p.count);
    t.eq(`${parts} slices reach every live row`, seen.size, p.count);
  }

  t.throws('a slice count below one is refused', () => p.slice(0, 0), /positive integer, got 0/);
  t.throws('an index outside the parts is refused', () => p.slice(4, 4), /\[0, 4\), got 4/);
});

// ---------------------------------------------------------------------------
// Pool: reset, capacity, and the arena underneath
// ---------------------------------------------------------------------------

group('pool: reset forgets every row and every handle', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 32 });
  const hs: Handle[] = [];
  for (let i = 0; i < 10; i++) hs.push(p.alloc());
  p.free(hs[3]!);

  p.reset();
  t.eq('nothing is live', p.count, 0);
  t.eq('the report says so', p.report().live, 0);
  t.eq('the high-water mark stays, because a generation is what keeps a handle dead',
    p.report().issued, 10);
  t.eq('and every slot it issued is back on the free list', p.report().free, 10);

  let stillAlive = 0;
  for (const h of hs) if (p.alive(h)) stillAlive++;
  t.eq('every handle outstanding went stale', stillAlive, 0);

  const again = p.alloc();
  t.eq('a fresh handle works', p.alive(again), true);
  t.eq('and it starts at row zero', p.ptr(again), p.base);
  t.eq('the arena keeps the bytes, because the pool still owns them',
    arena.used, 32 * Particle.size + 32 * 4);

  // Two more cycles, because the generation has to keep climbing across a
  // reset. A reset that rewound it would reissue a handle it had issued before.
  const seen = new Set<Handle>([...hs, again]);
  let collision = 0, stale = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    const round: Handle[] = [];
    for (let i = 0; i < 10; i++) {
      const h = p.alloc();
      if (seen.has(h)) collision++;
      seen.add(h);
      round.push(h);
    }
    p.reset();
    for (const h of round) if (p.alive(h)) stale++;
  }
  t.eq('no handle is ever issued twice', collision, 0);
  t.eq('and no handle survives the reset that followed it', stale, 0);
});

// The one path in the pool that this suite does not reach. A slot retires when
// its generation would pass what a handle can carry, and that is 2^27 recycles
// of one slot. Running it would take longer than the whole suite.
skip('pool: a slot retires at the last generation rather than wrapping',
  'reaching it costs 2^27 recycles of a single slot');

group('pool: a full pool stops and says how full', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const p = pool(arena, Particle, { capacity: 3 });
  const a = p.alloc(), b = p.alloc();
  p.alloc();
  t.throws('the fourth allocation is refused', () => p.alloc(), /pool is full. It holds 3 rows/);

  p.free(a);
  const d = p.alloc();
  t.ok('a freed row makes room again', p.alive(d), 'the recycled handle was dead');
  t.eq('and the pool is full once more', p.count, 3);
  t.eq('b is untouched by all of it', p.alive(b), true);
});

group('pool: bad capacities are refused by name', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  t.throws('zero rows', () => pool(arena, Particle, { capacity: 0 }),
    /positive integer, got 0/);
  t.throws('a fractional capacity', () => pool(arena, Particle, { capacity: 1.5 }),
    /positive integer, got 1.5/);
  t.throws('more slots than a handle can carry',
    () => pool(arena, Particle, { capacity: MAX_POOL_CAPACITY + 1 }), /must not exceed/);
  t.throws('a schema that occupies no bytes',
    () => pool(arena, struct({ none: array(f32, 0) }, 'Empty'), { capacity: 4 }),
    /occupies no bytes/);
  t.throws('a pool larger than the arena it sits in',
    () => pool(arena, Particle, { capacity: 100_000 }), /arena is full/);
});

group('pool: a pool over an arena that grows still finds its rows', t => {
  const arena = new Arena({ bytes: 64, growth: 'grow' });
  const p = pool(arena, Particle, { capacity: 8 });
  const h = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h), 9.5);

  const epochBefore = arena.epoch;
  // A second pool that does not fit forces the block to move under the first.
  const q = pool(arena, Particle, { capacity: 64 });
  t.ok('the arena moved', arena.epoch > epochBefore, `epoch stayed at ${arena.epoch}`);

  t.eq('the first pool reads its row through a rebound view',
    p.get['mass'](p.view['mass'], p.ptr(h)), 9.5);
  t.eq('and the two pools do not overlap', q.base >= p.base + 8 * p.stride, true);

  const g = q.alloc();
  q.set['mass'](q.view['mass'], q.ptr(g), 4.25);
  t.eq('the second pool works too', q.get['mass'](q.view['mass'], q.ptr(g)), 4.25);
  t.eq('and the first one is unchanged', p.get['mass'](p.view['mass'], p.ptr(h)), 9.5);
});

group('pool: the live list survives the arena moving under it', t => {
  // The live list lives in the arena, because a worker reaches the arena and
  // nothing else. So growth detaches it along with the rows. A write to a
  // detached typed array reports nothing and reaches nobody, which is the one
  // way this pool can lose a row without an error.
  const arena = new Arena({ bytes: 64, growth: 'grow', max: 1 << 20 });
  const p = pool(arena, Particle, { capacity: 8 });

  const h0 = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h0), 1.5);

  arena.alloc(1 << 12, 4);
  t.ok('the arena moved', arena.epoch > 0, `epoch stayed at ${arena.epoch}`);

  const h1 = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h1), 2.5);
  t.eq('alloc after the move counts the row', p.count, 2);
  t.eq('and puts it in the list at the pointer its handle names',
    Array.from(p.rows.slice(0, p.count)), [p.ptr(h0), p.ptr(h1)]);

  // The invariant `slice` rests on: two workers given disjoint ranges reach
  // disjoint rows.
  t.eq('the entries below count are distinct',
    new Set(p.rows.slice(0, p.count)).size, p.count);

  const walked = Array.from(p.rows.slice(0, p.count), r => p.get['mass'](p.view['mass'], r));
  t.eq('so a walk over the list sees each row once', walked.sort(), [1.5, 2.5]);

  const h2 = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h2), 3.5);
  p.free(h0);
  t.eq('free after the move drops one row', p.count, 2);
  t.eq('and swaps the last entry into the hole rather than reading a detached one',
    Array.from(p.rows.slice(0, p.count)).sort((x, y) => x - y),
    [p.ptr(h1), p.ptr(h2)].sort((x, y) => x - y));
  t.eq('the survivors still read back their own values',
    Array.from(p.rows.slice(0, p.count), r => p.get['mass'](p.view['mass'], r)).sort(),
    [2.5, 3.5]);

  // `#at` maps a live slot to its place in the list. A free that read a
  // detached list wrote that map at NaN, and the next free swaps the wrong
  // entry.
  p.free(h1);
  t.eq('and a second free still leaves the list dense',
    Array.from(p.rows.slice(0, p.count)), [p.ptr(h2)]);
  t.eq('with the last row intact', p.get['mass'](p.view['mass'], p.ptr(h2)), 3.5);
});

group('pool: a host that forbids eval can bring its own accessors', t => {
  // The build step and the pool have to agree on the pointer alignment, or the
  // generated module makes a typed access decision the pool's rows do not hold.
  // `poolPtrAlign` is that number without a pool to ask.
  const arena = new Arena({ bytes: 1 << 16 });
  const probe = pool(arena, Particle, { capacity: 4 });
  t.eq('the alignment a pool will prove is a function of the schema alone',
    poolPtrAlign(Particle), probe.ptrAlign);

  // Stand in for the build step's output. A real host imports a file that
  // `accessorModule` wrote, and `test/codegen.test.ts` is where that text is
  // put through a module loader. What the pool sees either way is the exports,
  // so this evaluates the form that needs no loader.
  const mod = new Function(
    accessorSource(Particle, { ptrAlign: poolPtrAlign(Particle) }),
  )() as Record<string, unknown>;

  const p = pool(arena, Particle, { capacity: 16, module: mod });
  const h = p.alloc();
  p.set['mass'](p.view['mass'], p.ptr(h), 6.5);
  t.eq('a pool built on a supplied module reads and writes',
    p.get['mass'](p.view['mass'], p.ptr(h)), 6.5);
  t.eq('and it made the same decisions the pool would have', p.ptrAlign, probe.ptrAlign);
  t.eq('the whole-row path works too', p.read(h).mass, 6.5);

  // The failure this stops: a generated file the schema has moved past.
  const Moved = struct({ pos: vec3(f32), vel: vec3(f32), mass: bool, alive: bool }, 'Particle');
  t.throws('a module from a schema that has since changed',
    () => pool(arena, Moved, { capacity: 4, module: mod }), /does not match the schema/);
});

group('pool: a shared arena carries a pool to another thread', t => {
  const arena = new Arena({ bytes: 1 << 16, shared: true });
  const p = pool(arena, Particle, { capacity: 64 });
  const h = p.alloc();
  p.set['pos.x'](p.view['pos.x'], p.ptr(h), 12.5);

  // What a worker is sent: the block, the base, the stride, the live list and
  // the source text. Nothing here copies a row.
  t.ok('the block is shared', arena.buffer instanceof SharedArrayBuffer, 'not shared');
  t.ok('the accessors travel as text, so a worker needs no schema and no library',
    p.accessors.source.length > 0, 'no source');

  // Stand in for the worker on this thread: rebuild the accessors from the text
  // alone, bind them to the same block, and read the row the other side wrote.
  const mod = new Function(p.accessors.source)() as {
    get: Record<string, (v: unknown, ptr: number) => number>;
    bind: (b: ArrayBufferLike) => { view: Record<string, unknown> };
  };
  const bound = mod.bind(arena.buffer);
  t.eq('and the row reaches the other side with no copy',
    mod.get['pos.x']!(bound.view['pos.x'], p.rows[0]!), 12.5);
});

group('pool: the invariants hold under a shuffled run of allocs and frees', t => {
  // The hand-written cases above each aim at one rule. This aims at the
  // interaction: a free list feeding a bump pointer, a swap-remove moving list
  // entries under both, and a reset in the middle of it. The seed is fixed, so
  // a failure here reproduces exactly.
  const arena = new Arena({ bytes: 1 << 18 });
  const CAP = 200;
  const p = pool(arena, Particle, { capacity: CAP });
  const rnd = lcg(0xdecafbad);

  const live = new Map<Handle, number>();   // handle -> the value written to it
  const dead: Handle[] = [];
  let broken = 0, missed = 0, leaked = 0, wrong = 0;

  const check = (): void => {
    if (p.count !== live.size) broken++;
    const seen = new Set<number>();
    for (let i = 0; i < p.count; i++) {
      const ptr = p.rows[i]!;
      if (seen.has(ptr)) broken++;
      if (ptr < p.base || (ptr - p.base) % p.stride !== 0) broken++;
      if ((ptr - p.base) / p.stride >= CAP) broken++;
      seen.add(ptr);
    }
    for (const [h, want] of live) {
      if (!p.alive(h)) missed++;
      else {
        if (!seen.has(p.ptr(h))) missed++;
        if (p.get['mass'](p.view['mass'], p.ptr(h)) !== want) wrong++;
      }
    }
    // A handle this pool freed must never answer again, however many rows have
    // taken its slot since.
    for (const h of dead) if (p.alive(h)) leaked++;
  };

  for (let step = 0; step < 3000; step++) {
    const r = rnd();
    if (r < 0.02 && step > 100) {
      p.reset();
      for (const h of live.keys()) dead.push(h);
      live.clear();
    } else if (r < 0.55 && live.size < CAP) {
      const h = p.alloc();
      const val = step + 0.25;
      p.set['mass'](p.view['mass'], p.ptr(h), val);
      live.set(h, val);
    } else if (live.size > 0) {
      // Free a handle picked from the middle, not the end, so the swap-remove
      // has something to move.
      const keys = [...live.keys()];
      const h = keys[(rnd() * keys.length) | 0]!;
      p.free(h);
      live.delete(h);
      dead.push(h);
    }
    if (step % 37 === 0) check();
  }
  check();

  t.eq('the live list stays dense and distinct throughout', broken, 0);
  t.eq('every live handle is reachable throughout', missed, 0);
  t.eq('and reads back the value written to it', wrong, 0);
  t.eq('no freed handle ever answers again', leaked, 0);
  t.ok('the run did enough to matter', dead.length > 500, `only ${dead.length} frees`);
});

report('pool.test.ts');
