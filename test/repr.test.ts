// Does our layout engine agree with the compilers it claims to be compatible with?
//
// "The layout is the interface" is only true if our idea of a byte position is
// the same as rustc's, cc's and zig's. That is a measurable claim, and those
// compilers are on this machine, so we measure it instead of asserting it.
//
// The Rust and C emitters below are a checking tool, not a shipped feature. The
// Zig one is shipped, thus this file compiles `zigModule` output and not a copy
// of it. What a caller writes to a file is what a compiler reads here.
//
// A toolchain that is absent is NAMED, never skipped in silence. An absent
// compiler means this claim is currently unmeasured.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { f32, layoutOf, measure, struct, u8, u16, u32, zigModule } from '../src/index.ts';
import type { ArrayTy, Scalar, ScalarKind, StructTy, Ty } from '../src/index.ts';
import { CORPUS } from './corpus.ts';
import { group, report, skip } from './harness.ts';

const RUST: Record<ScalarKind, string> = {
  i8: 'i8', u8: 'u8', i16: 'i16', u16: 'u16', i32: 'i32', u32: 'u32',
  i64: 'i64', u64: 'u64', f32: 'f32', f64: 'f64', bool: 'bool',
  // A `str` field is a handle. The other side sees the word and reads the text
  // from the same `Strings` bytes, thus the row stays repr(C).
  str: 'u32',
};

const C: Record<ScalarKind, string> = {
  i8: 'int8_t', u8: 'uint8_t', i16: 'int16_t', u16: 'uint16_t',
  i32: 'int32_t', u32: 'uint32_t', i64: 'int64_t', u64: 'uint64_t',
  f32: 'float', f64: 'double', bool: 'bool', str: 'uint32_t',
};

// Rust and C only. `zigModule` wraps a name in `@"..."`, which accepts every
// name a schema can hold, thus the Zig side needs no list.
const RESERVED = new Set([
  // enough of both languages that a collision becomes a clear error rather than
  // a compile failure three hundred lines away
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for',
  'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
  'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
  'auto', 'char', 'default', 'do', 'double', 'float', 'goto', 'int', 'long', 'register',
  'short', 'signed', 'sizeof', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile',
]);

interface Named { name: string; ty: StructTy }

/** Give every distinct struct in the schema a name, children before parents. */
function collect(root: StructTy, name: string, seen: Map<StructTy, string>, out: Named[]): void {
  if (seen.has(root)) return;
  seen.set(root, name);
  for (const field of Object.keys(root.fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || RESERVED.has(field)) {
      throw new Error(`field name ${JSON.stringify(field)} is reserved or not an identifier in Rust/C`);
    }
    let t: Ty = root.fields[field]!;
    while (t.form === 'array') t = (t as ArrayTy).elem;
    if (t.form === 'struct') collect(t as StructTy, `${name}_${field}`, seen, out);
  }
  out.push({ name, ty: root });
}

const rustTy = (t: Ty, seen: Map<StructTy, string>): string =>
  t.form === 'scalar' ? RUST[(t as Scalar).kind]
  : t.form === 'array' ? `[${rustTy((t as ArrayTy).elem, seen)}; ${(t as ArrayTy).length}]`
  : seen.get(t as StructTy)!;

function cTy(t: Ty, seen: Map<StructTy, string>): { base: string; dims: number[] } {
  if (t.form === 'scalar') return { base: C[(t as Scalar).kind], dims: [] };
  if (t.form === 'array') {
    const a = t as ArrayTy;
    const inner = cTy(a.elem, seen);
    return { base: inner.base, dims: [a.length, ...inner.dims] };
  }
  return { base: seen.get(t as StructTy)!, dims: [] };
}

