// One layout, two backends.
//
// One layout that all parts read makes a boundary one number, and not a
// translation. That is a testable claim and this is the test. The offsets that JS reads with and the offsets baked into WASM
// `memarg` immediates come from the same `struct()` call, and neither side
// is allowed to name a byte position.
//
// Experiment 03 proved this in miniature against a HAND-WRITTEN offset table.
// The first group below checks that the computed table is that same table, so
// the library and the experiment that justifies it cannot drift apart.

import { buildModule, OP, T, mem, sleb, f32Bytes } from '../src/wasm-emit.js';
import { accessorPlan, bool, f32, i32, packed, struct, u8, vec3 } from '../src/index.ts';
import type { AccessUnit } from '../src/index.ts';
import { group, report } from './harness.ts';

// ---------------------------------------------------------------------------

group("the computed table is experiment 03's hand-written table", t => {
  // From the WASM bridge experiment, verbatim:
  //   const STRIDE = 32;
  //   const L = { pos_x: 0, pos_y: 4, pos_z: 8, vel_x: 12, vel_y: 16, vel_z: 20, mass: 24, alive: 28 };
  const Particle = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle');
  const L: Record<string, number> = {
    pos_x: 0, pos_y: 4, pos_z: 8, vel_x: 12, vel_y: 16, vel_z: 20, mass: 24, alive: 28,
  };
  for (const [key, offset] of Object.entries(L)) {
    const path = key.replace('_', '.');
    t.eq(`${path} is at ${offset}, as experiment 03 assumed`, Particle.leaf(path as never).offset, offset);
  }
  t.eq('the stride is 32, as experiment 03 assumed', Particle.size, 32);
});

// ---------------------------------------------------------------------------

const Probe = struct({ tag: u8, a: i32, b: i32, flag: bool, c: f32 }, 'Probe');
const N = 4096;
const PAGES = Math.ceil((N * Probe.size) / 65536) + 1;

const off = (path: Parameters<typeof Probe.leaf>[0]) => Probe.leaf(path).offset;
const STRIDE = Probe.size;

// The whole memarg immediate comes off the plan: the byte offset and the
// alignment exponent both. Neither number is written here, which is the claim
// this file exists to check. `memAlign` is the same quantity that decides typed
// access against DataView on the JS side, so one computation answers for both
// backends and they cannot drift apart.
const PLAN = accessorPlan(Probe);
const siteOf = (path: string) => {
  const s = PLAN.sites.find(x => x.path === path);
  if (!s) throw new Error(`Probe has no accessor site "${path}"`);
  return s;
};
const memAt = (path: string) => mem(siteOf(path).memAlign, siteOf(path).offset);

/** Bytes each access unit moves. A memarg may never claim more than this. */
const UNIT_BYTES: Record<AccessUnit, number> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8,
};

const G = (l: number) => [OP.local_get, l];
const rowBase = (ptrLocal: number, iLocal: number, into: number) => [
  ...G(ptrLocal), ...G(iLocal), OP.i32_const, ...sleb(STRIDE), OP.i32_mul, OP.i32_add, OP.local_set, into,
];
/** while (i < n) { ...body...; i++ }, where i is `iLocal` and n is `nLocal`. */
const loop = (iLocal: number, nLocal: number, body: number[]) => [
  OP.block, T.void,
  OP.loop, T.void,
  ...G(iLocal), ...G(nLocal), OP.i32_ge_s, OP.br_if, 1,
  ...body,
  ...G(iLocal), OP.i32_const, 1, OP.i32_add, OP.local_set, iLocal,
  OP.br, 0,
  OP.end,
  OP.end,
];

// checksum(ptr, n) -> i32 : sum of a + 2*b, read at OUR offsets
const checksum = loop(2, 1, [
  ...rowBase(0, 2, 4),
  ...G(3),
  ...G(4), OP.i32_load, ...memAt('a'),
  OP.i32_add,
  ...G(4), OP.i32_load, ...memAt('b'), OP.i32_const, ...sleb(2), OP.i32_mul,
  OP.i32_add,
  OP.local_set, 3,
]).concat([OP.local_get, 3]);

// scale(ptr, n) : c *= 2 and flag = tag, written at OUR offsets
const scale = loop(2, 1, [
  ...rowBase(0, 2, 3),
  ...G(3),
  ...G(3), OP.f32_load, ...memAt('c'), OP.f32_const, ...f32Bytes(2), OP.f32_mul,
  OP.f32_store, ...memAt('c'),
  ...G(3),
  ...G(3), OP.i32_load8_u, ...memAt('tag'),
  OP.i32_store8, ...memAt('flag'),
]);

// accumulate(count, term) -> f32 : f32 arithmetic all the way through
const accumulate = loop(2, 0, [
  ...G(3), ...G(1), OP.f32_add, OP.local_set, 3,
]).concat([OP.local_get, 3]);

const binary = buildModule({
  types: [
    { params: [T.i32, T.i32], results: [T.i32] },
    { params: [T.i32, T.i32], results: [] },
    { params: [T.i32, T.f32], results: [T.f32] },
  ],
  imports: [{ module: 'env', name: 'mem', kind: 'memory', min: PAGES }],
  funcs: [
    { type: 0, locals: [[3, T.i32]], export: 'checksum', body: checksum },
    { type: 1, locals: [[2, T.i32]], export: 'scale', body: scale },
    { type: 2, locals: [[1, T.i32], [1, T.f32]], export: 'accumulate', body: accumulate },
  ],
});

