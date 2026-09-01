// Runs the library suite, one process per file, and says what it ran.
//
// The shape of this file follows the study runner, and so do its rules:
//
//   - A CRASH IS NOT A FAILURE. A file that dies before printing a result has
//     measured nothing, which is not the same as a check that came out false.
//     They are counted separately and both set a non-zero exit code.
//   - AN ABSENT ENGINE OR TOOLCHAIN IS NAMED. Silence would read as coverage.
//   - The summary prints the assertion count, because a suite that does not say
//     how much it ran cannot be distinguished from one that ran nothing.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Portable: pure computation and WebAssembly, so a second engine can disagree.
const PORTABLE = [
  ['layout.test.ts', 'layout engine: offsets, padding, alignment, inline arrays'],
  ['wasm.test.ts', 'one layout, two backends: JS and WASM over the same offsets'],
  ['codegen.test.ts', 'generated accessors, against an oracle and against their own rules'],
  ['pool.test.ts', 'the arena and the pool: alignment, handles, and a dense live list'],
  ['thread.test.ts', 'pools over shared memory: what crosses, and the barrier'],
  ['strings.test.ts', 'interned UTF-8: the handle in the row, and the text in the arena'],
];

// Host-bound: these drive rustc, cc, zig, npm or tsc, which do not change with
// the JS engine that launched them. Running them three times would add no information.
const HOST = [
  ['types.test-d.ts', 'the type layer, checked by tsc'],
  ['repr.test.ts', 'byte compatibility with Rust #[repr(C)], C and Zig extern struct'],
  ['package.test.ts', 'the published tarball: entry points, maps, and a consumer typecheck'],
];

function version(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

const engines = [{ name: 'node', cmd: process.execPath, args: [], label: `node ${process.version} (V8)` }];
const bun = version('bun', ['--version']);
if (bun) engines.push({ name: 'bun', cmd: 'bun', args: [], label: `bun ${bun} (JavaScriptCore)` });
const deno = version('deno', ['--version']);
if (deno) {
  engines.push({
    name: 'deno', cmd: 'deno',
    args: ['run', '--quiet', '--allow-read', '--allow-env'],
    label: `${deno} (V8)`,
  });
}

const absent = [];
if (!bun) absent.push('bun (JavaScriptCore)');
if (!deno) absent.push('deno (V8)');
// The jsc and spidermonkey shells run every portable probe in the study and
// none of these files, because these are TypeScript and a shell has no loader
// for it. That is a property of the suite, not a missing engine, and saying
// "not present" about them would read as an accident.
const shells = 'the jsc and spidermonkey shells cannot run these files: they are TypeScript';

let passed = 0, failed = 0, errored = 0;
const crashed = [];
const skipped = [];
let files = 0;

function run(engine, file, desc) {
  files++;
  let out;
  try {
    out = execFileSync(engine.cmd, [...engine.args, join(here, file)], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    if (!/^RESULT /m.test(out)) {
      console.error(`\n!! ${file} on ${engine.name} (${desc}) CRASHED:\n${out}`);
      crashed.push(`${file} on ${engine.name}`);
      return;
    }
  }
  const line = out.match(/^RESULT (.*)$/m);
  if (!line) {
    // A parser that finds nothing must fail loudly.
    console.error(`\n!! ${file} on ${engine.name} produced no RESULT line:\n${out}`);
    crashed.push(`${file} on ${engine.name}`);
    return;
  }
  const r = JSON.parse(line[1]);
  passed += r.passed; failed += r.failed; errored += r.errors;
  for (const s of r.skipped) skipped.push(`${s} [${engine.name}]`);

  const noise = out.split('\n').filter(l => l && !l.startsWith('RESULT ')).join('\n');
  const mark = r.failed || r.errors ? 'FAIL' : ' ok ';
  console.log(`[${mark}] ${engine.name.padEnd(4)} ${file.padEnd(18)} ${String(r.passed).padStart(4)} assertions  ${desc}`);
  if (noise) console.log(noise);
}

console.log('pridat library suite\n');
for (const [file, desc] of PORTABLE) for (const engine of engines) run(engine, file, desc);
for (const [file, desc] of HOST) run(engines[0], file, desc);

console.log(`\n${'='.repeat(72)}`);
console.log(`suite complete. ${passed} assertions over ${files} runs, ${failed} failed, ${errored} error(s)`);
console.log(`engines: ${engines.map(e => e.label).join('; ')}`);
if (absent.length) console.log(`not present, so unmeasured here: ${absent.join(', ')}`);
console.log(shells);
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
if (crashed.length) {
  console.log(`\nERROR: ${crashed.length} run(s) CRASHED and produced no result: ${crashed.join(', ')}`);
  console.log('A crash is not a failure. Whatever those runs cover is currently unmeasured.');
}
if (failed || errored || crashed.length) process.exitCode = 1;
