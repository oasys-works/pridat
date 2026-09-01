// The accessor generator.
//
// The shape: free functions, one for each site, taking a view and a byte
// pointer. An engine inlines them. A wrapper that escapes, and a Proxy, measure
// far slower.
//
// The functions are generated at define time, on the engine that runs them.
// TypeScript generics erase, so one generic accessor over several element kinds
// is one call site with many shapes, and the second shape costs far more than
// the first. Generation is cheap. Parse time grows with source size, thus
// `only` exists and `omitted` is reported.
//
// Constraints, not negotiable here:
//
//   - `littleEndian` is a literal `true`, never a variable.
//   - A DataView index is always a sum. Write `p+0`, not `p`. A bare multiply
//     can hit a slow path.
//   - Nothing generated here throws. A throw in a hot loop is costly. `fits()`
//     returns a boolean for the preheader. `check()` throws, preheader only.
//   - Accessors check neither bounds nor generation. An iterator over a dense
//     row range consumed no handle, thus the check belongs at handle entry.
//
// Each site picks typed array or DataView for itself. See `siteOf`.

import type { ArrayTy, Fields, Scalar, ScalarKind, StructTy, ValueOfKind } from './schema.ts';
import type { Dim, Layout, Leaf, Node, Row, Struct } from './layout.ts';

// ---------------------------------------------------------------------------
// Access units
// ---------------------------------------------------------------------------

/**
 * The element type that an access moves. It is not always the declared kind.
 * `bool` is stored as a `u8`, and a 64-bit leaf is two `u32` halves, because a
 * lo/hi pair puts no object on the heap.
 */
export type AccessUnit = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64';

const UNIT: Readonly<Record<ScalarKind, AccessUnit>> = {
  i8: 'i8', u8: 'u8', i16: 'i16', u16: 'u16', i32: 'i32', u32: 'u32',
  f32: 'f32', f64: 'f64', bool: 'u8', i64: 'u32', u64: 'u32', str: 'u32',
};

const UNIT_SIZE: Readonly<Record<AccessUnit, number>> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8,
};

const UNIT_SHIFT: Readonly<Record<AccessUnit, number>> = {
  i8: 0, u8: 0, i16: 1, u16: 1, i32: 2, u32: 2, f32: 2, f64: 3,
};

const CTOR: Readonly<Record<AccessUnit, string>> = {
  i8: 'Int8Array', u8: 'Uint8Array', i16: 'Int16Array', u16: 'Uint16Array',
  i32: 'Int32Array', u32: 'Uint32Array', f32: 'Float32Array', f64: 'Float64Array',
};

const DV_GET: Readonly<Record<AccessUnit, string>> = {
  i8: 'getInt8', u8: 'getUint8', i16: 'getInt16', u16: 'getUint16',
  i32: 'getInt32', u32: 'getUint32', f32: 'getFloat32', f64: 'getFloat64',
};

const DV_SET: Readonly<Record<AccessUnit, string>> = {
  i8: 'setInt8', u8: 'setUint8', i16: 'setInt16', u16: 'setUint16',
  i32: 'setInt32', u32: 'setUint32', f32: 'setFloat32', f64: 'setFloat64',
};

/** The view a generated accessor reads through. `bind()` hands you the right one. */
export type LeafView =
  | Int8Array | Uint8Array | Int16Array | Uint16Array
  | Int32Array | Uint32Array | Float32Array | Float64Array | DataView;

/**
 * The phantom tag that names the site a view came from. It exists only in the
 * type: an ambient `declare const` emits nothing, and no view object carries it
 * at run time.
 */
declare const SITE: unique symbol;

/**
 * A view, tagged with the accessor site that may read through it.
 *
 * `bind()` returns one view for each access unit, thus `pos.x` and `alive` need
 * different objects over the same bytes. Without the tag a crossed pair is
 * silent, and `get['pos.x'](view['alive'], p)` returns a plausible wrong number.
 *
 * The tag is a name, which the checker does well. Bounds are counting, which it
 * cannot do, thus `check()` keeps them.
 *
 * The tag is optional. An untagged view stays assignable to each site, thus
 * your own typed array still works. The cost is one false rejection, because
 * sites that share a view object still carry different tags. Name each site, or
 * widen once with `const v: LeafView = B.view['pos.x']`.
 *
 * Tagging by access unit would be unsound. An unaligned `u32` falls to DataView
 * where an aligned one does not, and the type layer cannot see alignment.
 */
export type View<P extends string = string> = LeafView & { readonly [SITE]?: P };

/**
 * The layout is little-endian, because WASM is. A typed array uses the byte
 * order of the host, but a DataView gets `true`. Thus on a big-endian host the
 * two halves of this generator would disagree with each other and with WASM.
 * Refuse, do not emit bytes that nobody checked.
 */
const LITTLE_ENDIAN = (() => {
  const probe = new ArrayBuffer(2);
  new DataView(probe).setUint16(0, 1, true);
  return new Uint16Array(probe)[0] === 1;
})();

