// The accessor generator, checked against an oracle that does not share its
// arithmetic — and checked for obeying the rules it claims to obey.
//
// Two halves, and the second is the one FINDINGS §36 is about. Correctness is
// cross-checked field by field against a DataView driven by `leafOffset()`,
// which is layout.ts's own checked addressing and not codegen's string-built
// expressions; a negative control perturbs one offset to prove the cross-check
// can fail. But a generator can be perfectly correct and still emit code that
// costs 5x, and no round-trip would notice — so the source text itself is
// asserted against rules 1, 3, 9 and 17: a literal `true` for endianness, a
// `base + offset` index, no `throw` on an accessor path, no wrapper, no Proxy,
// and nothing emitted for a field nobody asked for.

import {
  accessorModule, accessorPlan, accessors, accessorsFrom, accessorSource, emitAccessors,
  leafOffset, packed, planSignature, struct,
  f32, f64, i64, u8, u32, u64, vec3, array, bool,
} from '../src/index.ts';
import type { Dim, Leaf, Plan, Site, Struct } from '../src/index.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS } from './corpus.ts';
import { group, report, skip } from './harness.ts';

type Loose = Record<string, (...args: any[]) => any>;

const ROWS = 3;

/** Every index tuple a site's inline arrays admit, outermost first. */
function combos(dims: readonly Dim[]): number[][] {
  let out: number[][] = [[]];
  for (const d of dims) {
    const next: number[][] = [];
    for (const c of out) for (let i = 0; i < d.count; i++) next.push([...c, i]);
    out = next;
  }
  return out;
}

/**
 * The oracle's address for one element of one site.
 *
 * It goes through `leafOffset`, which is the layout engine's own checked
 * addressing, and adds the half-offset for a 64-bit site by subtraction rather
 * than by rebuilding it — so nothing here reproduces codegen's arithmetic.
 */
const addrOf = (leaf: Leaf, site: Site, ix: number[]): number =>
  leafOffset(leaf, ...ix) + (site.offset - leaf.offset);

function oracleGet(dv: DataView, at: number, site: Site): number | boolean {
  switch (site.unit) {
    case 'i8': return dv.getInt8(at);
    case 'u8': return site.kind === 'bool' ? dv.getUint8(at) !== 0 : dv.getUint8(at);
    case 'i16': return dv.getInt16(at, true);
    case 'u16': return dv.getUint16(at, true);
    case 'i32': return dv.getInt32(at, true);
    case 'u32': return site.signed ? dv.getInt32(at, true) : dv.getUint32(at, true);
    case 'f32': return dv.getFloat32(at, true);
    case 'f64': return dv.getFloat64(at, true);
  }
}

function oracleSet(dv: DataView, at: number, site: Site, v: number | boolean): void {
  switch (site.unit) {
    case 'i8': dv.setInt8(at, v as number); return;
    case 'u8': dv.setUint8(at, site.kind === 'bool' ? (v ? 1 : 0) : v as number); return;
    case 'i16': dv.setInt16(at, v as number, true); return;
    case 'u16': dv.setUint16(at, v as number, true); return;
    case 'i32': dv.setInt32(at, v as number, true); return;
    case 'u32': dv.setUint32(at, v as number, true); return;
    case 'f32': dv.setFloat32(at, v as number, true); return;
    case 'f64': dv.setFloat64(at, v as number, true); return;
  }
}

/** A distinctive, in-range value. Deterministic, so a failure reproduces. */
function sample(site: Site, salt: number): number | boolean {
  const n = (salt * 2654435761) >>> 0;                 // Knuth, for spread not for secrecy
  if (site.kind === 'bool') return (n & 1) === 1;
  switch (site.unit) {
    case 'i8': return (n & 0xff) - 128;
    case 'u8': return n & 0xff;
    case 'i16': return (n & 0xffff) - 32768;
    case 'u16': return n & 0xffff;
    case 'i32': return n | 0;
    // A 64-bit high half read as `i32` must be given a negative sometimes, or
    // the `|0` that makes it signed would never be exercised.
    case 'u32': return site.signed ? (n | 0) : n;
    // f32 must be a value f32 holds exactly, or a round-trip failure would be
    // rounding rather than a wrong address (rule 5's hazard, in miniature).
    case 'f32': return Math.fround((n % 100000) * 0.5 + 0.25);
    case 'f64': return (n % 1000000) * 1.5 + 0.0625;
  }
}

