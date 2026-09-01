// The layout engine, checked against hand-computed byte positions and against
// invariants that the accessor generator will rely on.
//
// The hand-computed cases are the point. A machine computes the byte positions
// and a person must not. That is only worth anything if a person checked the
// machine once, on paper, for cases small enough to hold in the head.
// test/repr.test.ts then checks the same rules against rustc, cc and zig.

import {
  array, bool, explain, f32, f64, i8, i16, i32, i64, packed,
  leafAligned, leafCount, leafOffset, measure, soaColumns, str, struct, u8, u16, u32, u64, vec2, vec3, vec4,
} from '../src/index.ts';
import type { Layout, Leaf, ScalarKind } from '../src/index.ts';
import { group, report } from './harness.ts';

const KINDS: ScalarKind[] = [
  'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'bool', 'str',
];

group('scalar sizes match the C type they name', t => {
  const expect: Record<ScalarKind, [number, number]> = {
    i8: [1, 1], u8: [1, 1], i16: [2, 2], u16: [2, 2], i32: [4, 4], u32: [4, 4],
    i64: [8, 8], u64: [8, 8], f32: [4, 4], f64: [8, 8], bool: [1, 1],
    // A handle, and the same word every other reader sees.
    str: [4, 4],
  };
  const ty = { i8, u8, i16, u16, i32, u32, i64, u64, f32, f64, bool, str };
  for (const k of KINDS) {
    const m = measure(ty[k]);
    t.eq(`${k} is ${expect[k][0]} B / align ${expect[k][1]}`, [m.size, m.align], expect[k]);
  }
});

group('offsets a person can check on paper', t => {
  // Every field at its natural alignment. Struct size rounds up to struct align.
  const P = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle');
  t.eq('Particle leaf offsets', P.leaves.map(l => [l.path, l.offset]), [
    ['pos.x', 0], ['pos.y', 4], ['pos.z', 8],
    ['vel.x', 12], ['vel.y', 16], ['vel.z', 20],
    ['mass', 24], ['alive', 28],
  ]);
  t.eq('Particle stride is 32 B', P.size, 32);
  t.eq('Particle align is 4', P.align, 4);
  t.eq('Particle wastes 3 B of tail padding', P.padding, 3);

  // u8 then u32 forces three bytes of interior padding. The tail rounds to 8.
  const Ragged = struct({ a: u8, b: u32, c: u8, d: f64, e: u8 }, 'Ragged');
  t.eq('Ragged offsets', Ragged.leaves.map(l => l.offset), [0, 4, 8, 16, 24]);
  t.eq('Ragged stride is 32 B', Ragged.size, 32);
  t.eq('Ragged align is 8, from f64', Ragged.align, 8);
  t.eq('Ragged wastes 3 + 7 + 7 = 17 B', Ragged.padding, 17);

  // Widest-first costs nothing.
  const Tidy = struct({ d: f64, b: u32, a: u8, c: u8, e: u8 }, 'Tidy');
  t.eq('the same fields ordered widest-first still stride 16 B', Tidy.size, 16);
  t.eq('...and waste 1 B', Tidy.padding, 1);

  // A nested struct raises the parent's alignment to its own.
  const Nested = struct({ flag: u8, inner: struct({ big: f64, small: u8 }), tail: u8 }, 'Nested');
  t.eq('nested struct starts at its own alignment', Nested.leaf('inner.big').offset, 8);
  t.eq('nested struct carries its own tail padding', Nested.leaf('tail').offset, 24);
  t.eq('parent align comes from the nested member', Nested.align, 8);
  t.eq('parent stride is 32 B', Nested.size, 32);
});