// ---------------------------------------------------------------------------
// The plan: what will be emitted, before anything is
// ---------------------------------------------------------------------------

/**
 * One generated accessor pair: one place in the row that holds one access unit.
 *
 * This is the codegen half of the field table, and it is public for the same
 * reason as `Layout.leaves`: a build step that emits source ahead of time, a
 * WASM emitter that selects a memarg alignment, and a test all read it.
 */
export interface Site {
  /** The accessor key: a leaf path, or `<leaf>.lo` / `<leaf>.hi` for a 64-bit leaf. */
  readonly path: string;
  /** The layout leaf this site reads all or half of. */
  readonly leaf: string;
  /** The leaf's declared kind. `bool`, `i64` and `u64` differ from `unit`. */
  readonly kind: ScalarKind;
  readonly unit: AccessUnit;
  /** How the bytes are reached. See the note above `siteOf`. */
  readonly via: 'typed' | 'dataview';
  /** Byte offset of element zero of this site, from the start of the row. */
  readonly offset: number;
  /** Empty for a plain scalar. One entry for each enclosing inline array, outermost first. */
  readonly dims: readonly Dim[];
  /** Index parameters the generated functions take. Equals `dims.length`. */
  readonly arity: number;
  /** True for the high half of an `i64`. It holds the sign and reads as `i32`. */
  readonly signed: boolean;
  /**
   * The alignment this access actually holds, as a power of two exponent.
   *
   * It is what a WebAssembly `memarg` immediate may claim, and it is the same
   * number `via` is decided from: an access reads through a typed array exactly
   * when this reaches the unit's own width. The layout knows the site offset and
   * the strides above it. Only an allocator knows where a row starts, which is
   * why this belongs to the plan and not to the leaf.
   *
   * A `memarg` that claims more than the address holds is not a correctness
   * fault, and an engine that trusts the claim makes it a speed one. The layout
   * is the contract both backends read, so this is the JS side of that contract
   * saying what the WASM side may assume.
   */
  readonly memAlign: number;
  /** Name of the generated getter, as it appears in a stack trace or a profile. */
  readonly getName: string;
  readonly setName: string;
}

export interface Plan {
  readonly name: string;
  /** The row stride, from the layout. */
  readonly size: number;
  readonly align: number;
  /**
   * The alignment that the caller guarantees for row zero. With the stride and
   * the offsets it decides typed access against DataView. It defaults to the
   * alignment of the layout, which is what an array of rows gives.
   */
  readonly ptrAlign: number;
  readonly sites: readonly Site[];
  /** Site paths in the layout that were not emitted. Reported, never silent. */
  readonly omitted: readonly string[];
  /** The views `bind()` will construct. */
  readonly units: readonly AccessUnit[];
  /** True if any site needs a DataView, which is slower on some engines. */
  readonly dataview: boolean;
  /** Whether whole-row `read`/`write` are emitted. */
  readonly row: boolean;
  /** The table that this plan came from. */
  readonly layout: Layout;
}

export interface AccessorOptions<K extends string = string> {
  /**
   * Emit accessors for these paths only. Parse time grows with source size,
   * thus a partial-field walk must ask only for the fields that it walks. A
   * 64-bit leaf path gives both halves. `<leaf>.lo` or `<leaf>.hi` selects one
   * half.
   */
  readonly only?: readonly K[];
  /**
   * Emit whole-row `read`/`write` on the bound handle. Default true. Set it
   * false on a hot partial-field plan: row operations touch each field, thus
   * they cost parse time for the whole struct.
   */
  readonly row?: boolean;
  /**
   * Alignment guaranteed for row zero. A power of two. Defaults to the layout's.
   *
   * Row i is at `i * size`, so the stride decides how much of this survives to
   * the rows above. Promising more than the stride can carry costs nothing and
   * buys nothing.
   */
  readonly ptrAlign?: number;
}

const isPow2 = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

const ident = (path: string): string => path.replace(/[^A-Za-z0-9_$]/g, '_');

/**
 * Decide typed-array access against DataView, for each site.
 *
 * Alignment is a property of an access, not of a leaf and not of a struct. An
 * access is not always as wide as the field: a `u64` at offset 8 reads as two
 * 4-aligned `u32` halves, thus it needs no DataView although
 * `Layout.unaligned` lists it.
 *
 * A typed array is legal only if the size of the unit divides the guaranteed
 * pointer alignment, the row stride, the site offset, and each inline-array
 * stride above it. Thus `packed` defaults to DataView above one byte, because
 * its alignment is 1 and it promises nothing about where a row starts. Pass
 * `ptrAlign` if your allocator promises more.
 */
/**
 * The largest power of two that divides the pointer promise, the row stride, the
 * site offset and every inline-array stride above it, capped at the unit's own
 * width.
 *
 * The stride is in here because `ptrAlign` is a promise about one pointer and a
 * walk makes many: row i is at `i * size`. An odd stride carries no promise past
 * row zero, thus a caller who allocates the rows and guarantees an aligned base
 * still gets a DataView where the stride cannot hold that base forward. `Pool`
 * derives its own promise from the stride for the same reason.
 *
 * Zero divides by every power of two, which is what makes a site at offset zero
 * take the promise unchanged.
 */