// ---------------------------------------------------------------------------
// Correctness: every site, every element, every row, both directions
// ---------------------------------------------------------------------------

for (const { name, type } of CORPUS) {
  group(`${name}: generated accessors agree with the layout table`, t => {
    const A = accessors(type as Struct<any>);
    const get = A.get as unknown as Loose;
    const set = A.set as unknown as Loose;
    const buf = new ArrayBuffer(type.size * ROWS);
    const bound = A.bind(buf);
    const view = bound.view as unknown as Record<string, any>;
    const dv = new DataView(buf);

    let salt = 1;

    // set through the generated accessor, read through the oracle
    for (let row = 0; row < ROWS; row++) {
      const p = row * type.size;
      for (const site of A.plan.sites) {
        const leaf = type.byPath.get(site.leaf)!;
        for (const ix of combos(site.dims)) {
          const want = sample(site, salt++);
          set[site.path]!(view[site.path], p, ...ix, want);
          t.eq(`set ${site.path}[${ix}] row ${row}`, oracleGet(dv, p + addrOf(leaf, site, ix), site), want);
        }
      }
    }

    // write through the oracle, read through the generated accessor
    for (let row = 0; row < ROWS; row++) {
      const p = row * type.size;
      for (const site of A.plan.sites) {
        const leaf = type.byPath.get(site.leaf)!;
        for (const ix of combos(site.dims)) {
          const want = sample(site, salt++);
          oracleSet(dv, p + addrOf(leaf, site, ix), site, want);
          t.eq(`get ${site.path}[${ix}] row ${row}`, get[site.path]!(view[site.path], p, ...ix), want);
        }
      }
    }

    // A whole row survives a round trip through the cold path, and lands in a
    // different row without picking up its neighbours.
    for (let row = 0; row < ROWS; row++) {
      const src = bound.read(row * type.size);
      const dst = (row + 1) % ROWS;
      bound.write(dst * type.size, src);
      t.eq(`row ${row} read -> write -> read into row ${dst}`, bound.read(dst * type.size), src);
    }
  });
}

// ---------------------------------------------------------------------------
// The negative control: the cross-check must be able to fail
// ---------------------------------------------------------------------------

group('a wrong offset does not pass the oracle', t => {
  const Particle = struct({ pos: vec3(f32), mass: f32, alive: bool }, 'Particle');
  const good = accessorPlan(Particle);
  const target = good.sites.find(s => s.path === 'mass')!;

  const bad: Plan = {
    ...good,
    sites: good.sites.map(s => s.path === 'mass' ? { ...s, offset: s.offset + 4 } : s),
  };
  const mod = new Function(emitAccessors(bad))() as any;
  const buf = new ArrayBuffer(Particle.size * 2);
  const bound = mod.bind(buf);
  const dv = new DataView(buf);

  mod.set['mass'](bound.view['mass'], 0, 7.5);
  t.eq('the perturbed accessor writes somewhere else', dv.getFloat32(target.offset, true), 0);
  t.ok('...and the oracle sees the value at the wrong address',
    dv.getFloat32(target.offset + 4, true) === 7.5);
});

// ---------------------------------------------------------------------------
// The rules the generated source has to obey
// ---------------------------------------------------------------------------

const DV_CALL = /\.(?:get|set)(?:Int8|Uint8|Int16|Uint16|Int32|Uint32|Float32|Float64)\(([^)]*)\)/g;

