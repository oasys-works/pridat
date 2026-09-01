// The type vocabulary: scalars and inline arrays.
//
// `struct()` is in layout.ts, because a struct knows its own size, as in Rust
// or Zig, thus constructing one runs the layout engine. This file holds no byte
// counts. Sizes and alignments stay in layout.ts alone, because a machine
// computes byte positions and a person does not. Two sources of truth for a
// field width is the failure this prevents.
//
// A schema is a runtime value, because the layout engine needs field names,
// widths and offsets at run time. Thus TypeScript infers the type from the
// value, never the opposite.

export type ScalarKind =
  | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32'
  | 'i64' | 'u64' | 'f32' | 'f64' | 'bool' | 'str';

/**
 * A 64-bit integer, as a pair of 32-bit halves.
 *
 * An i64 is a lo/hi u32 pair and never a BigInt. The pair measures faster and
 * puts no object on the heap. f64 is not a substitute: it loses data above
 * 2^53 and gives no error.
 */
export interface I64Pair { lo: number; hi: number }

/**
 * The phantom tag that marks a `u32` as a string handle. It exists only in the
 * type: an ambient `declare const` emits nothing, and no handle carries it at
 * run time.
 */
declare const STR: unique symbol;

/**
 * A string handle: an index into a `Strings` table. It is a `u32` and nothing
 * else, and it is not a row handle.
 *
 * A string field holds this, never the text. Equality is the handle compare,
 * because the table interns. Two rows holding the same text hold the same
 * number. `Strings.get` turns one into a JS string, and that is the step that
 * costs.
 *
 * Zero is the empty string, so a zeroed row reads as empty rather than as a
 * handle nobody issued.
 *
 * The tag is optional, as the accessor `View` tag is. A plain number stays
 * assignable, thus a handle you carried through your own `u32` still works. The
 * cost is that the checker will not stop you handing a row handle to
 * `Strings.get`. The bytes cannot lie either way, because both are one word.
 */
export type Str = number & { readonly [STR]?: never };

/** What each scalar reads as in JS. */
export interface ValueOfKind {
  i8: number; u8: number;
  i16: number; u16: number;
  i32: number; u32: number;
  f32: number; f64: number;
  bool: boolean;
  i64: I64Pair; u64: I64Pair;
  str: Str;
}

export interface Scalar<K extends ScalarKind = ScalarKind> {
  readonly form: 'scalar';
  readonly kind: K;
}

export interface ArrayTy<E extends Ty = Ty, N extends number = number> {
  readonly form: 'array';
  readonly elem: E;
  readonly length: N;
}

/**
 * The shape of a struct type. `Struct` in layout.ts is this plus its layout.
 * This interface lets the vocabulary describe a struct without the engine that
 * measures one.
 */
export interface StructTy<F extends Fields = Fields> {
  readonly form: 'struct';
  readonly name: string;
  readonly fields: F;
  /**
   * Opt-in, never a default. Packed costs nothing on the alignment axis at any
   * stride, but it forces DataView, which is slower on some engines, and it
   * breaks byte compatibility with Rust `#[repr(C)]`.
   */
  readonly packed: boolean;
}

export type Ty = Scalar<ScalarKind> | ArrayTy<any, number> | StructTy<any>;

export type Fields = { readonly [name: string]: Ty };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const scalar = <K extends ScalarKind>(kind: K): Scalar<K> => ({ form: 'scalar', kind });

export const i8 = scalar('i8');
export const u8 = scalar('u8');
export const i16 = scalar('i16');
export const u16 = scalar('u16');
export const i32 = scalar('i32');
export const u32 = scalar('u32');
export const i64 = scalar('i64');
export const u64 = scalar('u64');
export const f32 = scalar('f32');
export const f64 = scalar('f64');
export const bool = scalar('bool');

/**
 * A string field: four bytes holding a handle into a `Strings` table.
 *
 * It is a scalar because it occupies one fixed position of one fixed width, as
 * `bool` does. What differs is where the meaning lives. A `bool` carries its
 * own, and a `str` names a row of a table you built.
 *
 * Thus the row stays exact and stays byte-compatible: Rust, C and Zig see a
 * `u32`. Two sides of a boundary agree about the handle. They agree about the
 * text only when both read the same table, which is bytes in the arena, not a
 * translation.
 *
 * The accessor returns the handle and never the text. Materializing costs a
 * table lookup and sometimes a decode. A decode is far more expensive than
 * holding a reference, so keep it off the hot path.
 */
export const str = scalar('str');

/** A fixed-length inline array. Its elements live in the row, not behind a pointer. */
export function array<E extends Ty, N extends number>(elem: E, length: N): ArrayTy<E, N> {
  if (!Number.isInteger(length) || length < 0) {
    throw new TypeError(`array length must be a non-negative integer, got ${length}`);
  }
  return { form: 'array', elem, length };
}

// ---------------------------------------------------------------------------
// Inference: the JS value shape of a schema
// ---------------------------------------------------------------------------

/**
 * How many elements a tuple stays exact for.
 *
 * A recursive tuple builder is quadratic in the checker, thus `array(f32, 4096)`
 * would cost more compile time than the exactness is worth.
 */
type TUPLE_LIMIT = 32;

/** A tuple of N copies of T. Above `TUPLE_LIMIT` it widens to `T[]`, length unchecked. */
type TupleOf<T, N extends number, R extends unknown[] = []> =
  number extends N ? T[]
  : R['length'] extends N ? R
  : R['length'] extends TUPLE_LIMIT ? T[]
  : TupleOf<T, N, [...R, T]>;

/**
 * The JS value shape of one instance of a schema type.
 *
 * Mutable: `const F extends Fields` makes each declared field readonly, but a
 * row value is a scratch object a caller fills and hands over, not a view on
 * the arena. An object that escapes into a hot loop is slow, thus hot reads use
 * generated free functions and never this.
 */
export type Value<T> =
  T extends Scalar<infer K> ? ValueOfKind[K]
  : T extends ArrayTy<infer E, infer N> ? TupleOf<Value<E>, N>
  : T extends StructTy<infer F> ? { -readonly [P in keyof F]: Value<F[P]> }
  : never;