function commonAlign(
  cap: number, ptrAlign: number, stride: number, offset: number, dims: readonly Dim[],
): number {
  let a = cap;
  while (a > 1 && (
    ptrAlign % a !== 0 || stride % a !== 0 || offset % a !== 0 || dims.some(d => d.stride % a !== 0)
  )) {
    a >>= 1;
  }
  return a;
}

function siteOf(
  leaf: Leaf, half: 'lo' | 'hi' | null, offset: number, signed: boolean,
  ptrAlign: number, stride: number, index: number,
): Site {
  const unit = UNIT[leaf.kind];
  const us = UNIT_SIZE[unit];
  const path = half ? `${leaf.path}.${half}` : leaf.path;
  // One computation for both answers. The view kind and the memarg immediate
  // ask the same question, so deriving them apart would let them disagree.
  const reach = commonAlign(us, ptrAlign, stride, offset, leaf.dims);
  return {
    path,
    leaf: leaf.path,
    kind: leaf.kind,
    unit,
    via: reach === us ? 'typed' : 'dataview',
    offset,
    dims: leaf.dims,
    arity: leaf.dims.length,
    signed,
    memAlign: Math.log2(reach),
    getName: `get_${ident(path)}$${index}`,
    setName: `set_${ident(path)}$${index}`,
  };
}

function everySite(l: Layout, ptrAlign: number): Site[] {
  const out: Site[] = [];
  for (const leaf of l.leaves) {
    if (leaf.kind === 'i64' || leaf.kind === 'u64') {
      // Little-endian: the low half is first. The high half of an `i64` holds
      // the sign, thus its getter reads the same Uint32Array and applies `|0`.
      // That keeps both halves on one view, thus one shape.
      out.push(siteOf(leaf, 'lo', leaf.offset, false, ptrAlign, l.size, out.length));
      out.push(siteOf(leaf, 'hi', leaf.offset + 4, leaf.kind === 'i64', ptrAlign, l.size, out.length));
    } else {
      out.push(siteOf(leaf, null, leaf.offset, false, ptrAlign, l.size, out.length));
    }
  }
  return out;
}