function emitRust(all: Named[], seen: Map<StructTy, string>): string {
  const defs = all.map(({ name, ty }) => {
    const attr = ty.packed ? '#[repr(C, packed)]' : '#[repr(C)]';
    const fields = Object.keys(ty.fields)
      .map(f => `    pub ${f}: ${rustTy(ty.fields[f]!, seen)},`).join('\n');
    return `${attr}\npub struct ${name} {\n${fields}\n}`;
  });
  const prints = all.flatMap(({ name, ty }) => [
    `    println!("T ${name} {} {}", size_of::<${name}>(), align_of::<${name}>());`,
    ...Object.keys(ty.fields).map(f =>
      `    println!("F ${name} ${f} {}", offset_of!(${name}, ${f}));`),
  ]);
  return [
    '#![allow(non_camel_case_types, dead_code, unused)]',
    'use core::mem::{align_of, offset_of, size_of};',
    '',
    ...defs,
    '',
    'fn main() {',
    ...prints,
    '}',
    '',
  ].join('\n');
}

function emitC(all: Named[], seen: Map<StructTy, string>): string {
  const defs = all.map(({ name, ty }) => {
    const attr = ty.packed ? ' __attribute__((packed))' : '';
    const fields = Object.keys(ty.fields).map(f => {
      const { base, dims } = cTy(ty.fields[f]!, seen);
      return `    ${base} ${f}${dims.map(d => `[${d}]`).join('')};`;
    }).join('\n');
    return `typedef struct${attr} {\n${fields}\n} ${name};`;
  });
  const prints = all.flatMap(({ name, ty }) => [
    `    printf("T ${name} %zu %zu\\n", sizeof(${name}), _Alignof(${name}));`,
    ...Object.keys(ty.fields).map(f =>
      `    printf("F ${name} ${f} %zu\\n", offsetof(${name}, ${f}));`),
  ]);
  return [
    '#include <stdio.h>', '#include <stddef.h>', '#include <stdint.h>', '#include <stdbool.h>',
    '',
    ...defs,
    '',
    'int main(void) {',
    ...prints,
    '    return 0;',
    '}',
    '',
  ].join('\n');
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The corpus as Zig: one generated file for each schema, and a main that prints
 * what zig measured.
 *
 * One file for each schema, because that is how a caller uses `zigModule`, and
 * because two schemas may each hold a struct named `vec3`. `@import` keeps
 * those apart. Each generated file also carries its own comptime block, so the
 * compile below checks every nested struct that this main never names.
 */
function writeZigCorpus(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const head = ['const std = @import("std");'];
  const body: string[] = [];

  CORPUS.forEach(({ name, type }, i) => {
    writeFileSync(join(dir, `${name}.zig`), zigModule(type, name));
    head.push(`const m${i} = @import(${q(`${name}.zig`)});`);
    const T = `m${i}.${name}`;
    // Every name goes in as an argument. A field name holding a brace would
    // otherwise read as a format placeholder.
    body.push(`    std.debug.print("T {s} {d} {d}\\n", .{ ${q(name)}, @sizeOf(${T}), @alignOf(${T}) });`);
    for (const f of Object.keys(type.fields)) {
      body.push(
        `    std.debug.print("F {s} {s} {d}\\n", .{ ${q(name)}, ${q(f)}, @offsetOf(${T}, ${q(f)}) });`);
    }
  });

  const main = join(dir, 'main.zig');
  writeFileSync(main, [...head, '', 'pub fn main() void {', ...body, '}', ''].join('\n'));
  return main;
}

/**
 * Compile and run one Zig file. Both `std.debug.print` and the compiler write
 * to stderr, thus a refusal arrives as the text that explains it.
 *
 * The caches go under the temporary directory, so a run leaves nothing behind.
 */
function runZig(main: string, cache: string): { ok: boolean; out: string } {
  const r = spawnSync(
    'zig',
    ['run', '--cache-dir', cache, '--global-cache-dir', cache, main],
    { encoding: 'utf8' },
  );
  return { ok: r.status === 0, out: r.stderr };
}

interface Observed { size: Map<string, number>; align: Map<string, number>; offset: Map<string, number> }

function parse(out: string): Observed {
  const o: Observed = { size: new Map(), align: new Map(), offset: new Map() };
  let seen = 0;
  for (const line of out.split('\n')) {
    const t = line.match(/^T (\S+) (\d+) (\d+)$/);
    if (t) { o.size.set(t[1]!, +t[2]!); o.align.set(t[1]!, +t[3]!); seen++; continue; }
    // The field group takes a space, because a schema may hold a field named
    // `two words` and Zig reads it as `@"two words"`. A type name cannot.
    const f = line.match(/^F (\S+) (.+) (\d+)$/);
    if (f) { o.offset.set(`${f[1]}.${f[2]}`, +f[3]!); seen++; }
  }
  // A parser that finds nothing must fail loudly.
  if (seen === 0) throw new Error(`parsed no layout lines from compiler output:\n${out.slice(0, 500)}`);
  return o;
}

// The probe takes the arguments, because zig spells it `zig version` and
// answers `--version` with an error. A wrong probe would report a toolchain
// that is present as absent, which reads as coverage we do not have.
const have = (cmd: string, args: string[] = ['--version']): boolean =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'pridat-repr-'));
const seen = new Map<StructTy, string>();
const all: Named[] = [];
for (const { name, type } of CORPUS) collect(type, name, seen, all);

