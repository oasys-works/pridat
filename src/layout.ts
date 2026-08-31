// The layout engine.
//
// One table, computed once from a schema value, read by both the JS accessor
// generator and the WASM emitter. The layout is the interface, thus a boundary
// is an integer and not a translation.
//
// The default rules are C's, which are Rust's `#[repr(C)]`. Each field goes at
// its natural alignment, a struct aligns as its widest member, and its size
// rounds up to that alignment, thus an array of rows strides correctly.
// `packed` sets each alignment to 1. It is opt-in and it costs.
//
// test/repr.test.ts compares these offsets with what rustc and cc emit.

import type { ArrayTy, Fields, Scalar, ScalarKind, StructTy, Ty, Value } from './schema.ts';

const SCALAR_SIZE: Readonly<Record<ScalarKind, number>> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4,
  i64: 8, u64: 8, f32: 4, f64: 8, bool: 1,
};

// Natural alignment equals size for each scalar on each target we admit
// (x86-64, aarch64, wasm32/64). It stays a separate table: if that changes, it
// changes here and not in ten call sites.
const SCALAR_ALIGN: Readonly<Record<ScalarKind, number>> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4,
  i64: 8, u64: 8, f32: 4, f64: 8, bool: 1,
};

export const scalarSize = (k: ScalarKind): number => SCALAR_SIZE[k];
export const scalarAlign = (k: ScalarKind): number => SCALAR_ALIGN[k];

const alignUp = (n: number, a: number): number => (n + a - 1) & ~(a - 1);

/** One repetition level from an enclosing inline array. Outermost first. */
export interface Dim {
  readonly count: number;
  /** Bytes between consecutive elements at this level. */
  readonly stride: number;
}

/**
 * A scalar accessor site: one place in the row holding one kind of number.
 *
 * An inline array adds no leaf for each element. `array(vec3(f32), 4)` named
 * `pts` gives three leaves, each with `dims: [{count: 4, stride: 12}]`. To
 * expand would cost 4096 leaves and 4096 accessors, and parse time grows with
 * source size.
 */
export interface Leaf {
  readonly path: string;
  readonly kind: ScalarKind;
  /** Absolute byte offset of element zero, from the start of the row. */
  readonly offset: number;
  /** Size of one element, not of the whole leaf. */
  readonly size: number;
  readonly align: number;
  /** Empty for a plain scalar. */
  readonly dims: readonly Dim[];
}

/** A run of bytes in the row that no leaf occupies. */
export interface Hole {
  /** Absolute byte offset of the first occurrence. */
  readonly offset: number;
  readonly size: number;
  /** Path of the field this hole follows, or null if it precedes every field. */
  readonly after: string | null;
  /** How many times this hole occurs, from enclosing inline arrays. */
  readonly repeat: number;
}

/** A node in the field tree. Every `offset` is absolute, and describes instance zero. */
export interface Node {
  readonly name: string;
  readonly path: string;
  readonly form: 'scalar' | 'array' | 'struct';
  readonly offset: number;
  /** Total bytes this field occupies, including any internal padding. */
  readonly size: number;
  readonly align: number;
  readonly kind?: ScalarKind;
  readonly length?: number;
  /** Bytes per element, for `form: 'array'`. */
  readonly stride?: number;
  /** Element layout, for `form: 'array'`. Its offset is instance zero's. */
  readonly elem?: Node;
  /** For `form: 'struct'`. */
  readonly children?: readonly Node[];
}