group('rule 1: DataView calls take a literal endianness and a base+offset index', t => {
  // Every packed schema in the corpus, plus the awkward nesting cases, so this
  // sees real DataView output and not just the aligned fast path.
  let calls = 0;
  let wideCalls = 0;
  for (const { name, type } of CORPUS) {
    const src = accessorSource(type as Struct<any>);
    for (const m of src.matchAll(DV_CALL)) {
      calls++;
      const args = m[1]!.split(',').map(s => s.trim());
      const index = args[0]!;
      // Experiment 15 located this exactly: only the BARE RESULT OF A MULTIPLY
      // is penalised (1.25x on V8), and adding anything to it — including zero
      // — recovers parity. So the property is that the index is a sum, not that
      // it has any particular shape. Every expression emitted here is a flat
      // unparenthesised sum, so splitting on `+` is enough to see the top-level
      // operator.
      t.ok(`${name}: DataView index ${JSON.stringify(index)} is a sum, not a bare multiply`,
        index.includes('+') && !/^[^+]*\*[^+]*$/.test(index),
        'rule 1 / experiment 15: a bare `i * STRIDE` index costs 1.25x on V8');
      const isWide = !/(?:get|set)U?Int8\(/.test(m[0]);
      if (isWide) {
        wideCalls++;
        t.ok(`${name}: ${m[0].slice(0, 24)}... passes literal true for littleEndian`,
          args[args.length - 1] === 'true',
          'rule 1: a variable littleEndian costs 1.33x on V8');
      }
    }
  }
  t.ok('the corpus actually produced DataView calls to check', calls > 0, `saw ${calls}`);
  t.ok('...including wide ones, which are the ones endianness applies to', wideCalls > 0, `saw ${wideCalls}`);
});

group('rule 3: nothing on an accessor path throws', t => {
  for (const { name, type } of CORPUS) {
    const src = accessorSource(type as Struct<any>);
    const throwing = src.split('\n').filter(l => l.includes('throw'));
    t.ok(`${name}: the only generated \`throw\` is in check(), which is preheader-only`,
      throwing.every(l => l.startsWith('function check(')),
      `found: ${throwing.map(l => l.slice(0, 40)).join(' | ')}`);
  }
});

group('rule 9: the emitted shape is free functions, never a wrapper or a Proxy', t => {
  const A = accessors(CORPUS[0]!.type as Struct<any>);
  t.ok('no Proxy anywhere in the output', !/\bProxy\b/.test(A.source), '~45x, experiment 10');
  t.ok('no class, so no per-item wrapper to escape', !/\bclass\b/.test(A.source), '5.04x when it escapes');
  t.ok('every accessor is a top-level function declaration',
    A.plan.sites.every(s => A.source.includes(`function ${s.getName}(v,p`)
      && A.source.includes(`function ${s.setName}(v,p`)));
  t.ok('the view is a parameter, not a captured binding',
    !/^const _\w+=mk\(/m.test(A.source.split('function bind(b){')[0]!),
    'a captured view would pin the module to one buffer, which a SAB arena cannot live with');
});

group('rule 17: nothing is emitted for a field nobody asked for', t => {
  const Particle = CORPUS[0]!.type as Struct<any>;
  const full = accessors(Particle);
  const some = accessors(Particle, { only: ['pos.x', 'mass'], row: false });

  t.eq('only the requested sites are planned', some.plan.sites.map(s => s.path), ['pos.x', 'mass']);
  t.eq('and the rest are reported, not silently dropped',
    some.plan.omitted, full.plan.sites.map(s => s.path).filter(p => p !== 'pos.x' && p !== 'mass'));
  for (const p of some.plan.omitted) {
    t.ok(`no accessor named for the omitted ${p}`, !some.source.includes(`"${p}"`));
  }
  t.ok('the partial module is smaller than the full one', some.source.length < full.source.length,
    `${some.source.length} B vs ${full.source.length} B; parse time is linear in source size`);
  t.throws('row read is refused rather than quietly wrong when row:false',
    () => some.bind(new ArrayBuffer(Particle.size)).read(0), /row: false/);
  t.throws('an unknown path names the paths that exist',
    () => accessors(Particle, { only: ['pos.q'] as any }), /has no accessor site "pos\.q"/);
});

group('the same fields produce the same source, so a code cache can hit', t => {
  const Particle = CORPUS[0]!.type as Struct<any>;
  t.eq('two identical plans emit identical text',
    accessorSource(Particle), accessorSource(Particle));
  t.eq('`only` order does not change the output',
    accessorSource(Particle, { only: ['mass', 'pos.x'] }),
    accessorSource(Particle, { only: ['pos.x', 'mass'] }));
});

// ---------------------------------------------------------------------------
// Where the DataView decision actually falls
// ---------------------------------------------------------------------------

group('typed access vs DataView is decided per SITE, by the access unit', t => {
  for (const { name, type } of CORPUS) {
    const plan = accessorPlan(type as Struct<any>);
    for (const site of plan.sites) {
      const us = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8 }[site.unit];
      const typed = plan.ptrAlign % us === 0 && site.offset % us === 0
        && site.dims.every(d => d.stride % us === 0);
      t.eq(`${name}.${site.path}: via`, site.via, typed ? 'typed' : 'dataview');
    }
  }
});

group('a 64-bit leaf needs no DataView just for being 8 bytes wide', t => {
  // `Layout.unaligned` reports the FIELD's natural alignment; codegen asks a
  // different question, about the ACCESS. An i64 is read as two u32 halves, and
  // a 4-aligned i64 is two perfectly aligned u32 reads.
  const S = struct({ head: u32, id: i64 }, 'S');
  const plan = accessorPlan(S);
  t.eq('the layout reports the field as naturally aligned here', S.unaligned, []);
  t.eq('both halves read through a typed array',
    plan.sites.filter(s => s.leaf === 'id').map(s => s.via), ['typed', 'typed']);

  const T = packed({ a: u8, id: u64 }, 'T');
  t.eq('a packed 64-bit field is unaligned as a field', T.unaligned, ['id']);
  t.eq('...and both halves fall to DataView, because offset 1 is not 4-aligned',
    accessorPlan(T).sites.filter(s => s.leaf === 'id').map(s => s.via), ['dataview', 'dataview']);
});

group('an i64 high half carries the sign; a u64 high half does not', t => {
  const S = struct({ s: i64, u: u64 }, 'S');
  const A = accessors(S);
  const B = A.bind(new ArrayBuffer(S.size));
  const set = A.set as unknown as Loose;
  const get = A.get as unknown as Loose;
  const view = B.view as unknown as Record<string, any>;

  set['s.hi']!(view['s.hi'], 0, -1);
  set['u.hi']!(view['u.hi'], 0, -1);
  t.eq('i64 hi reads back signed', get['s.hi']!(view['s.hi'], 0), -1);
  t.eq('u64 hi reads back unsigned', get['u.hi']!(view['u.hi'], 0), 0xffffffff);
  t.eq('the row agrees with the accessors', B.read(0), { s: { lo: 0, hi: -1 }, u: { lo: 0, hi: 0xffffffff } });
  t.eq('only the i64 half is emitted signed',
    A.plan.sites.filter(s => s.signed).map(s => s.path), ['s.hi']);
  t.eq('naming a 64-bit leaf in `only` takes both halves',
    accessorPlan(S, { only: ['s'] }).sites.map(s => s.path), ['s.lo', 's.hi']);
});

group('packed defaults to DataView, and a stronger ptr guarantee unlocks it', t => {
  const P = packed({ a: u32, b: u32 }, 'P');
  t.eq('align 1 promises nothing about where a row starts', P.align, 1);
  t.eq('so every wide site is a DataView', accessorPlan(P).sites.map(s => s.via), ['dataview', 'dataview']);
  t.eq('an allocator that guarantees 4 gets the typed path back',
    accessorPlan(P, { ptrAlign: 4 }).sites.map(s => s.via), ['typed', 'typed']);
  t.throws('a non-power-of-two ptrAlign is refused',
    () => accessorPlan(P, { ptrAlign: 6 }), /power of two/);
  t.eq('and the WASM side of the same decision moves with it',
    [accessorPlan(P).sites[0]!.memAlign, accessorPlan(P, { ptrAlign: 4 }).sites[0]!.memAlign],
    [0, 2]);
});

group('a pointer promise the stride cannot carry does not unlock typed access', t => {
  // `ptrAlign` is a promise about one pointer, and a walk makes many: row i is
  // at `i * size`. So the stride carries the promise forward or it does not,
  // and an odd stride carries nothing. The pool already derives its promise
  // from the stride. The generator has to reach the same answer for a caller
  // who allocates the rows itself.
  const PW = packed({ b: f64, a: u8 }, 'PackedWide');
  t.eq('the row is nine bytes, so row one starts on an odd byte', PW.size, 9);

  const plan = accessorPlan(PW, { ptrAlign: 8 });
  const b = plan.sites.find(s => s.path === 'b')!;
  t.eq('the wide site stays on DataView', b.via, 'dataview');
  t.eq('and the WASM side of the same decision claims no more', b.memAlign, 0);

  // The failure that stops. A typed f64 write at row one shifts down to byte
  // eight, which is row zero's last field, and WASM reading byte nine finds
  // nothing there.
  const A = accessors(PW, { ptrAlign: 8 });
  const B = A.bind(new ArrayBuffer(PW.size * 4));
  A.set['a'](B.view['a'], 0, 0xab);
  A.set['b'](B.view['b'], PW.size, 1.5);
  t.eq('row zero survives a write to row one', A.get['a'](B.view['a'], 0), 0xab);
  t.eq('row one reads back what was written', A.get['b'](B.view['b'], PW.size), 1.5);
  t.eq('and it sits at the byte the layout named, which is what WASM reads',
    new DataView(B.buffer as ArrayBuffer).getFloat64(PW.size + PW.offsetOf('b'), true), 1.5);
});

group('the alignment a site claims holds over the whole corpus', t => {
  // `memAlign` is what a WASM memarg may claim and what decides the view kind,
  // and the two are the same number. Checking it across every schema here, at
  // every pointer promise an allocator can make, is cheaper than trusting that
  // one derivation stays in step with the other.
  const width: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8 };
  const PROMISES = [1, 2, 4, 8];
  const kinds = new Set<string>();
  let over = 0, split = 0, unreached = 0, checked = 0;

  for (const { type } of CORPUS) {
    for (const ptrAlign of PROMISES) {
      const plan = accessorPlan(type as Struct<any>, { ptrAlign });
      for (const site of plan.sites) {
        checked++;
        kinds.add(site.via);
        const claim = 1 << site.memAlign;
        // It never claims more than the unit moves, more than the caller
        // promised, or more than the offset itself divides by.
        if (claim > width[site.unit]!) over++;
        if (claim > ptrAlign) over++;
        if (site.offset % claim !== 0) over++;
        // Row i is at `i * size`, so a claim the stride does not divide holds
        // for row zero alone.
        if (plan.size % claim !== 0) over++;
        for (const d of site.dims) if (d.stride % claim !== 0) over++;
        // Typed access and a full-width claim are one decision.
        if ((site.via === 'typed') !== (claim === width[site.unit]!)) split++;
        // And it is the LARGEST such power of two, not merely a safe one.
        const bigger = claim * 2;
        if (bigger <= width[site.unit]!
          && ptrAlign % bigger === 0
          && site.offset % bigger === 0
          && plan.size % bigger === 0
          && site.dims.every(d => d.stride % bigger === 0)) unreached++;
      }
    }
  }

  // Counted rather than guessed at, so a schema dropped from the corpus shows
  // up here instead of quietly shrinking the sweep.
  const want = PROMISES.length
    * CORPUS.reduce((n, c) => n + accessorPlan(c.type as Struct<any>).sites.length, 0);
  t.eq('the sweep reached every site of every schema at every promise', checked, want);
  t.eq('and both view kinds appear, so the pairing is not vacuous',
    [...kinds].sort(), ['dataview', 'typed']);
  t.eq('no site claims alignment its address does not hold', over, 0);
  t.eq('typed access and a full-width claim are one decision', split, 0);
  t.eq('and the claim is the largest one the address supports', unreached, 0);
});