group('a struct is a type, and it knows its own size', t => {
  // The point of merging declaration and layout: `Vec3.size` works on its own,
  // the way `size_of::<Vec3>()` does, with no separate "define" step.
  const Vec3 = struct({ x: f32, y: f32, z: f32 });
  t.eq('a struct declared on its own has a layout', [Vec3.size, Vec3.align], [12, 4]);
  t.eq('...with offsets relative to itself, like C offsetof', Vec3.offsetOf('z'), 8);

  const Particle = struct({ pos: Vec3, vel: Vec3, mass: f32 });
  t.eq('reused as a field, its offsets shift', [Particle.offsetOf('pos.z'), Particle.offsetOf('vel.z')], [8, 20]);
  t.eq('...and nesting does not disturb the struct that was nested', Vec3.offsetOf('z'), 8);
  t.eq('two of them plus an f32 stride 28 B', Particle.size, 28);

  const Tri = struct({ v: array(Vec3, 3) });
  t.eq('an array of a struct strides by that struct', Tri.leaf('v.x').dims, [{ count: 3, stride: 12 }]);
  t.eq('and is 36 B', Tri.size, 36);

  // packed() is a sibling of struct(), not a flag in an options bag.
  t.ok('struct() is not packed', struct({ a: u8, b: u32 }).packed === false);
  t.ok('packed() is', packed({ a: u8, b: u32 }).packed === true);
  t.eq('and packed() removes the padding', packed({ a: u8, b: u32 }).size, 5);

  // A name is for humans and changes no bytes.
  t.eq('a struct is anonymous unless you name it', struct({ a: u8 }).name, 'struct');
  t.eq('naming one changes nothing about it', struct({ a: u8 }, 'Tag').size, struct({ a: u8 }).size);
  t.throws('but the name reaches the error message',
    () => struct({ a: u8 }, 'Tag').leaf('nope' as never), /^Tag has no field "nope"/);
  t.throws('offsetOf rejects an unknown path', () => Vec3.offsetOf('w' as never), /has no field "w"/);
});

group('inline arrays repeat a leaf instead of multiplying it', t => {
  const M = struct({ id: u64, tag: u8, verts: array(vec3(f32), 3), lod: u16 }, 'Mesh');
  t.eq('an array of 3 vec3 contributes 3 leaves, not 9',
    M.leaves.filter(l => l.path.startsWith('verts.')).length, 3);
  t.eq('leaf paths carry no index', M.leaves.map(l => l.path),
    ['id', 'tag', 'verts.x', 'verts.y', 'verts.z', 'lod']);
  t.eq('verts starts after 3 B of padding', M.leaf('verts.x').offset, 12);
  t.eq('verts.x repeats 3 times at stride 12', M.leaf('verts.x').dims, [{ count: 3, stride: 12 }]);
  t.eq('leafCount reports the repetition', leafCount(M.leaf('verts.x')), 3);
  t.eq('element 2 of verts.y', leafOffset(M.leaf('verts.y'), 2), 12 + 4 + 2 * 12);
  t.eq('Mesh stride is 56 B', M.size, 56);

  // Nested arrays multiply into two dimensions, outermost first.
  const Grid = struct({ cells: array(array(u16, 4), 3) }, 'Grid');
  t.eq('two dimensions, outermost first', Grid.leaf('cells').dims, [
    { count: 3, stride: 8 }, { count: 4, stride: 2 },
  ]);
  t.eq('cells[2][3] is at byte 22', leafOffset(Grid.leaf('cells'), 2, 3), 2 * 8 + 3 * 2);
  t.eq('Grid stride is 24 B', Grid.size, 24);

  // An array of a padded element strides by the element's padded size.
  const Padded = struct({ items: array(struct({ a: u8, b: f32 }), 2) }, 'Padded');
  t.eq('element stride includes the element tail padding', Padded.leaf('items.a').dims, [{ count: 2, stride: 8 }]);
  t.eq('Padded stride is 16 B', Padded.size, 16);
  t.eq('Padded padding counts both elements', Padded.padding, 6);

  // A zero-length array occupies nothing and has no accessor site.
  const Zero = struct({ a: u8, none: array(f32, 0), b: u8 }, 'Zero');
  t.eq('a zero-length array contributes no leaf', Zero.leaves.map(l => l.path), ['a', 'b']);
  t.eq('...but still carries its alignment', Zero.leaf('b').offset, 4);
  t.eq('Zero stride is 8 B', Zero.size, 8);
});

