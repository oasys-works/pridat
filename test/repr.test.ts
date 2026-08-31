// Does our layout engine agree with the compilers it claims to be compatible with?
//
// "The layout is the interface" is only true if our idea of a byte position is
// the same as rustc's and cc's. That is a measurable claim, and rustc and cc are
// on this machine, so we measure it instead of asserting it. The emitters below
// are a checking tool, not a shipped feature.
//
// A toolchain that is absent is NAMED, never skipped in silence. An absent
// compiler means this claim is currently unmeasured.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutOf, measure } from '../src/index.ts';
import type { ArrayTy, Scalar, ScalarKind, StructTy, Ty } from '../src/index.ts';
import { CORPUS } from './corpus.ts';
import { group, report, skip } from './harness.ts';

const RUST: Record<ScalarKind, string> = {
  i8: 'i8', u8: 'u8', i16: 'i16', u16: 'u16', i32: 'i32', u32: 'u32',
  i64: 'i64', u64: 'u64', f32: 'f32', f64: 'f64', bool: 'bool',
};

const C: Record<ScalarKind, string> = {
  i8: 'int8_t', u8: 'uint8_t', i16: 'int16_t', u16: 'uint16_t',
  i32: 'int32_t', u32: 'uint32_t', i64: 'int64_t', u64: 'uint64_t',
  f32: 'float', f64: 'double', bool: 'bool',
};

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

interface Observed { size: Map<string, number>; align: Map<string, number>; offset: Map<string, number> }

function parse(out: string): Observed {
  const o: Observed = { size: new Map(), align: new Map(), offset: new Map() };
  let seen = 0;
  for (const line of out.split('\n')) {
    const t = line.match(/^T (\S+) (\d+) (\d+)$/);
    if (t) { o.size.set(t[1]!, +t[2]!); o.align.set(t[1]!, +t[3]!); seen++; continue; }
    const f = line.match(/^F (\S+) (\S+) (\d+)$/);
    if (f) { o.offset.set(`${f[1]}.${f[2]}`, +f[3]!); seen++; }
  }
  // A parser that finds nothing must fail loudly.
  if (seen === 0) throw new Error(`parsed no layout lines from compiler output:\n${out.slice(0, 500)}`);
  return o;
}

const have = (cmd: string): boolean => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'pridat-repr-'));
const seen = new Map<StructTy, string>();
const all: Named[] = [];
for (const { name, type } of CORPUS) collect(type, name, seen, all);

function check(lang: string, observed: Observed, t: import('./harness.ts').T): void {
  for (const { name, ty } of all) {
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
  skip('rustc agrees with our #[repr(C)] offsets', 'rustc not found — the claim is unmeasured on this machine');
} else {
  group('rustc agrees with our #[repr(C)] offsets', t => {
    const src = join(dir, 'repr.rs');
    writeFileSync(src, emitRust(all, seen));
    execFileSync('rustc', ['--edition', '2021', '-O', '-o', join(dir, 'repr_rs'), src], { encoding: 'utf8' });
    check('rustc', parse(execFileSync(join(dir, 'repr_rs'), { encoding: 'utf8' })), t);
  });
}

if (!have('cc')) {
  skip('cc agrees with our C offsets', 'cc not found — the claim is unmeasured on this machine');
} else {
  group('cc agrees with our C offsets', t => {
    const src = join(dir, 'repr.c');
    writeFileSync(src, emitC(all, seen));
    execFileSync('cc', ['-std=c11', '-O0', '-o', join(dir, 'repr_c'), src], { encoding: 'utf8' });
    check('cc', parse(execFileSync(join(dir, 'repr_c'), { encoding: 'utf8' })), t);
  });
}

rmSync(dir, { recursive: true, force: true });
report('repr.test.ts');
