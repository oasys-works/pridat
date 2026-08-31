// The type layer, checked by the compiler.
//
// Nothing in the substrate study touches the TypeScript type-level layer. It is
// the only part with no measurement behind it, and it decides whether the
// library feels like a library or like homework. So it gets tested first, and by
// the only thing that can test it.
//
// Each `type _NN = Expect<...>` below is one assertion. They hold if and only if
// `tsc --noEmit` succeeds over this file, so this file runs tsc itself rather
// than trusting that somebody else did — PHILOSOPHY Part II §14.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  accessors, array, bool, f32, f64, i32, i64, packed, struct, u8, u16, u32, u64, vec2, vec3, vec4,
} from '../src/index.ts';
import type {
  Accessors, Getter, I64Pair, Leaf64, LeafPath, LeafView, Row, Setter,
  SiteIndices, SitePath, SiteValue, Value, View,
} from '../src/index.ts';
import { group, report, skip } from './harness.ts';

/**
 * Structural equality that `any` cannot pass.
 *
 * The invariant-position trick — `(<T>() => T extends A ? 1 : 2) extends ...` —
 * is the usual way to write this, and it is wrong here. It compares how a type
 * was BUILT as well as what it contains, so two structurally identical tuples
 * answer false if one came from a mapped type and the other was written by hand.
 * `Row<typeof Mesh>` is exactly that case and it cost an afternoon.
 *
 * Mutual assignability is structural and does not care. On its own it would let
 * `any` through, since `any` is assignable in both directions — so every `any`
 * is first rewritten to a sentinel that is assignable to nothing else. The
 * instrument is checked in both directions by _12a-_12d below.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;
type DeAny<T> =
  IsAny<T> extends true ? '<any>'
  : T extends (...a: any[]) => any ? T
  : T extends object ? { [K in keyof T]: DeAny<T[K]> }
  : T;
type Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Equals<A, B> = Both<DeAny<A>, DeAny<B>>;

/**
 * True if property K of T can be assigned to. Mutual assignability cannot see a
 * `readonly` modifier, so this uses the invariant trick, which can — and which
 * is safe here because both sides are built the same way.
 */
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Writable<T, K extends keyof T> = Identical<{ [P in K]: T[P] }, { -readonly [P in K]: T[P] }>;

type Expect<T extends true> = T;

const Particle = struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle');
const Mesh = struct({ id: u64, verts: array(vec3(f32), 3), lod: u16 }, 'Mesh');
const Grid = struct({ cells: array(array(u16, 4), 3) }, 'Grid');
const Deep = struct({ a: u8, b: struct({ c: i32, d: struct({ e: i64 }) }) }, 'Deep');
const Wide = struct({ m: array(f32, 40) }, 'Wide');
const Exact32 = struct({ m: array(f32, 32) }, 'Exact32');
const Packed = packed({ a: u8, b: u32 }, 'Packed');

// --- the row shape is inferred from the schema value, not declared -----------

type _01 = Expect<Equals<Row<typeof Particle>, {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  mass: number;
  alive: boolean;
}>>; // a struct of vectors infers as nested objects

type _02 = Expect<Equals<Row<typeof Deep>, {
  a: number; b: { c: number; d: { e: I64Pair } };
}>>; // nesting is preserved to any depth

type _03 = Expect<Equals<Row<typeof Mesh>, {
  id: I64Pair;
  verts: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }];
  lod: number;
}>>; // an inline array of structs infers as a tuple of the exact length

