// Emit the layout as Zig source.
//
// The field table is the product, and this is one of its readers. `extern
// struct` is the C ABI, which is the rule set the layout engine computes, thus
// the two agree by construction. The emitted `comptime` block turns that
// agreement into a build failure on the Zig side. Without it a moved field
// reads a plausible wrong number, which is the failure this library exists to
// stop.
//
// This never emits a Zig `packed struct`, because that is a different thing. It
// packs to bits, it gives `bool` one bit, and it carries a backing integer. A
// pridat packed row is byte-granular, so the faithful spelling is `extern
// struct` with `align(1)` on each field. That is what C's
// `__attribute__((packed))` means.
//
// test/repr.test.ts compiles this output and compares every offset with the one
// zig reports.

import { layoutOf } from './layout.ts';
import type { ArrayTy, Scalar, ScalarKind, StructTy, Ty } from './schema.ts';

const ZIG: Readonly<Record<ScalarKind, string>> = {
  i8: 'i8', u8: 'u8', i16: 'i16', u16: 'u16', i32: 'i32', u32: 'u32',
  i64: 'i64', u64: 'u64', f32: 'f32', f64: 'f64', bool: 'bool',
  // The Zig side reads the handle. The text needs the same `Strings` bytes,
  // which cross as a block and not as a type.
  str: 'u32',
};

// Zig reserves these. A field named as one of these takes the `@"..."` form. A
// type named as one of these is refused at the root and renamed below it.
const KEYWORDS = new Set([
  'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'async', 'await',
  'break', 'callconv', 'catch', 'comptime', 'const', 'continue', 'defer', 'else', 'enum',
  'errdefer', 'error', 'export', 'extern', 'fn', 'for', 'if', 'inline', 'linksection',
  'noalias', 'noinline', 'nosuspend', 'opaque', 'or', 'orelse', 'packed', 'pub', 'resume',
  'return', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try', 'union',
  'unreachable', 'usingnamespace', 'var', 'volatile', 'while',
]);

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const usable = (n: string): boolean => BARE.test(n) && !KEYWORDS.has(n);

/** Zig reads a bare name directly. The `@"..."` form accepts every other name. */
const fieldName = (n: string): string => (usable(n) ? n : `@${JSON.stringify(n)}`);

/** A derived type name, for a struct whose own name Zig cannot read. */
function sanitize(s: string): string {
  let out = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(out)) out = `_${out}`;
  return KEYWORDS.has(out) ? `${out}_` : out;
}

/**
 * What makes two struct types one declaration: the name and the whole shape.
 *
 * `vec3(f32)` builds a new value at each call, so one row holding two of them
 * holds two values that must emit one type. The name is in the key, thus two
 * shapes that agree byte for byte under different names stay two declarations.
 */
function signature(t: Ty): string {
  if (t.form === 'scalar') return (t as Scalar).kind;
  if (t.form === 'array') {
    const a = t as ArrayTy;
    return `[${a.length}]${signature(a.elem)}`;
  }
  const s = t as StructTy;
  const fields = Object.keys(s.fields).map(f => `${f}:${signature(s.fields[f]!)}`).join(',');
  return `${s.name}${s.packed ? '/packed' : ''}{${fields}}`;
}

interface Decl { readonly name: string; readonly ty: StructTy }