export interface Layout {
  readonly name: string;
  /** The stride. It includes tail padding, thus `row(i)` is at `i * size`. */
  readonly size: number;
  readonly align: number;
  readonly packed: boolean;
  /** The field tree. It is `nodes` and not `fields`, because `fields` is the declaration. */
  readonly nodes: readonly Node[];
  readonly leaves: readonly Leaf[];
  readonly holes: readonly Hole[];
  /** Bytes in the row that hold no data. Equals `size` minus the occupied bytes. */
  readonly padding: number;
  /**
   * Paths of leaves off their natural alignment. They force a DataView read,
   * which is slower.
   *
   * This is a property of a leaf, not of a struct. An unpacked struct holding a
   * packed one has unaligned leaves, and the `u8` fields of a packed struct
   * stay aligned. A per-struct decision would put a DataView under fields that
   * never needed one.
   */
  readonly unaligned: readonly string[];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Measure { size: number; align: number }

const measured = new WeakMap<object, Measure>();

/** Size and alignment of a type, before it is placed anywhere. */
export function measure(t: Ty): Measure {
  if (t.form === 'scalar') {
    const s = t as Scalar;
    return { size: SCALAR_SIZE[s.kind], align: SCALAR_ALIGN[s.kind] };
  }
  const hit = measured.get(t);
  if (hit) return hit;

  let out: Measure;
  if (t.form === 'array') {
    const a = t as ArrayTy;
    const e = measure(a.elem);
    // The size of an element already includes its tail padding. Thus the
    // element stride is the size, and the array needs no padding of its own.
    out = { size: e.size * a.length, align: e.align };
  } else {
    const s = t as StructTy;
    let cursor = 0;
    let maxAlign = 1;
    for (const name of Object.keys(s.fields)) {
      const f = measure(s.fields[name]!);
      const a = s.packed ? 1 : f.align;
      cursor = alignUp(cursor, a);
      cursor += f.size;
      if (a > maxAlign) maxAlign = a;
    }
    const align = s.packed ? 1 : maxAlign;
    out = { size: alignUp(cursor, align), align };
  }
  measured.set(t, out);
  return out;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface Collect { leaves: Leaf[]; holes: Hole[] }

function placeStruct(
  s: StructTy, path: string, base: number, repeat: number, out: Collect,
): { children: Node[]; size: number; align: number } {
  const children: Node[] = [];
  let cursor = 0;
  let maxAlign = 1;
  let prev: string | null = null;

  for (const name of Object.keys(s.fields)) {
    const t = s.fields[name]!;
    const m = measure(t);
    const a = s.packed ? 1 : m.align;
    const aligned = alignUp(cursor, a);
    if (aligned !== cursor) {
      out.holes.push({ offset: base + cursor, size: aligned - cursor, after: prev, repeat });
    }
    cursor = aligned;
    const childPath = path ? `${path}.${name}` : name;
    children.push(place(t, name, childPath, base + cursor, repeat, out));
    cursor += m.size;
    if (a > maxAlign) maxAlign = a;
    prev = childPath;
  }

  const align = s.packed ? 1 : maxAlign;
  const size = alignUp(cursor, align);
  if (size !== cursor) {
    out.holes.push({ offset: base + cursor, size: size - cursor, after: prev, repeat });
  }
  return { children, size, align };
}

function place(t: Ty, name: string, path: string, offset: number, repeat: number, out: Collect): Node {
  if (t.form === 'scalar') {
    const s = t as Scalar;
    const size = SCALAR_SIZE[s.kind];
    const align = SCALAR_ALIGN[s.kind];
    out.leaves.push({ path, kind: s.kind, offset, size, align, dims: [] });
    return { name, path, form: 'scalar', offset, size, align, kind: s.kind };
  }

  if (t.form === 'array') {
    const a = t as ArrayTy;
    const e = measure(a.elem);
    const mark = out.leaves.length;
    const holeMark = out.holes.length;
    // An inline array adds no path segment. The leaf under
    // `pts: array(vec3(f32), 4)` is `pts.x`, repeated, and not `pts[0].x`.
    const elem = place(a.elem, name, path, offset, repeat * a.length, out);
    if (a.length === 0) {
      // A zero-length field occupies nothing and has no accessor site.
      out.leaves.length = mark;
      out.holes.length = holeMark;
    } else {
      for (let i = mark; i < out.leaves.length; i++) {
        const l = out.leaves[i]!;
        out.leaves[i] = { ...l, dims: [{ count: a.length, stride: e.size }, ...l.dims] };
      }
    }
    return {
      name, path, form: 'array', offset,
      size: e.size * a.length, align: e.align,
      length: a.length, stride: e.size, elem,
    };
  }

  const s = t as StructTy;
  const { children, size, align } = placeStruct(s, path, offset, repeat, out);
  return { name, path, form: 'struct', offset, size, align, children };
}

/** True if every element of this leaf sits at its natural alignment within the row. */
export const leafAligned = (l: Leaf): boolean =>
  l.offset % l.align === 0 && l.dims.every(d => d.stride % l.align === 0);

const occupiedBytes = (leaves: readonly Leaf[]): number =>
  leaves.reduce((n, l) => n + l.size * l.dims.reduce((c, d) => c * d.count, 1), 0);

export function layoutOf(s: StructTy, name = s.name): Layout {
  const out: Collect = { leaves: [], holes: [] };
  const { children, size, align } = placeStruct(s, '', 0, 1, out);
  return {
    name,
    size,
    align,
    packed: s.packed,
    nodes: children,
    leaves: out.leaves,
    holes: out.holes,
    padding: size - occupiedBytes(out.leaves),
    unaligned: out.leaves.filter(l => !leafAligned(l)).map(l => l.path),
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The JS value shape of one row of `T`. */
export type Row<T> = Value<T>;

/** The dotted paths of every scalar accessor site in `T`. Inline arrays add no segment. */
export type LeafPath<T> = PathsOf<T>;

type PathsOf<T, Prefix extends string = ''> =
  T extends Scalar ? Prefix
  : T extends ArrayTy<infer E, any> ? PathsOf<E, Prefix>
  : T extends StructTy<infer F>
    ? { [K in keyof F & string]: PathsOf<F[K], Prefix extends '' ? K : `${Prefix}.${K}`> }[keyof F & string]
    : never;

/**
 * A struct type, and its layout.
 *
 * These are one thing and not two. A struct knows its own size, as a Rust or
 * Zig struct does: `Vec3.size` is 12 alone or as a field of something else.
 * Thus there is no separate "define" step that measures a description.
 */
export interface Struct<F extends Fields = Fields> extends Layout {
  readonly form: 'struct';
  /** The declaration, as written. */
  readonly fields: F;
  /** Byte offset of a field, from the start of this struct. C's `offsetof`. */
  offsetOf(path: PathsOf<Struct<F>>): number;
  /** The full accessor-site record. This is input for codegen, not for users. */
  leaf(path: PathsOf<Struct<F>>): Leaf;
  readonly byPath: ReadonlyMap<string, Leaf>;
}

function build<F extends Fields>(fields: F, name: string, isPacked: boolean): Struct<F> {
  const names = Object.keys(fields);
  if (names.length === 0) throw new TypeError(`${name} has no fields`);
  for (const n of names) {
    const t = fields[n] as Ty | undefined;
    if (!t || typeof t !== 'object' || !('form' in t)) {
      throw new TypeError(`${name}.${n} is not a type, got ${String(t)}`);
    }
    // A leaf path is the field names joined by dots, and every lookup parses
    // one. A dot inside a name puts two fields at one key, and the map keeps the
    // last. The bytes stay right and the name table does not.
    if (n.includes('.')) {
      throw new TypeError(
        `${name}.${JSON.stringify(n)} holds a dot, which separates one field path from the next. `
        + 'Rename the field.',
      );
    }
  }

  const layout = layoutOf({ form: 'struct', name, fields, packed: isPacked }, name);
  const byPath = new Map(layout.leaves.map(l => [l.path, l]));
  // The dot check above is per struct, and this is the invariant it exists to
  // hold. It stays because the paths are built here and the check is not.
  if (byPath.size !== layout.leaves.length) {
    const seen = new Set<string>();
    const dup = layout.leaves.find(l => seen.size === seen.add(l.path).size)!;
    throw new TypeError(`${name}: two leaves reach the path ${JSON.stringify(dup.path)}.`);
  }

  const find = (path: string): Leaf => {
    const l = byPath.get(path);
    if (!l) {
      throw new RangeError(
        `${name} has no field ${JSON.stringify(path)}. It has: ${[...byPath.keys()].join(', ')}`,
      );
    }
    return l;
  };

  const self = {
    ...layout,
    form: 'struct' as const,
    fields,
    byPath,
    leaf: find,
    offsetOf: (path: string) => find(path).offset,
  };
  // The layout is computed. Do not let a parent compute it again.
  measured.set(self, { size: layout.size, align: layout.align });
  return self as Struct<F>;
}

/**
 * Declare a struct. The name comes from the binding, as in Zig:
 *
 *   const Vec3     = struct({ x: f32, y: f32, z: f32 })
 *   const Particle = struct({ pos: Vec3, vel: Vec3, mass: f32, alive: bool })
 *
 * C's rules lay out the fields, which are Rust's `#[repr(C)]` rules. The
 * optional second argument names the struct in errors and generated code. It
 * changes no bytes.
 */
export function struct<const F extends Fields>(fields: F, name = 'struct'): Struct<F> {
  return build(fields, name, false);
}

/**
 * Declare a struct with no padding: Rust's `#[repr(packed)]`, Zig's
 * `packed struct`.
 *
 * Opt-in, never a default. It breaks byte compatibility with `#[repr(C)]`, and
 * each field it puts off its natural alignment needs a slower DataView read.
 * `.unaligned` names those fields.
 */
export function packed<const F extends Fields>(fields: F, name = 'packed struct'): Struct<F> {
  return build(fields, name, true);
}

// Component vectors. Sugar over `struct`, thus `vec3(f32)` is byte-identical
// to a Rust `#[repr(C)] struct { x: f32, y: f32, z: f32 }`.
export const vec2 = <E extends Ty>(elem: E) => struct({ x: elem, y: elem }, 'vec2');
export const vec3 = <E extends Ty>(elem: E) => struct({ x: elem, y: elem, z: elem }, 'vec3');
export const vec4 = <E extends Ty>(elem: E) => struct({ x: elem, y: elem, z: elem, w: elem }, 'vec4');

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** How many elements one leaf holds per row. 1 unless an inline array encloses it. */
export const leafCount = (l: Leaf): number => l.dims.reduce((n, d) => n * d.count, 1);

/**
 * Byte offset of one element of a leaf, in its row. `indices` starts at the
 * outermost dimension, and its length must equal `leaf.dims`.
 */
export function leafOffset(l: Leaf, ...indices: number[]): number {
  if (indices.length !== l.dims.length) {
    throw new RangeError(`wrong number of indices for ${l.path}: expected ${l.dims.length}, got ${indices.length}`);
  }
  let o = l.offset;
  for (let i = 0; i < indices.length; i++) {
    const d = l.dims[i]!;
    const n = indices[i]!;
    if (!Number.isInteger(n) || n < 0 || n >= d.count) {
      throw new RangeError(`${l.path} index ${i} out of range: ${n} not in [0, ${d.count})`);
    }
    o += n * d.stride;
  }
  return o;
}

/**
 * One column for each accessor site: the SoA reading of the same table.
 *
 * The layout declares three readings, SoA, AoS and flat index by id, and the
 * programmer selects one. Both come from one field table, thus the choice is a
 * declaration and not a rewrite. Column offsets depend on capacity and growth
 * policy, thus they belong to the arena.
 */
export interface Column {
  readonly path: string;
  readonly kind: ScalarKind;
  readonly size: number;
  readonly align: number;
  /** Elements of this column per row. >1 only under an inline array. */
  readonly perRow: number;
}

export const soaColumns = (l: Layout): Column[] =>
  l.leaves.map(leaf => ({
    path: leaf.path, kind: leaf.kind, size: leaf.size, align: leaf.align, perRow: leafCount(leaf),
  }));