type _04 = Expect<Equals<Row<typeof Grid>, {
  cells: [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
}>>; // nested arrays infer as nested tuples, outermost first

type _05 = Expect<Equals<Row<typeof Packed>, { a: number; b: number }>>; // packed changes bytes, not types

// A row value is a scratch object a caller fills in, so it must be writable.
// `const F extends Fields` makes every declared field readonly and that leaks
// through the mapped type unless it is stripped; these catch the regression.
type _05a = Expect<Equals<Writable<Row<typeof Particle>, 'mass'>, true>>; // a scalar field is writable
type _05b = Expect<Equals<Writable<Row<typeof Particle>['pos'], 'x'>, true>>; // ...and so is a nested one
type _05c = Expect<Equals<Writable<{ readonly a: number }, 'a'>, false>>; // and the check can say no

// --- scalars read as what they are, and i64 is not a number ------------------

type _06 = Expect<Equals<Value<typeof f32>, number>>; // f32 reads as number
type _07 = Expect<Equals<Value<typeof f64>, number>>; // f64 reads as number
type _08 = Expect<Equals<Value<typeof i32>, number>>; // i32 reads as number
type _09 = Expect<Equals<Value<typeof bool>, boolean>>; // bool reads as boolean
type _10 = Expect<Equals<Value<typeof i64>, I64Pair>>; // rule 10: i64 is a lo/hi pair
type _11 = Expect<Equals<Value<typeof u64>, I64Pair>>; // ...and so is u64
type _12 = Expect<Equals<Equals<Value<typeof i64>, bigint>, false>>; // i64 is NOT a bigint
type _13 = Expect<Equals<Equals<Value<typeof i64>, number>, false>>; // i64 is NOT a number

// The assertions above are only worth anything if Equals can say false. These
// three check the instrument itself, in the direction the suite depends on.
type _12a = Expect<Equals<Equals<{ a: number }, { a: number; b: number }>, false>>; // a missing field is caught
type _12b = Expect<Equals<Equals<{ a: number }, { a: string }>, false>>; // a wrong field type is caught
type _12c = Expect<Equals<Equals<{ a: number }, { a: any }>, false>>; // `any` cannot pass as a match
type _12d = Expect<Equals<Equals<{ a: { b: number } }, { a: { b: any } }>, false>>; // ...at any depth

// --- the vector sugar is exactly a struct of components ----------------------

type _14 = Expect<Equals<Value<ReturnType<typeof vec2<typeof f64>>>, { x: number; y: number }>>; // vec2
type _15 = Expect<Equals<Value<ReturnType<typeof vec3<typeof u8>>>, { x: number; y: number; z: number }>>; // vec3
type _16 = Expect<Equals<Value<ReturnType<typeof vec4<typeof f32>>>,
  { x: number; y: number; z: number; w: number }>>; // vec4

// --- the tuple limit is a stated limit, not a surprise -----------------------

type _17 = Expect<Equals<Row<typeof Wide>['m'], number[]>>; // above 32 elements the length stops being tracked
type _18 = Expect<Equals<Row<typeof Exact32>['m']['length'], 32>>; // and 32 itself is still exact

// --- field paths are a closed union, so a typo is a compile error ------------

type _19 = Expect<Equals<LeafPath<typeof Particle>,
  'pos.x' | 'pos.y' | 'pos.z' | 'vel.x' | 'vel.y' | 'vel.z' | 'mass' | 'alive'>>; // every leaf, no others

type _20 = Expect<Equals<LeafPath<typeof Mesh>, 'id' | 'verts.x' | 'verts.y' | 'verts.z' | 'lod'>>;
// an inline array adds no path segment: it repeats a leaf, it does not multiply it

type _21 = Expect<Equals<LeafPath<typeof Grid>, 'cells'>>; // an array of scalars is one leaf
type _22 = Expect<Equals<LeafPath<typeof Deep>, 'a' | 'b.c' | 'b.d.e'>>; // paths follow the nesting

// --- accessor sites: the same walk, with rule 10 and array arity visible ------

type _23 = Expect<Equals<SitePath<typeof Particle>, LeafPath<typeof Particle>>>;
// with no 64-bit field, an accessor site is exactly a leaf

type _24 = Expect<Equals<SitePath<typeof Mesh>,
  'id.lo' | 'id.hi' | 'verts.x' | 'verts.y' | 'verts.z' | 'lod'>>;
// rule 10 is visible in the type: a u64 is two u32 halves and has no whole-field site

type _25 = Expect<Equals<SitePath<typeof Deep>, 'a' | 'b.c' | 'b.d.e.lo' | 'b.d.e.hi'>>;
// ...at any depth

type _26 = Expect<Equals<Leaf64<typeof Mesh>, 'id'>>; // the leaf name that stands for both halves
type _27 = Expect<Equals<Leaf64<typeof Particle>, never>>; // and nothing when there is no 64-bit field

type _28 = Expect<Equals<SiteValue<typeof Particle, 'mass'>, number>>; // a float site reads as number
type _29 = Expect<Equals<SiteValue<typeof Particle, 'alive'>, boolean>>; // a bool site reads as boolean
type _30 = Expect<Equals<SiteValue<typeof Mesh, 'id.lo'>, number>>; // a half is a plain u32, not a pair

// An accessor takes one index per enclosing inline array, and the checker knows
// how many. This is the part `LeafPath` cannot express: `verts.x` is one site
// that exists three times over.
type _31 = Expect<Equals<SiteIndices<typeof Particle, 'mass'>, []>>; // a scalar takes none
type _32 = Expect<Equals<SiteIndices<typeof Mesh, 'verts.x'>, [number]>>; // one array, one index
type _33 = Expect<Equals<SiteIndices<typeof Grid, 'cells'>, [number, number]>>; // nested arrays, two

type _34 = Expect<Equals<Parameters<Getter<typeof Mesh, 'verts.x'>>['length'], 3>>; // (view, ptr, i)
type _35 = Expect<Equals<Parameters<Setter<typeof Grid, 'cells'>>['length'], 5>>; // (view, ptr, i, j, value)
type _36 = Expect<Equals<Parameters<Setter<typeof Particle, 'alive'>>[2], boolean>>; // the value comes last
type _37 = Expect<Equals<ReturnType<Getter<typeof Particle, 'alive'>>, boolean>>;

type ParticleAcc = Accessors<typeof Particle.fields>;
type _38 = Expect<Equals<ReturnType<ReturnType<ParticleAcc['bind']>['read']>, Row<typeof Particle>>>;
// the cold-path row read returns exactly the inferred row, so §9 and step 3 meet

// --- a view is tagged with its site, so the two cannot be crossed ------------
//
// `bind()` returns a Float32Array for `pos.x` and a Uint8Array for `alive`, and
// an untagged `LeafView` said neither. Crossing them reads a byte index as a
// float index: a plausible wrong number and no error, anywhere. The tag is a
// name, which is the one kind of thing the checker can hold here — bounds are
// counting and stay with `check()`.

type _39 = Expect<Equals<Parameters<Getter<typeof Particle, 'pos.x'>>[0], View<'pos.x'>>>;
// a getter's first parameter carries the site it belongs to
type _40 = Expect<Equals<Parameters<Setter<typeof Particle, 'alive'>>[0], View<'alive'>>>;
// ...and so does a setter's
type _41 = Expect<Equals<ReturnType<ParticleAcc['bind']>['view']['pos.x'], View<'pos.x'>>>;
// bind() hands back the tag the accessor asks for, so the right pairing is the easy one

type _42 = Expect<[LeafView] extends [View<'pos.x'>] ? true : false>;
// the escape hatch: an untagged view is still assignable to every site, so
// bringing your own typed array works and no call site that compiled has to change
type _43 = Expect<[View<'alive'>] extends [View<'pos.x'>] ? false : true>;
// ...but a view tagged with a DIFFERENT site is not, which is the whole point
type _44 = Expect<[View<'pos.x'>] extends [LeafView] ? true : false>;
// and a tagged view is still a LeafView, so fits() and check() take it unchanged

// --- and the checker enforces it at the call site ----------------------------

Particle.leaf('pos.x'); // a real leaf is accepted
Mesh.leaf('verts.z'); // ...including one inside an inline array

// Everything below is checked by tsc and never run by node: a rejection that is
// supposed to happen at compile time would otherwise throw at run time, and the
// file would fail for the reason it is trying to prove.
function _compileTimeOnly(): void {
  const A = accessors(Particle);
  const M = accessors(Mesh);
  const G = accessors(Grid);
  const V: LeafView = null!;

  A.get['mass'](V, 0);                // a scalar site takes no index
  M.get['verts.x'](V, 0, 2);          // an inline array takes exactly one
  G.set['cells'](V, 0, 1, 2, 7);      // ...and a nested one takes two, then the value

  // @ts-expect-error a misspelled site has no accessor
  A.get['pos.q'];
  // @ts-expect-error an interior node is not an accessor site here either
  A.get['pos'];
  // @ts-expect-error rule 10: a 64-bit field has halves, not a whole-field accessor
  M.get['id'];
  // @ts-expect-error an inline array's accessor will not run without its index
  M.get['verts.x'](V, 0);
  // @ts-expect-error ...and a scalar's will not take one
  A.get['mass'](V, 0, 1);
  // @ts-expect-error a bool site will not store a number
  A.set['alive'](V, 0, 1);

  // --- and the view tag is enforced at the call site -------------------------

  const B = A.bind(new ArrayBuffer(Particle.size * 4));

  A.get['pos.x'](B.view['pos.x'], 0);       // the view bind() gave this site
  A.set['alive'](B.view['alive'], 0, true); // ...and the same for a setter
  A.get['pos.x'](V, 0);                     // an untagged view still goes anywhere

  // @ts-expect-error a bool site's Uint8Array is not the f32 view this site reads
  A.get['pos.x'](B.view['alive'], 0);
  // @ts-expect-error ...and the crossing is caught in the other direction too
  A.set['alive'](B.view['pos.x'], 0, true);
  // @ts-expect-error the documented false rejection: one OBJECT, two tags (see `View`)
  A.get['pos.x'](B.view['pos.y'], 0);

  // The way out of that last one, and it costs nothing at run time.
  const shared: LeafView = B.view['pos.x'];
  A.get['pos.x'](shared, 0);
  A.get['pos.y'](shared, 0);
  A.check(B.view['pos.x'], 0, 4); // a tagged view still passes the untagged guard

  // @ts-expect-error `only` is checked against the sites that exist
  accessors(Particle, { only: ['pos.q'] });
  // @ts-expect-error rule 17: a site that was not emitted has no accessor to call
  accessors(Particle, { only: ['mass'] }).get['pos.x'];

  // @ts-expect-error a misspelled path is a compile error, not a runtime one
  Particle.leaf('pos.q');
  // @ts-expect-error an interior node is not an accessor site
  Particle.leaf('pos');
  // @ts-expect-error a path from a different struct is still a compile error
  Particle.leaf('verts.x');
  // @ts-expect-error an inline array's path carries no index
  Mesh.leaf('verts[0].x');

  // --- a row literal is checked field by field -------------------------------

  const ok: Row<typeof Particle> = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 1, alive: true };
  ok.mass = 2; // a row value is a mutable scratch object
  // @ts-expect-error a boolean field will not take a number
  const wrongType: Row<typeof Particle> = { ...ok, alive: 1 };
  // @ts-expect-error a missing field is a compile error
  const missing: Row<typeof Particle> = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 1 };
  // @ts-expect-error a field the schema does not declare is a compile error
  const extra: Row<typeof Particle> = { ...ok, spin: 1 };
  // @ts-expect-error a vector needs all its components
  const partialVec: Row<typeof Particle> = { ...ok, pos: { x: 0, y: 0 } };
  // @ts-expect-error an i64 will not take a number
  const i64AsNumber: Row<typeof Mesh> = { id: 1, verts: null!, lod: 0 };

  // --- and so is a schema ----------------------------------------------------

  // @ts-expect-error a field must be a type, not a value
  struct({ a: 4 }, 'Bad');
  // @ts-expect-error an array length must be a number
  array(f32, '3');

  void [wrongType, missing, extra, partialVec, i64AsNumber];
}
void _compileTimeOnly;