// ---------------------------------------------------------------------------
// The hoistable guard
// ---------------------------------------------------------------------------

group('rule 2: the bounds guard is a boolean the caller hoists', t => {
  const Particle = CORPUS[0]!.type as Struct<any>;
  const A = accessors(Particle);
  const B = A.bind(new ArrayBuffer(Particle.size * 4));
  const v = (B.view as unknown as Record<string, any>)['mass'];

  t.ok('four rows fit', A.fits(v, 0, 4));
  t.ok('five do not', !A.fits(v, 0, 5));
  t.ok('nor does a negative base', !A.fits(v, -1, 1));
  t.ok('nor a negative count', !A.fits(v, 0, -1));
  t.ok('an offset start still fits what remains', A.fits(v, Particle.size, 3));
  t.ok('...but not one row more', !A.fits(v, Particle.size, 4));
  t.throws('check() raises with the numbers in it', () => A.check(v, 0, 5),
    /Particle: rows \[0, 0\+5\*32\) do not fit in a view of 128 bytes/);
  t.eq('check() is silent when it fits', A.check(v, 0, 4), undefined);
});

group('bool stores one byte and reads any non-zero as true', t => {
  const S = struct({ flag: bool, n: u8 }, 'S');
  const A = accessors(S);
  const B = A.bind(new ArrayBuffer(S.size * 2));
  const set = A.set as unknown as Loose;
  const get = A.get as unknown as Loose;
  const view = B.view as unknown as Record<string, any>;
  const u8v = new Uint8Array(B.buffer as ArrayBuffer);

  set['flag']!(view['flag'], 0, true);
  t.eq('true is stored as 1', u8v[0], 1);
  set['flag']!(view['flag'], 0, false);
  t.eq('false is stored as 0', u8v[0], 0);
  u8v[0] = 37;
  t.eq('a non-zero byte reads as true', get['flag']!(view['flag'], 0), true);
  t.eq('and so does the row', B.read(0), { flag: true, n: 0 });
});