group('packed is opt-in, removes every gap, and says so', t => {
  const P = packed({ a: u8, b: u32, c: u8, d: f64 }, 'Packed');
  t.eq('packed offsets are the running sum', P.leaves.map(l => l.offset), [0, 1, 5, 6]);
  t.eq('packed stride is the sum of the fields', P.size, 14);
  t.eq('packed align is 1', P.align, 1);
  t.eq('packed has no padding', P.padding, 0);
  t.eq('packed has no holes', P.holes.length, 0);
  t.ok('packed is recorded on the layout', P.packed === true);

  const U = struct({ a: u8, b: u32, c: u8, d: f64 }, 'Unpacked');
  t.eq('the same fields unpacked stride 24 B', U.size, 24);
  t.ok('unpacked is the default', U.packed === false);

  // A packed parent places an unpacked nested struct at align 1, but does not
  // repack it. That is what Rust's #[repr(packed)] does.
  const Mixed = packed({ a: u8, inner: struct({ x: u8, y: u32 }) }, 'Mixed');
  t.eq('the nested struct starts at byte 1', Mixed.leaf('inner.x').offset, 1);
  t.eq('...and keeps its own interior padding', Mixed.leaf('inner.y').offset, 5);
  t.eq('Mixed stride is 9 B', Mixed.size, 9);
  t.eq('Mixed reports the nested padding it did not remove', Mixed.padding, 3);
});

// ---------------------------------------------------------------------------
// Invariants the accessor generator will rely on
// ---------------------------------------------------------------------------

import { CORPUS } from './corpus.ts';