// ---------------------------------------------------------------------------
// Run the checker, then count what it checked.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
const claims: string[] = [];
for (let i = 0; i < src.length; i++) {
  const line = src[i]!;
  const positive = /^type _\d+ = Expect</.test(line);
  const negative = line.trimStart().startsWith('// @ts-' + 'expect-error');
  if (!positive && !negative) continue;
  const trailing = line.match(/\/\/ (.*)$/);
  claims.push(
    negative ? line.trimStart().slice(('// @ts-' + 'expect-error ').length)
    : trailing ? trailing[1]!
    : (src[i + 1]?.match(/\/\/ (.*)$/)?.[1] ?? line.trim()),
  );
}

let out: string | null = null;
try {
  readFileSync(tsc);
} catch {
  skip('the type layer', 'typescript is not installed — every type-level claim is unmeasured');
}

if (claims.length === 0) {
  // A parser that finds nothing must fail loudly.
  throw new Error('found no type-level assertions in this file — the counter is broken, not the types');
}

try {
  readFileSync(tsc);
  execFileSync(process.execPath, [tsc, '--noEmit', '-p', root], { encoding: 'utf8' });
} catch (e) {
  const err = e as { stdout?: string; message?: string };
  out = err.stdout || err.message || 'tsc failed';
}

group('the type layer', t => {
  if (out !== null) {
    t.ok('tsc --noEmit accepts the project', false, out.trim().split('\n').slice(0, 12).join('\n         '));
    return;
  }
  for (const claim of claims) t.ok(claim, true);
});

report('types.test-d.ts');