group('sites sharing an access unit share one view object', t => {
  const A = accessors(CORPUS[0]!.type as Struct<any>);
  const B = A.bind(new ArrayBuffer(A.size));
  const view = B.view as unknown as Record<string, any>;
  t.ok('pos.x and vel.z are the same Float32Array', view['pos.x'] === view['vel.z'],
    'rule 16: one shape per call site, and one object to hoist');
  t.ok('a bool site is a Uint8Array, not the f32 one', view['alive'] !== view['pos.x']);
  t.eq('bind reports the buffer it bound', B.buffer.byteLength, A.size);
});

group('bind survives a buffer that is not a multiple of the widest element', t => {
  // An arena sized to its contents will not always be 8-byte-round, and
  // `new Float64Array(buffer)` throws on such a buffer rather than truncating.
  const S = struct({ d: f64, b: u8 }, 'S');
  const A = accessors(S);
  const B = A.bind(new ArrayBuffer(S.size + 4));
  const set = A.set as unknown as Loose;
  set['d']!((B.view as unknown as Record<string, any>)['d'], 0, 1.25);
  t.eq('the odd-sized buffer still round-trips', B.read(0), { d: 1.25, b: 0 });
});

group('an inline array indexes by element and strides correctly', t => {
  const S = struct({ m: array(array(f32, 2), 3), tail: u8 }, 'S');
  const A = accessors(S);
  const B = A.bind(new ArrayBuffer(S.size));
  const set = A.set as unknown as Loose;
  const get = A.get as unknown as Loose;
  const v = (B.view as unknown as Record<string, any>)['m'];

  t.eq('one site carries both dimensions', A.plan.sites[0]!.arity, 2);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) set['m']!(v, 0, i, j, i * 10 + j);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    t.eq(`m[${i}][${j}]`, get['m']!(v, 0, i, j), i * 10 + j);
  }
  t.eq('the row nests it the way the type says', B.read(0),
    { m: [[0, 1], [10, 11], [20, 21]], tail: 0 });
});