/** What `accessors()` would emit, without emitting it. */
export function accessorPlan(l: Layout, opts: AccessorOptions = {}): Plan {
  if (!LITTLE_ENDIAN) {
    throw new Error(
      'pridat: this host is big-endian. The layout is little-endian to agree with WASM, ' +
      'and typed-array access here would disagree with the DataView path and with the WASM ' +
      'backend. Refusing to generate accessors.',
    );
  }

  const ptrAlign = opts.ptrAlign ?? l.align;
  if (!isPow2(ptrAlign)) {
    throw new RangeError(`ptrAlign must be a positive power of two, got ${ptrAlign}`);
  }

  const all = everySite(l, ptrAlign);
  let sites = all;

  if (opts.only) {
    const byPath = new Map(all.map(s => [s.path, s]));
    const byLeaf = new Map<string, Site[]>();
    for (const s of all) {
      const g = byLeaf.get(s.leaf);
      if (g) g.push(s); else byLeaf.set(s.leaf, [s]);
    }
    const want = new Map<string, Site>();
    for (const p of opts.only) {
      const exact = byPath.get(p);
      if (exact) { want.set(exact.path, exact); continue; }
      // A 64-bit leaf named without a half means both halves.
      const halves = byLeaf.get(p);
      if (halves && halves.length > 1) { for (const h of halves) want.set(h.path, h); continue; }
      throw new RangeError(
        `${l.name} has no accessor site ${JSON.stringify(p)}. It has: ${all.map(s => s.path).join(', ')}`,
      );
    }
    if (want.size === 0) {
      throw new RangeError(`${l.name}: \`only\` selected no sites. Omit it to emit every site.`);
    }
    // Keep declaration order and not the order asked for. Thus two plans over
    // the same fields make the same source and hit the same code cache.
    sites = all.filter(s => want.has(s.path));
  }

  const emitted = new Set(sites.map(s => s.path));
  const units = [...new Set(sites.map(s => s.via === 'typed' ? s.unit : null).filter((u): u is AccessUnit => u !== null))];
  const row = opts.row ?? true;
  if (row) {
    // Row read and write touch each field, whatever the plan asked for.
    for (const s of all) if (s.via === 'typed' && !units.includes(s.unit)) units.push(s.unit);
  }

  return {
    name: l.name,
    size: l.size,
    align: l.align,
    ptrAlign,
    sites,
    omitted: all.filter(s => !emitted.has(s.path)).map(s => s.path),
    units,
    dataview: sites.some(s => s.via === 'dataview') || (row && all.some(s => s.via === 'dataview')),
    row,
    layout: l,
  };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const viewVar = (u: AccessUnit): string => `_${u}`;
const DV = '_dv';

/**
 * The byte address of one element.
 *
 * Only the bare result of a multiply is penalised as a DataView index, and to
 * add anything to it, including zero, recovers parity. Thus `p+0` for offset
 * zero, and each address here is a sum.
 */
function addr(offset: number, dims: readonly Dim[], base = 'p'): string {
  let s = `${base}+${offset}`;
  for (let i = 0; i < dims.length; i++) s += `+i${i}*${dims[i]!.stride}`;
  return s;
}

const shifted = (a: string, unit: AccessUnit): string => {
  const sh = UNIT_SHIFT[unit];
  return sh === 0 ? a : `(${a})>>${sh}`;
};

/** The expression that reads one element of `site` from `view` at address `a`. */
function readOf(site: Site, a: string, view: string): string {
  const raw = site.via === 'typed'
    ? `${view}[${shifted(a, site.unit)}]`
    : UNIT_SIZE[site.unit] === 1
      ? `${view}.${DV_GET[site.unit]}(${a})`
      : `${view}.${DV_GET[site.unit]}(${a},true)`;
  if (site.kind === 'bool') return `${raw}!==0`;
  // The high half of an `i64` is the signed one. `|0` reinterprets the u32 read.
  if (site.signed) return `${raw}|0`;
  return raw;
}

/** The statement that writes `value` into one element of `site` through `view`. */
function writeOf(site: Site, a: string, view: string, value: string): string {
  const v = site.kind === 'bool' ? `${value}?1:0` : value;
  return site.via === 'typed'
    ? `${view}[${shifted(a, site.unit)}]=${v};`
    : UNIT_SIZE[site.unit] === 1
      ? `${view}.${DV_SET[site.unit]}(${a},${v});`
      : `${view}.${DV_SET[site.unit]}(${a},${v},true);`;
}

const viewOfSite = (s: Site): string => s.via === 'typed' ? viewVar(s.unit) : DV;

/**
 * The free `(view, ptr, ...ix)` accessor pair for one site.
 *
 * What this emits measures the same as the arithmetic written inline with the
 * call removed. An escaping wrapper measures far slower. An engine inlines a
 * function that it first saw as a string.
 *
 * The view is a parameter, never a module-scoped binding. A captured view would
 * let the generated module hold one buffer at a time, which a shared-memory
 * arena cannot accept.
 *
 * The setter takes its value last, after the indices, thus it reads as an
 * assignment. The type layer below repeats that arity.
 */
function emitSite(s: Site): string[] {
  const ix = Array.from({ length: s.arity }, (_, i) => `i${i}`);
  const a = addr(s.offset, s.dims);
  const get = ['v', 'p', ...ix].join(',');
  const set = ['v', 'p', ...ix, 'x'].join(',');
  return [
    `function ${s.getName}(${get}){return ${readOf(s, a, 'v')};}`,
    `function ${s.setName}(${set}){${writeOf(s, a, 'v', 'x')}}`,
  ];
}

// --- whole-row read and write ----------------------------------------------
//
// The cold path, and it says so. It allocates a new object for each row, which
// is slow in a loop. Use these to move a row in or out at the edges, for a
// test, a serializer or a debugger.

interface RowCtx { sites: Map<string, Site>; }

/**
 * The row path drops the `dims` of a site. A free accessor puts its index
 * parameters in the address, but here the enclosing `for` loops already give
 * each inline-array stride. To use the dims again would count each one twice.
 */
const NO_DIMS: readonly Dim[] = [];

/** A pure expression for a subtree, or null if it contains an inline array. */
function rowExpr(n: Node, ctx: RowCtx, add: string): string | null {
  // A zero-length array occupies no bytes and gives no leaf, thus there is no
  // site to read. But the node stays in the tree and the row type still says
  // `[]`. It is an expression, not a loop.
  if (n.form === 'array') return n.length === 0 ? '[]' : null;
  if (n.form === 'scalar') {
    if (n.kind === 'i64' || n.kind === 'u64') {
      const lo = ctx.sites.get(`${n.path}.lo`)!;
      const hi = ctx.sites.get(`${n.path}.hi`)!;
      return `{lo:${readOf(lo, addr(lo.offset, NO_DIMS, `p${add}`), viewOfSite(lo))},`
        + `hi:${readOf(hi, addr(hi.offset, NO_DIMS, `p${add}`), viewOfSite(hi))}}`;
    }
    const s = ctx.sites.get(n.path)!;
    return readOf(s, addr(s.offset, NO_DIMS, `p${add}`), viewOfSite(s));
  }
  const parts: string[] = [];
  for (const c of n.children ?? []) {
    const e = rowExpr(c, ctx, add);
    if (e === null) return null;
    parts.push(`${JSON.stringify(c.name)}:${e}`);
  }
  return `{${parts.join(',')}}`;
}

function emitRowRead(n: Node, target: string, ctx: RowCtx, add: string, depth: number, out: string[]): void {
  const e = rowExpr(n, ctx, add);
  if (e !== null) { out.push(`${target}=${e};`); return; }
  if (n.form === 'array') {
    const i = `k${depth}`;
    out.push(`${target}=new Array(${n.length});`);
    out.push(`for(let ${i}=0;${i}<${n.length};${i}++){`);
    emitRowRead(n.elem!, `${target}[${i}]`, ctx, `${add}+${i}*${n.stride}`, depth + 1, out);
    out.push(`}`);
    return;
  }
  out.push(`${target}={};`);
  for (const c of n.children ?? []) {
    emitRowRead(c, `${target}[${JSON.stringify(c.name)}]`, ctx, add, depth, out);
  }
}

function emitRowWrite(n: Node, src: string, ctx: RowCtx, add: string, depth: number, out: string[]): void {
  if (n.form === 'scalar') {
    if (n.kind === 'i64' || n.kind === 'u64') {
      const lo = ctx.sites.get(`${n.path}.lo`)!;
      const hi = ctx.sites.get(`${n.path}.hi`)!;
      out.push(writeOf(lo, addr(lo.offset, NO_DIMS, `p${add}`), viewOfSite(lo), `${src}.lo`));
      out.push(writeOf(hi, addr(hi.offset, NO_DIMS, `p${add}`), viewOfSite(hi), `${src}.hi`));
      return;
    }
    const s = ctx.sites.get(n.path)!;
    out.push(writeOf(s, addr(s.offset, NO_DIMS, `p${add}`), viewOfSite(s), src));
    return;
  }
  if (n.form === 'array') {
    if (n.length === 0) return;                     // no bytes, and no leaf to address
    const i = `k${depth}`;
    out.push(`for(let ${i}=0;${i}<${n.length};${i}++){`);
    emitRowWrite(n.elem!, `${src}[${i}]`, ctx, `${add}+${i}*${n.stride}`, depth + 1, out);
    out.push(`}`);
    return;
  }
  for (const c of n.children ?? []) {
    emitRowWrite(c, `${src}[${JSON.stringify(c.name)}]`, ctx, add, depth, out);
  }
}

/**
 * Everything a caller and a pre-generated module must agree on, as one string.
 *
 * A generated file outlives the schema that made it. When the schema moves, the
 * offsets in that file are wrong and every read is a plausible wrong number,
 * which is the failure this library exists to stop. So the module carries this,
 * and `accessorsFrom` compares it with the plan the caller holds now.
 *
 * It covers the whole site table and not the emitted subset, because whole-row
 * `read` and `write` reach sites that `only` left out.
 */
export function planSignature(plan: Plan): string {
  const emitted = new Set(plan.sites.map(s => s.path));
  const sites = everySite(plan.layout, plan.ptrAlign).map(s =>
    `${emitted.has(s.path) ? '+' : '-'}${s.path}:${s.unit}:${s.via}:${s.offset}:${s.signed ? 1 : 0}`
    + `:${s.dims.map(d => `${d.count}x${d.stride}`).join(',')}`);
  // Each token names itself, because the error reports the first one that
  // differs and a bare number says nothing about which number it is.
  return [
    'pridat/1', `name=${plan.name}`, `size=${plan.size}`, `ptrAlign=${plan.ptrAlign}`,
    plan.row ? 'row' : 'norow', ...sites,
  ].join(' ');
}

/** Name the first token where a module and a plan disagree, for the error. */
function firstDifference(want: string, got: string): string {
  const a = want.split(' ');
  const b = got.split(' ');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `expected ${JSON.stringify(a[i] ?? '(nothing)')}, got ${JSON.stringify(b[i] ?? '(nothing)')}`;
  }
  return 'they differ in no token, which should not happen';
}