function check(lang: string, list: Named[], observed: Observed, t: import('./harness.ts').T): void {
  for (const { name, ty } of list) {
    const m = measure(ty);
    t.eq(`${lang}: ${name} size`, m.size, observed.size.get(name));
    t.eq(`${lang}: ${name} align`, m.align, observed.align.get(name));
    const L = layoutOf(ty, name);
    for (const node of L.nodes) {
      t.eq(`${lang}: ${name}.${node.name} offset`, node.offset, observed.offset.get(`${name}.${node.name}`));
    }
  }
}

if (!have('rustc')) {
  skip('rustc agrees with our #[repr(C)] offsets', 'rustc not found. The claim is unmeasured on this machine');
} else {
  group('rustc agrees with our #[repr(C)] offsets', t => {
    const src = join(dir, 'repr.rs');
    writeFileSync(src, emitRust(all, seen));
    execFileSync('rustc', ['--edition', '2021', '-O', '-o', join(dir, 'repr_rs'), src], { encoding: 'utf8' });
    check('rustc', all, parse(execFileSync(join(dir, 'repr_rs'), { encoding: 'utf8' })), t);
  });
}

if (!have('cc')) {
  skip('cc agrees with our C offsets', 'cc not found. The claim is unmeasured on this machine');
} else {
  group('cc agrees with our C offsets', t => {
    const src = join(dir, 'repr.c');
    writeFileSync(src, emitC(all, seen));
    execFileSync('cc', ['-std=c11', '-O0', '-o', join(dir, 'repr_c'), src], { encoding: 'utf8' });
    check('cc', all, parse(execFileSync(join(dir, 'repr_c'), { encoding: 'utf8' })), t);
  });
}

// `zigModule` names its own nested structs, thus this checks the roots and
// leaves each nested struct to the comptime block inside its own file.
const roots: Named[] = CORPUS.map(({ name, type }) => ({ name, ty: type }));

if (!have('zig', ['version'])) {
  skip('zig agrees with our extern struct offsets', 'zig not found. The claim is unmeasured on this machine');
} else {
  group('zig agrees with our extern struct offsets', t => {
    const zdir = join(dir, 'zig');
    const r = runZig(writeZigCorpus(zdir), join(zdir, 'cache'));
    // A refusal here is a generator that emitted source zig will not take. That
    // measured nothing, and the harness counts it apart from a wrong number.
    if (!r.ok) throw new Error(`zig refused the generated source:\n${r.out}`);
    check('zig', roots, parse(r.out), t);
  });
}

// A schema may hold a field name that Zig reserves, or one that is no
// identifier at all. The corpus cannot carry those, because the Rust and C
// emitters above refuse them, so this schema is local to the Zig side.
const AWKWARD = struct({
  align: u32, error: u8, 'two words': u8, '0lead': u16,
}, 'Awkward');