/** Every byte one leaf occupies, expanded through its repetitions. */
function occupancy(l: Layout): { bytes: Int32Array; overlaps: string[] } {
  const bytes = new Int32Array(l.size).fill(-1);
  const overlaps: string[] = [];
  l.leaves.forEach((leaf: Leaf, li: number) => {
    const walk = (dim: number, off: number): void => {
      if (dim === leaf.dims.length) {
        for (let b = 0; b < leaf.size; b++) {
          const at = off + b;
          if (at >= l.size) { overlaps.push(`${leaf.path} runs past the row at ${at}`); return; }
          if (bytes[at] !== -1) overlaps.push(`${leaf.path} overlaps ${l.leaves[bytes[at]!]!.path} at ${at}`);
          bytes[at] = li;
        }
        return;
      }
      const d = leaf.dims[dim]!;
      for (let i = 0; i < d.count; i++) walk(dim + 1, off + i * d.stride);
    };
    walk(0, leaf.offset);
  });
  return { bytes, overlaps };
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

group('layout invariants hold for every schema in the corpus', t => {
  for (const { name, type: L } of CORPUS) {
    const { bytes, overlaps } = occupancy(L);
    const free = [...bytes].filter(b => b === -1).length;
    const holeBytes = L.holes.reduce((n, h) => n + h.size * h.repeat, 0);

    t.eq(`${name}: padding equals the bytes no leaf claims`, L.padding, free);
    t.eq(`${name}: the holes account for exactly the padding`, holeBytes, L.padding);
    t.eq(`${name}: no leaf overlaps another or leaves the row`, overlaps, []);
    t.ok(`${name}: align is a power of two`, isPow2(L.align), `align was ${L.align}`);
    t.eq(`${name}: the stride is a whole number of alignments`, L.size % L.align, 0);
    t.ok(`${name}: leaf offsets increase strictly`,
      L.leaves.every((l, i) => i === 0 || l.offset > L.leaves[i - 1]!.offset),
      L.leaves.map(l => `${l.path}@${l.offset}`).join(' '));

    // This is what decides whether step 3 emits a typed-array read or falls
    // back to DataView, which costs 1.4-1.6x on JSC.
    t.eq(`${name}: the unaligned list is exactly the leaves that fail the test`,
      L.unaligned, L.leaves.filter(l => !leafAligned(l)).map(l => l.path));
  }
});

group('alignment is a property of a leaf, not of a struct', t => {
  // An unpacked struct holding a packed one has unaligned leaves. A packed
  // struct's u8 fields are still aligned. Neither follows from the outer flag.
  const expect: Record<string, string[]> = {
    Packed: ['b', 'd'],
    PackedNest: ['inner.y', 'z'],
    ArrayOfPacked: ['rows.b'],
  };
  for (const { name, type: L } of CORPUS) {
    t.eq(`${name}: which fields need a DataView`, L.unaligned, expect[name] ?? []);
  }
  const AoP = CORPUS.find(c => c.name === 'ArrayOfPacked')!.type;
  t.ok('an unpacked struct can still hold unaligned fields', AoP.packed === false && AoP.unaligned.length > 0);
  const P = CORPUS.find(c => c.name === 'Packed')!.type;
  t.ok('a packed struct still has aligned fields', P.packed === true && P.unaligned.length < P.leaves.length);
  t.ok('explain names them', explain(AoP).includes('rows.b'));
});

group('one table, two readings. SoA columns come from the same leaves', t => {
  const M = CORPUS.find(c => c.name === 'Mesh')!.type;
  const cols = soaColumns(M);
  t.eq('one column per accessor site', cols.length, M.leaves.length);
  t.eq('column paths match leaf paths', cols.map(c => c.path), M.leaves.map(l => l.path));
  t.eq('an array field carries its per-row count into the column', cols.find(c => c.path === 'verts.x')!.perRow, 3);
  t.eq('a plain scalar has one element per row', cols.find(c => c.path === 'id')!.perRow, 1);
});

group('the derivation is publishable', t => {
  const M = CORPUS.find(c => c.name === 'Mesh')!.type;
  const text = explain(M);
  t.ok('names the struct and its stride', text.includes('Mesh - 56 B/row'));
  t.ok('shows the padding total', text.includes('9 B padding'));
  t.ok('shows where a hole is', text.includes('-- padding --'));
  t.ok('shows array repetition', text.includes('x3/12B'));
  for (const l of M.leaves) t.ok(`lists ${l.path}`, text.includes(l.path));
});

group('a mistake stops the program and says where', t => {
  t.throws('a struct with no fields', () => struct({}, 'Empty'), /no fields/);
  t.throws('a field that is not a type',
    () => struct({ a: 4 as unknown as typeof u8 }, 'Bad'), /is not a type/);
  t.throws('a nested struct with no fields', () => struct({}), /no fields/);
  t.throws('a fractional array length', () => array(f32, 2.5), /non-negative integer/);
  t.throws('a negative array length', () => array(f32, -1), /non-negative integer/);

  const M = struct({ id: u32, verts: array(vec3(f32), 3) }, 'M');
  t.throws('an unknown field path names the ones that exist',
    () => M.leaf('nope' as never), /has no field "nope".*id, verts\.x/);
  t.throws('too few indices for a repeated leaf',
    () => leafOffset(M.leaf('verts.x')), /wrong number of indices for verts\.x: expected 1, got 0/);
  t.throws('an index past the end of an inline array',
    () => leafOffset(M.leaf('verts.x'), 3), /not in \[0, 3\)/);
  t.throws('a fractional index', () => leafOffset(M.leaf('verts.x'), 1.5), /out of range/);
});

group('a field name cannot forge a path that another field already owns', t => {
  // A leaf path is field names joined by dots, and every lookup goes through
  // one: `offsetOf`, `leaf`, and the generated `get` and `set` maps. So a dot
  // inside a name puts two fields at one key. The bytes stay right and the name
  // table does not, which is a wrong answer with no error anywhere.
  t.throws('a dot in a field name',
    () => struct({ 'a.b': f32, a: struct({ b: u32 }) }, 'Dotted'),
    /Dotted\.\"a\.b\" holds a dot/);
  t.throws('and it is refused even with nothing to collide with',
    () => struct({ 'a.b': f32 }, 'Lone'), /holds a dot/);
  t.throws('a dot inside a nested struct too',
    () => struct({ outer: struct({ 'x.y': f32 }, 'Inner') }, 'Outer'), /holds a dot/);
  t.eq('a name that is not an identifier is still fine, because no path parses it',
    struct({ 'my-field': f32 }, 'Dashed').leaves.map(l => l.path), ['my-field']);
});

report('layout.test.ts');