/**
 * The source text of a plan, as a `new Function` body.
 *
 * This is what `accessors()` evaluates, and what `Pool.share()` sends to a
 * worker. It also feeds a code cache, which keys on source. Its tail is a bare
 * `return`, thus a file cannot hold it. `emitAccessorModule` is the same
 * functions under a tail that a file can.
 */
export function emitAccessors(plan: Plan): string {
  return [...emitBody(plan), ...emitEvalTail(plan)].join('\n');
}

/**
 * The source text of a plan, as an ES module.
 *
 * `new Function` is unavailable under a Content-Security-Policy without
 * `unsafe-eval`, and a library that others depend on cannot need it. A build
 * step calls this, writes the string to a file, and ships code that evaluates
 * nothing. Hand the module's exports to `accessorsFrom` on the owning thread,
 * or to `bindShare` on a worker.
 */
export function emitAccessorModule(plan: Plan): string {
  return [...emitBody(plan), ...emitModuleTail(plan)].join('\n');
}

/** The functions themselves. Both tails close over these and neither changes them. */
function emitBody(plan: Plan): string[] {
  const l = plan.layout;
  const src: string[] = [];

  src.push(`"use strict";`);
  src.push(`// pridat: generated accessors for ${l.name}: ${plan.size} B/row, align ${plan.align},`);
  src.push(`// ptr alignment assumed ${plan.ptrAlign}. ${plan.sites.length} site(s) emitted`
    + `${plan.omitted.length ? `, ${plan.omitted.length} omitted` : ''}.`);
  if (plan.dataview) {
    const dv = plan.sites.filter(s => s.via === 'dataview').map(s => s.path);
    src.push(`// DataView, which is slower, is forced at: ${dv.length ? dv.join(', ') : '(row ops only)'}`);
  }

  for (const s of plan.sites) src.push(...emitSite(s));

  // The hoistable guard. It is free in the preheader and costly in the loop.
  // `fits` returns a boolean, thus it composes with a trap flag. `check` throws
  // and is for the preheader alone.
  src.push(`function fits(v,base,n){return base>=0&&n>=0&&base+n*${plan.size}<=v.byteLength;}`);
  src.push(`function check(v,base,n){if(!fits(v,base,n))throw new RangeError(`
    + `${JSON.stringify(l.name)}+": rows ["+base+", "+base+"+"+n+"*${plan.size}) do not fit in a view of "+v.byteLength+" bytes");}`);

  // bind(): one view for each unit the plan uses, made once for each buffer.
  src.push(`function mk(C,b,sh){const n=b.byteLength;return (n&((1<<sh)-1))===0?new C(b):new C(b,0,n>>>sh);}`);
  src.push(`function bind(b){`);
  for (const u of plan.units) src.push(`const ${viewVar(u)}=mk(${CTOR[u]},b,${UNIT_SHIFT[u]});`);
  if (plan.dataview) src.push(`const ${DV}=new DataView(b);`);

  const viewMap = plan.sites.map(s => `${JSON.stringify(s.path)}:${viewOfSite(s)}`).join(',');

  if (plan.row) {
    const ctx: RowCtx = { sites: new Map(everySite(l, plan.ptrAlign).map(s => [s.path, s])) };
    const rd: string[] = [];
    const wr: string[] = [];
    for (const n of l.nodes) {
      emitRowRead(n, `r[${JSON.stringify(n.name)}]`, ctx, '', 0, rd);
      emitRowWrite(n, `r[${JSON.stringify(n.name)}]`, ctx, '', 0, wr);
    }
    src.push(`function read(p){const r={};${rd.join('')}return r;}`);
    src.push(`function write(p,r){${wr.join('')}}`);
  } else {
    const why = JSON.stringify(
      `${l.name}: this accessor set was compiled with { row: false }, which omits whole-row `
      + `read/write so they cost no parse time. Recompile without it to use them.`);
    src.push(`function read(){throw new Error(${why});}`);
    src.push(`function write(){throw new Error(${why});}`);
  }
  src.push(`return {buffer:b,view:{${viewMap}},read:read,write:write};`);
  src.push(`}`);

  return src;
}

