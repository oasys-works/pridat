// A test harness that says out loud how many assertions it ran.
//
// PHILOSOPHY Part II §14: two experiments in this repository sat crashing for
// several rounds while the runner printed success, because it counted an error
// the same way it counted a refuted hypothesis. So this harness reports three
// numbers and never merges them: assertions passed, assertions failed, and
// groups that threw before they could finish asserting.
//
// Something absent is NAMED, never skipped silently. `skip()` prints its reason
// and is reported in the summary.

import { isDeepStrictEqual } from 'node:util';

export interface T {
  /** Deep equality. */
  eq(claim: string, actual: unknown, expected: unknown): void;
  ok(claim: string, cond: boolean, detail?: string): void;
  throws(claim: string, fn: () => unknown, match?: RegExp): void;
}

let passed = 0;
let failed = 0;
const errors: string[] = [];
const skipped: string[] = [];
const failures: string[] = [];

function fail(claim: string, detail: string): void {
  failed++;
  failures.push(`${claim}\n         ${detail}`);
  console.log(`  [FAIL] ${claim}\n         ${detail}`);
}

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 0) ?? String(v);
  return s.length > 300 ? s.slice(0, 297) + '...' : s;
};

export function group(name: string, body: (t: T) => void): void {
  const before = passed + failed;
  const t: T = {
    eq(claim, actual, expected) {
      if (isDeepStrictEqual(actual, expected)) passed++;
      else fail(`${name}: ${claim}`, `expected ${show(expected)}, got ${show(actual)}`);
    },
    ok(claim, cond, detail = '') {
      if (cond) passed++;
      else fail(`${name}: ${claim}`, detail || 'condition was false');
    },
    throws(claim, fn, match) {
      try {
        fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!match || match.test(msg)) { passed++; return; }
        fail(`${name}: ${claim}`, `threw, but message did not match ${match}: ${show(msg)}`);
        return;
      }
      fail(`${name}: ${claim}`, 'did not throw');
    },
  };

  try {
    body(t);
  } catch (e) {
    // A group that throws stopped asserting. Whatever it was going to check is
    // now unmeasured, and that is not the same as a check that failed.
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    errors.push(`${name}: ${msg}`);
    console.log(`  [ERROR] ${name} threw before it finished\n${msg}`);
    return;
  }

  const n = passed + failed - before;
  if (n === 0) {
    // A group that asserts nothing looks like a group that passed.
    errors.push(`${name}: ran no assertions`);
    console.log(`  [ERROR] ${name} ran no assertions`);
  }
}

/** Name what did not run, and why. Never skip in silence. */
export function skip(name: string, reason: string): void {
  skipped.push(`${name} (${reason})`);
  console.log(`  [SKIP] ${name} — ${reason}`);
}

/** Print the machine-readable result line and set the exit code. */
export function report(file: string): void {
  console.log(`RESULT ${JSON.stringify({
    file, passed, failed, errors: errors.length, skipped,
  })}`);
  if (failed > 0 || errors.length > 0) process.exitCode = 1;
}