/** Name every distinct struct in the schema, children before parents. */
function collect(root: StructTy, rootName: string): { decls: Decl[]; nameOf: Map<StructTy, string> } {
  const decls: Decl[] = [];
  const nameOf = new Map<StructTy, string>();
  const bySig = new Map<string, string>();
  const taken = new Set<string>();

  // The root takes the caller's name and never the struct's own, because the
  // argument exists to override it. It is reserved before the walk starts, so a
  // struct below it cannot take the name first and leave two declarations that
  // share one.
  taken.add(rootName);

  const pick = (t: StructTy, path: string): string => {
    const derived = sanitize(`${rootName}_${path}`);
    const wanted = usable(t.name) ? [t.name, derived] : [derived];
    for (const w of wanted) if (!taken.has(w)) return w;
    for (let i = 2; ; i++) if (!taken.has(`${derived}_${i}`)) return `${derived}_${i}`;
  };

  const visit = (t: StructTy, path: string): void => {
    if (nameOf.has(t)) return;
    const sig = signature(t);
    const hit = bySig.get(sig);
    // A second value of a shape already declared reuses that declaration, so
    // its own children are never rendered and never need a name.
    if (hit !== undefined) { nameOf.set(t, hit); return; }

    for (const f of Object.keys(t.fields)) {
      let e: Ty = t.fields[f]!;
      while (e.form === 'array') e = (e as ArrayTy).elem;
      if (e.form === 'struct') visit(e as StructTy, path === '' ? f : `${path}_${f}`);
    }

    const name = path === '' ? rootName : pick(t, path);
    bySig.set(sig, name);
    taken.add(name);
    nameOf.set(t, name);
    decls.push({ name, ty: t });
  };

  visit(root, '');
  return { decls, nameOf };
}

const zigTy = (t: Ty, nameOf: Map<StructTy, string>): string =>
  t.form === 'scalar' ? ZIG[(t as Scalar).kind]
  : t.form === 'array' ? `[${(t as ArrayTy).length}]${zigTy((t as ArrayTy).elem, nameOf)}`
  : nameOf.get(t as StructTy)!;

const compileError = (msg: string): string => `@compileError(${JSON.stringify(msg)})`;

function declare(d: Decl, nameOf: Map<StructTy, string>): string {
  // `align(1)` on each field is C's packed attribute. The struct then aligns to
  // 1 and holds no padding, which is what the layout engine computed.
  const suffix = d.ty.packed ? ' align(1)' : '';
  const fields = Object.keys(d.ty.fields)
    .map(f => `    ${fieldName(f)}: ${zigTy(d.ty.fields[f]!, nameOf)}${suffix},`);
  return [`pub const ${d.name} = extern struct {`, ...fields, '};'].join('\n');
}

function guard(d: Decl): string[] {
  const l = layoutOf(d.ty, d.name);
  const out = [
    `    if (@sizeOf(${d.name}) != ${l.size}) `
    + compileError(`${d.name} is not ${l.size} B. Regenerate this file from the schema.`) + ';',
    `    if (@alignOf(${d.name}) != ${l.align}) `
    + compileError(`${d.name} does not align to ${l.align}. Regenerate this file from the schema.`) + ';',
  ];
  for (const n of l.nodes) {
    out.push(
      `    if (@offsetOf(${d.name}, ${JSON.stringify(n.name)}) != ${n.offset}) `
      + compileError(`${d.name}.${n.name} is not at offset ${n.offset}. Regenerate this file from the schema.`)
      + ';',
    );
  }
  return out;
}

/**
 * The schema as a Zig file: one `extern struct` for each distinct struct in it,
 * then a `comptime` block that checks every size, alignment and offset.
 *
 * Write the output to a file in a build step. A generated file outlives the
 * schema that made it, and the `comptime` block is what refuses one the schema
 * has moved past. It costs nothing at run time.
 *
 * Name the root struct. Zig cannot read the default name.
 */
export function zigModule(s: StructTy, name = s.name): string {
  if (!usable(name)) {
    throw new TypeError(
      `zigModule: Zig cannot read the type name ${JSON.stringify(name)}. `
      + 'Pass a name to struct() or to zigModule().',
    );
  }
  const { decls, nameOf } = collect(s, name);
  const l = layoutOf(s, name);

  return [
    `// pridat: generated from the ${name} schema. Do not edit.`,
    '//',
    `// ${l.size} B/row, align ${l.align}, ${l.padding} B of padding.`,
    '// The comptime block below fails the build if Zig moves one byte.',
    '',
    ...decls.map(d => declare(d, nameOf) + '\n'),
    'comptime {',
    ...decls.flatMap(guard),
    '}',
    '',
  ].join('\n');
}