const memory = new WebAssembly.Memory({ initial: PAGES });
// Synchronous instantiation: the module is a few hundred bytes, and it keeps
// this file free of a top-level await that three different engines have to agree on.
const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), { env: { mem: memory } });
const wasm = instance.exports as unknown as {
  checksum(ptr: number, n: number): number;
  scale(ptr: number, n: number): void;
  accumulate(count: number, term: number): number;
};

// The JS side reads the same table. No byte position is written down twice.
const view = new DataView(memory.buffer);
const PTR = 0;
const rowAt = (i: number) => PTR + i * STRIDE;

group('WASM reads what JS wrote, at offsets neither side spells out', t => {
  let expected = 0;
  for (let i = 0; i < N; i++) {
    const r = rowAt(i);
    view.setUint8(r + off('tag'), i & 0xff);
    view.setInt32(r + off('a'), i * 3 - 1000, true);
    view.setInt32(r + off('b'), -i * 7 + 5, true);
    view.setUint8(r + off('flag'), 0);
    view.setFloat32(r + off('c'), i * 0.5, true);
    expected = (expected + (i * 3 - 1000) + 2 * (-i * 7 + 5)) | 0;
  }
  t.eq('WASM sums the same integers JS wrote', wasm.checksum(PTR, N), expected);

  // A wrong stride or a wrong offset would still sum SOMETHING. Move one field
  // by four bytes and the answer must change, or the test proves nothing.
  const shifted = new DataView(memory.buffer, 0);
  const saved = shifted.getInt32(rowAt(0) + off('a'), true);
  shifted.setInt32(rowAt(0) + off('a'), saved + 12345, true);
  t.eq('...and it is reading that field, not a neighbouring one',
    wasm.checksum(PTR, N), (expected + 12345) | 0);
  shifted.setInt32(rowAt(0) + off('a'), saved, true);
});

group('JS reads what WASM wrote, including a one-byte field', t => {
  wasm.scale(PTR, N);
  let floatsOk = 0;
  let bytesOk = 0;
  for (let i = 0; i < N; i++) {
    const r = rowAt(i);
    if (view.getFloat32(r + off('c'), true) === Math.fround(i * 0.5) * 2) floatsOk++;
    if (view.getUint8(r + off('flag')) === (i & 0xff)) bytesOk++;
  }
  t.eq('every f32 WASM stored is where JS looks for it', floatsOk, N);
  t.eq('every byte WASM stored is where JS looks for it', bytesOk, N);
  t.eq('the integer fields it did not touch are untouched',
    view.getInt32(rowAt(7) + off('a'), true), 7 * 3 - 1000);
});

// ---------------------------------------------------------------------------

group('rule 5: JS has no f32 arithmetic, and Math.fround is what costs 3.04x', t => {
  const TERMS = 100_000;
  const TERM = Math.fround(0.1);

  const inWasm = wasm.accumulate(TERMS, TERM);

  // What a JS author writes. It computes in f64 and narrows once, at the end.
  let naive = 0;
  for (let i = 0; i < TERMS; i++) naive += TERM;
  const naiveF32 = Math.fround(naive);

  // What agreeing with WASM costs: a fround around every operation.
  let rounded = Math.fround(0);
  for (let i = 0; i < TERMS; i++) rounded = Math.fround(rounded + TERM);

  t.ok('f64 accumulation does NOT agree with WASM', naiveF32 !== inWasm,
    `wasm ${inWasm}, naive JS ${naiveF32}`);
  t.eq('fround around every operation agrees exactly', rounded, inWasm);

  const rel = Math.abs(naiveF32 - inWasm) / Math.abs(inWasm);
  t.ok('the disagreement is a real difference, not rounding dust', rel > 1e-6,
    `relative difference ${rel.toExponential(2)} after ${TERMS} accumulations`);
  console.log(`  · after ${TERMS} adds: wasm ${inWasm}, naive JS ${naiveF32}, ` +
    `relative difference ${rel.toExponential(2)}`);
});

group('the WASM side reads its alignment off the same table', t => {
  // The alignment a memarg may claim is a property of the access, exactly like
  // the view kind. These are the numbers that used to be written by hand above.
  t.eq('a byte access claims one byte', siteOf('tag').memAlign, 0);
  t.eq('so does a bool', siteOf('flag').memAlign, 0);
  t.eq('an i32 at a 4-aligned offset claims four', siteOf('a').memAlign, 2);
  t.eq('and so does the f32', siteOf('c').memAlign, 2);

  // The two backends decide from one number, so they cannot disagree.
  let split = 0, over = 0;
  for (const s of PLAN.sites) {
    const width = 1 << s.memAlign;
    if ((s.via === 'typed') !== (width === UNIT_BYTES[s.unit])) split++;
    if (width > UNIT_BYTES[s.unit]!) over++;
    if (s.offset % width !== 0) over++;
  }
  t.eq('a site reads through a typed array exactly when its alignment reaches the unit',
    split, 0);
  t.eq('and no site claims more alignment than its address holds', over, 0);

  // A packed row cannot claim what an unpacked one can, and the table says so
  // rather than a person saying so.
  const Packed = packed({ tag: u8, x: f32 }, 'PackedProbe');
  const loose = accessorPlan(Packed);
  t.eq('a packed f32 at an odd offset claims one byte',
    loose.sites.find(s => s.path === 'x')!.memAlign, 0);
  const promised = accessorPlan(Packed, { ptrAlign: 8 });
  t.eq('and no base alignment moves it, because the offset is odd',
    promised.sites.find(s => s.path === 'x')!.memAlign, 0);
});

report('wasm.test.ts');