// ---------------------------------------------------------------------------
// Where `new Function` is forbidden
// ---------------------------------------------------------------------------

type Mod = Record<string, unknown>;

const dataUrl = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:text/javascript;base64,${btoa(bin)}`;
};

const fileUrl = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pridat-'));
  const file = join(dir, 'accessors.mjs');
  writeFileSync(file, text);
  return pathToFileURL(file).href;
};

const ModPart = struct({ pos: vec3(f32), id: u64, mass: f32, alive: bool }, 'ModPart');
const modText = accessorModule(ModPart);

// One engine here caps how long a data URL may be, and the cap sits below a
// real accessor module. So probe with the text this file actually loads, and
// fall back to a file, which is the shape a build step ships anyway. Either way
// a module loader is the witness, which is the whole claim.
const probe = await import(dataUrl(modText)).then(m => m as Mod, () => null);
const toUrl = probe === null ? fileUrl : dataUrl;
const loadModule = (text: string): Promise<Mod> => import(toUrl(text)) as Promise<Mod>;

const loaded = probe ?? await loadModule(modText);
const evalFormRefused = await loadModule(accessorSource(ModPart)).then(() => null, (e: Error) => e);

group('the build-step text is a module, so a file can hold it', t => {
  // `accessorSource` is the `new Function` body, which a file cannot hold: its
  // tail is a bare `return`. The module form is the same functions under a
  // different tail, and this is the only claim a CSP escape rests on.
  t.ok('the eval form ends in a top-level return, which is what `new Function` needs',
    /^return \{/m.test(accessorSource(ModPart)), 'no top-level return');
  // One loader here takes a top-level return in a module file and two refuse
  // it. The refusal is what makes this form necessary. Its absence on one
  // loader does not make the eval form portable, so the claim is narrow: a
  // loader that refuses names the return.
  t.ok('a loader that refuses the eval form names the return',
    evalFormRefused === null || /return/i.test(evalFormRefused.message),
    `refused with ${JSON.stringify(evalFormRefused?.message)}`);
  t.eq('and it exports what a caller binds through',
    ['bind', 'check', 'fits', 'get', 'set', 'signature'].filter(k => k in loaded).sort(),
    ['bind', 'check', 'fits', 'get', 'set', 'signature']);

  const bound = (loaded['bind'] as (b: ArrayBufferLike) => any)(new ArrayBuffer(ModPart.size * 2));
  const set = loaded['set'] as Loose;
  const get = loaded['get'] as Loose;
  set['pos.y']!(bound.view['pos.y'], ModPart.size, 2.5);
  t.eq('the loaded module reads its own writes', get['pos.y']!(bound.view['pos.y'], ModPart.size), 2.5);
  t.eq('and agrees with the accessors this process generated',
    accessors(ModPart).get['pos.y'](bound.view['pos.y'] as never, ModPart.size), 2.5);
});

group('a pre-evaluated module reaches the same surface, and a stale one stops', t => {
  const A = accessorsFrom(ModPart, loaded);
  const B = A.bind(new ArrayBuffer(ModPart.size * 2));
  A.set['mass'](B.view['mass'], ModPart.size, 4.25);
  t.eq('it reads and writes', A.get['mass'](B.view['mass'], ModPart.size), 4.25);
  t.eq('it carries the plan it was checked against', A.plan.name, 'ModPart');
  t.eq('and the eval-form source, because `share()` still sends text',
    A.source, accessorSource(ModPart));

  // The failure this stops: a generated file left behind by a schema that moved.
  const Moved = struct({ pos: vec3(f32), id: u64, mass: f64, alive: bool }, 'ModPart');
  t.throws('a module generated from a schema that has since changed',
    () => accessorsFrom(Moved, loaded), /does not match the schema/);
  t.throws('and one that is not a generated module at all',
    () => accessorsFrom(ModPart, { get: {} }), /exports get, set and bind/);

  t.ok('two plans over one schema sign the same',
    planSignature(accessorPlan(ModPart)) === planSignature(accessorPlan(ModPart)), 'unstable');
  t.ok('and a different field width signs differently',
    planSignature(accessorPlan(ModPart)) !== planSignature(accessorPlan(Moved)), 'collided');
  t.ok('as does a different selection',
    planSignature(accessorPlan(ModPart)) !== planSignature(accessorPlan(ModPart, { only: ['mass'] })),
    'collided');
});

if (evalFormRefused === null) {
  skip('a module loader refuses the eval form',
    'this loader accepts a top-level return in a module file, so the refusal is unmeasured here');
}

report('codegen.test.ts');