const getMap = (plan: Plan): string =>
  `{${plan.sites.map(s => `${JSON.stringify(s.path)}:${s.getName}`).join(',')}}`;
const setMap = (plan: Plan): string =>
  `{${plan.sites.map(s => `${JSON.stringify(s.path)}:${s.setName}`).join(',')}}`;

function emitEvalTail(plan: Plan): string[] {
  return [
    `return {get:${getMap(plan)},set:${setMap(plan)},`,
    `fits:fits,check:check,bind:bind,signature:${JSON.stringify(planSignature(plan))}};`,
    // Without a sourceURL, a generated module shows as `VM1234` in DevTools and
    // `<anonymous>` in a stack trace, and a name is far harder to retrofit than
    // to emit. A formatter that renders a bare integer as a struct needs the
    // handle, thus it waits for the handle layer.
    `//# sourceURL=pridat/${ident(plan.name)}.accessors.js`,
  ];
}

function emitModuleTail(plan: Plan): string[] {
  return [
    `export const get=${getMap(plan)};`,
    `export const set=${setMap(plan)};`,
    `export {fits,check,bind};`,
    // The schema this was generated from, so a caller can prove the file is not
    // one the schema has moved past. `accessorsFrom` and `bindShare` read it.
    `export const signature=${JSON.stringify(planSignature(plan))};`,
    `export default {get,set,fits,check,bind,signature};`,
  ];
}

/** `emitAccessors(accessorPlan(l, opts))`, for a build step that wants one call. */
export const accessorSource = (l: Layout, opts?: AccessorOptions): string =>
  emitAccessors(accessorPlan(l, opts));

/** `emitAccessorModule(accessorPlan(l, opts))`, for a build step that wants one call. */
export const accessorModule = (l: Layout, opts?: AccessorOptions): string =>
  emitAccessorModule(accessorPlan(l, opts));

// The schema is a runtime value and TypeScript infers the type from it,
// because the layout engine needs field names and widths at run time. The walk
// that makes `LeafPath` also makes the accessor sites, and it is repeated here
// for two differences:
//
//   - a 64-bit leaf is two sites, `.lo` and `.hi`, thus the pair shows in the
//     type and not only in the bytes.
//   - each site carries the index arity of its inline arrays, thus
//     `get['verts.x'](v, p)` on an `array(vec3(f32), 3)` is a compile error.