if (!have('zig', ['version'])) {
  skip('zig reads a field name it reserves', 'zig not found. The claim is unmeasured on this machine');
} else {
  group('zig reads a field name it reserves', t => {
    const zdir = join(dir, 'zig-names');
    mkdirSync(zdir, { recursive: true });
    writeFileSync(join(zdir, 'Awkward.zig'), zigModule(AWKWARD));

    const body = Object.keys(AWKWARD.fields).map(f =>
      `    std.debug.print("F {s} {s} {d}\\n", .{ "Awkward", ${q(f)}, @offsetOf(m.Awkward, ${q(f)}) });`);
    const main = join(zdir, 'main.zig');
    writeFileSync(main, [
      'const std = @import("std");',
      'const m = @import("Awkward.zig");',
      '',
      'pub fn main() void {',
      '    std.debug.print("T {s} {d} {d}\\n", .{ "Awkward", @sizeOf(m.Awkward), @alignOf(m.Awkward) });',
      ...body,
      '}',
      '',
    ].join('\n'));

    const r = runZig(main, join(zdir, 'cache'));
    if (!r.ok) throw new Error(`zig refused the generated source:\n${r.out}`);
    check('zig', [{ name: 'Awkward', ty: AWKWARD }], parse(r.out), t);
  });
}

// Naming is pure computation, thus a compiler proves none of it. What a wrong
// name costs is a file that does not build, or two declarations that share one
// name and silently become one type.
group('zigModule names every struct once', t => {
  t.ok('the name argument overrides the struct name',
    zigModule(struct({ x: f32 }, 'Point'), 'Renamed').includes('pub const Renamed = extern struct'));

  t.throws('a name Zig cannot read is refused',
    () => zigModule(struct({ x: f32 })), /Zig cannot read the type name/);

  // `vec3(f32)` builds a new value at each call, so Particle holds two.
  const particle = zigModule(CORPUS[0]!.type, CORPUS[0]!.name);
  t.eq('one shape under one name emits one declaration',
    particle.match(/pub const vec3 = extern struct/g)?.length, 1);

  // The root is named before the walk, thus a struct below it yields.
  const inner = struct({ a: u8 }, 'Thing');
  const outer = zigModule(struct({ inner, b: u8 }, 'Thing'));
  t.ok('a struct below the root never takes the root name',
    outer.includes('pub const Thing_inner = extern struct') && outer.includes('pub const Thing = extern struct'));

  t.eq('two declarations, and neither name repeats',
    outer.match(/pub const (\w+) = extern struct/g)?.length, 2);
});

if (!have('zig', ['version'])) {
  skip('the emitted comptime block refuses a wrong number', 'zig not found. The claim is unmeasured on this machine');
} else {
  // The block is the whole reason to emit Zig rather than write it. A generated
  // file outlives the schema that made it, and the block is what refuses one the
  // schema has moved past. Thus it needs its own proof that it can fail.
  group('the emitted comptime block refuses a wrong number', t => {
    const zdir = join(dir, 'zig-wrong');
    mkdirSync(zdir, { recursive: true });
    const { name, type } = CORPUS[0]!;
    const src = zigModule(type, name);
    const m = measure(type);
    const last = layoutOf(type, name).nodes.at(-1)!;

    const cases: Array<[string, string, string]> = [
      ['size', `@sizeOf(${name}) != ${m.size}`, `@sizeOf(${name}) != ${m.size + 1}`],
      ['alignment', `@alignOf(${name}) != ${m.align}`, `@alignOf(${name}) != ${m.align * 2}`],
      ['offset',
        `@offsetOf(${name}, ${q(last.name)}) != ${last.offset}`,
        `@offsetOf(${name}, ${q(last.name)}) != ${last.offset + 1}`],
    ];

    for (const [what, from, to] of cases) {
      const broken = src.replace(from, to);
      t.ok(`the emitted source holds a ${what} check`, broken !== src, `found no ${q(from)}`);
      const file = join(zdir, `${what}.zig`);
      writeFileSync(file, `${broken}pub fn main() void {}\n`);
      const r = runZig(file, join(zdir, 'cache'));
      t.ok(`zig refuses a wrong ${what}`, !r.ok, 'the build succeeded');
      t.ok(`the refusal names ${name}`, r.out.includes(name), r.out.slice(0, 200));
    }
  });
}

rmSync(dir, { recursive: true, force: true });
report('repr.test.ts');