/**
 * How deep this walk follows nested structs and arrays before it stops.
 *
 * This is a termination condition, not a taste limit. `Fields` indexes `Ty`,
 * `Ty` includes `StructTy`, and its fields are `Fields` again, thus a walk over
 * a generic schema has no bottom. A concrete schema terminates alone. A generic
 * `Struct<F>` reaches the limit at once, which makes the interfaces below
 * declarable.
 */
type WALK_LIMIT = 12;

/** `[path, kind, indices]` for every accessor site in `T`. */
type SiteRec<T, Prefix extends string = '', Ix extends number[] = [], D extends unknown[] = []> =
  D['length'] extends WALK_LIMIT ? never
  : T extends Scalar<infer K>
    ? K extends 'i64' | 'u64'
      ? [`${Prefix}.lo`, 'u32', Ix] | [`${Prefix}.hi`, 'u32', Ix]
      : [Prefix, K, Ix]
  : T extends ArrayTy<infer E, any> ? SiteRec<E, Prefix, [...Ix, number], [...D, 0]>
  : T extends StructTy<infer F>
    ? { [K in keyof F & string]: SiteRec<F[K], Prefix extends '' ? K : `${Prefix}.${K}`, Ix, [...D, 0]> }[keyof F & string]
    : never;

type RecFor<T, P extends string> = Extract<SiteRec<T>, [P, ScalarKind, number[]]>;

/** The dotted paths of every accessor site in `T`. A closed union. */
export type SitePath<T> = SiteRec<T>[0];

/** The paths of `T`'s 64-bit leaves, which name both halves at once in `only`. */
export type Leaf64<T, Prefix extends string = '', D extends unknown[] = []> =
  D['length'] extends WALK_LIMIT ? never
  : T extends Scalar<infer K> ? (K extends 'i64' | 'u64' ? Prefix : never)
  : T extends ArrayTy<infer E, any> ? Leaf64<E, Prefix, [...D, 0]>
  : T extends StructTy<infer F>
    ? { [K in keyof F & string]: Leaf64<F[K], Prefix extends '' ? K : `${Prefix}.${K}`, [...D, 0]> }[keyof F & string]
    : never;

/**
 * The site paths an `only` selection expands to. A 64-bit leaf named alone
 * gives both halves. `Pool` repeats the selection, so this is public.
 */
export type ExpandOnly<T, K> = K extends Leaf64<T> ? `${K & string}.lo` | `${K & string}.hi` : K;

/** What one site reads as: `number`, or `boolean` for a `bool`. */
export type SiteValue<T, P extends string> =
  RecFor<T, P> extends [string, infer K, unknown[]]
    ? (K extends ScalarKind ? ValueOfKind[K] : never)
    : never;

/** The index parameters one site takes: one per enclosing inline array. */
export type SiteIndices<T, P extends string> =
  RecFor<T, P> extends [string, ScalarKind, infer Ix] ? (Ix extends number[] ? Ix : []) : [];

export type Getter<T, P extends string> =
  (view: View<P>, ptr: number, ...ix: SiteIndices<T, P>) => SiteValue<T, P>;

export type Setter<T, P extends string> =
  (view: View<P>, ptr: number, ...args: [...SiteIndices<T, P>, SiteValue<T, P>]) => void;

/** A buffer, the view each site reads through, and the cold-path row moves. */
export interface Bound<F extends Fields, P extends string = SitePath<Struct<F>>> {
  readonly buffer: ArrayBufferLike;
  /**
   * The view to pass as an accessor's first argument. Sites that share an
   * access unit share one view object, thus a loop hoists it once and the call
   * site sees one shape.
   *
   * Each view is tagged with its site, thus the wrong view is a compile error
   * and not a plausible wrong number. See `View` for the way out.
   */
  readonly view: { readonly [K in P]: View<K> };
  /**
   * Copy a whole row out. This is the cold path: it allocates, which is slow in
   * a loop. Move rows at the edges, for a test, a serializer or a debugger, and
   * read fields through `get` in a loop.
   *
   * It throws if this set was compiled with `{ row: false }`.
   */
  read(ptr: number): Row<Struct<F>>;
  /** Copy a whole row in. The cold path, as `read`. */
  write(ptr: number, row: Row<Struct<F>>): void;
}

export interface Accessors<F extends Fields, P extends string = SitePath<Struct<F>>> {
  readonly name: string;
  /** The row stride. `row(i)` is at `i * size`. */
  readonly size: number;
  readonly align: number;
  /** What was emitted, and what was left out. */
  readonly plan: Plan;
  /** The generated source, as a `new Function` body. Feed a code cache with it. */
  readonly source: string;
  /**
   * What a pre-generated module must carry to be accepted here. See
   * `planSignature`.
   */
  readonly signature: string;
  /** Free `(view, ptr, ...indices)` getters, keyed by site path. */
  readonly get: { readonly [K in P]: Getter<Struct<F>, K> };
  /** Free `(view, ptr, ...indices, value)` setters, keyed by site path. */
  readonly set: { readonly [K in P]: Setter<Struct<F>, K> };
  /**
   * True if `count` rows that start at byte offset `base` are inside `view`.
   *
   * Hoist it to the loop preheader, where it is free. It returns a boolean and
   * does not throw, thus it composes with a trap flag.
   */
  fits(view: LeafView, base: number, count: number): boolean;
  /** `fits`, but it throws. For the preheader only, never in a loop. */
  check(view: LeafView, base: number, count: number): void;
  bind(buffer: ArrayBufferLike): Bound<F, P>;
}

/**
 * Generate and compile the accessors for a struct.
 *
 * ```ts
 * const Particle = struct({ pos: vec3(f32), mass: f32, alive: bool })
 * const A = accessors(Particle)
 * const B = A.bind(new ArrayBuffer(Particle.size * 1000))
 *
 * const getX = A.get['pos.x'], v = B.view['pos.x']   // hoist, once
 * A.check(v, 0, 1000)                                // guard, in the preheader
 * for (let p = 0; p < 1000 * Particle.size; p += Particle.size) sum += getX(v, p)
 * ```
 *
 * `new Function` makes the call sites monomorphic on the engine that runs them,
 * and it is cheap. Where a Content-Security-Policy forbids it, call
 * `accessorModule()` in a build step and pass the module's exports to
 * `accessorsFrom()`.
 */
export function accessors<
  const F extends Fields,
  const K extends SitePath<Struct<F>> | Leaf64<Struct<F>> = SitePath<Struct<F>>,
>(s: Struct<F>, opts?: AccessorOptions<K>): Accessors<F, ExpandOnly<Struct<F>, K>> {
  const plan = accessorPlan(s, opts as AccessorOptions);
  const source = emitAccessors(plan);

  let mod: Record<string, unknown>;
  try {
    mod = new Function(source)() as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof EvalError || /unsafe-eval|Content Security Policy|CSP/i.test(msg)) {
      throw new EvalError(
        `pridat: accessors() needs \`new Function\`, which this environment forbids (${msg}). ` +
        `Call accessorModule() in a build step, then pass the module's exports to ` +
        `accessorsFrom(). It is the same functions, evaluated ahead of time.`,
      );
    }
    throw e;
  }

  return build(plan, source, mod);
}

/**
 * `accessors()`, for a host that evaluated the generated module ahead of time.
 *
 * `mod` is what `accessorModule()` produced, imported. Pass the same schema and
 * the same options the build step used. This evaluates nothing.
 *
 * ```ts
 * // build step
 * writeFileSync('particle.accessors.js', accessorModule(Particle))
 *
 * // run time, under a Content-Security-Policy
 * import * as generated from './particle.accessors.js'
 * const A = accessorsFrom(Particle, generated)
 * ```
 *
 * A generated file outlives the schema that made it, so this refuses one the
 * schema has moved past rather than reading plausible wrong numbers through it.
 */
export function accessorsFrom<
  const F extends Fields,
  const K extends SitePath<Struct<F>> | Leaf64<Struct<F>> = SitePath<Struct<F>>,
>(s: Struct<F>, mod: unknown, opts?: AccessorOptions<K>): Accessors<F, ExpandOnly<Struct<F>, K>> {
  const plan = accessorPlan(s, opts as AccessorOptions);
  checkModule(plan, mod, 'accessorsFrom');
  // `share()` sends text to a worker that may evaluate it, so `source` stays the
  // eval form here too. Building the string costs no parse time.
  return build(plan, emitAccessors(plan), mod as Record<string, unknown>);
}

function build<F extends Fields, P extends string>(
  plan: Plan, source: string, mod: Record<string, unknown>,
): Accessors<F, P> {
  return {
    name: plan.name, size: plan.size, align: plan.align, plan, source,
    ...mod,
  } as unknown as Accessors<F, P>;
}

/**
 * Prove a pre-evaluated module was generated from this plan.
 *
 * Shared by `accessorsFrom` and `bindShare`, because a stale generated file is
 * the same fault on either side of a thread boundary.
 */
export const checkModule = (plan: Plan, mod: unknown, who: string): void =>
  checkModuleSignature(planSignature(plan), plan.name, mod, who);

/**
 * `checkModule`, for a caller that holds the signature and not the plan.
 *
 * A worker has neither the schema nor the layout engine, by design. So the
 * owning thread computes the signature and posts it, and this compares two
 * strings.
 */
export function checkModuleSignature(want: string, name: string, mod: unknown, who: string): void {
  const m = mod as Partial<Record<string, unknown>> | null | undefined;
  if (typeof m?.['bind'] !== 'function' || typeof m['get'] !== 'object'
    || typeof m['set'] !== 'object') {
    throw new TypeError(`${who} expects the generated accessor module, which exports get, set and bind.`);
  }
  const got = m['signature'];
  if (typeof got !== 'string') {
    throw new TypeError(
      `${who}: this module carries no signature, so it cannot be proved to match the schema. `
      + 'Regenerate it with accessorModule().',
    );
  }
  if (got !== want) {
    throw new TypeError(
      `${who}: ${name}: the generated module does not match the schema it was given. `
      + `${firstDifference(want, got)}. Regenerate it.`,
    );
  }
}
