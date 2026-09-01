// Does the published tarball work for somebody who installs it?
//
// Everything else in this suite runs the source. A consumer never sees the
// source. They see what `npm pack` produced, resolved through `exports`, with
// declarations that tsc reads instead of the `.ts` files. That is a different
// artifact, and this is where it gets checked.
//
// The tarball is built here rather than read from `dist`, because `npm pack`
// runs `prepack` and applies `files`. A file that the build emits and the
// manifest excludes is exactly the kind of thing this must catch.
//
// Three claims:
//
//   - Every entry point named in the manifest is in the tarball.
//   - Every source map resolves to a file the tarball ships. A map that names
//     a file nobody installed is worse than no map, because an editor follows
//     it and lands nowhere.
//   - The declarations typecheck under each module resolution a consumer picks,
//     and they pull in no `@types` package of their own.
//
// A toolchain that is absent is NAMED, never skipped in silence.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, report, skip } from './harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NAME: string = manifest.name;

// What a consumer writes. It touches one export from each part of the surface,
// so a declaration that fails to resolve shows up as a compile error here.
const CONSUMER = `
import {
  struct, vec3, f32, u8, u64, bool, str, array, packed,
  accessors, layoutOf, measure, explain, zigModule,
  Arena, pool, strings, attachStrings, EMPTY,
} from '${NAME}';
import type { Row, Layout, Str, SitePath, Accessors, StringsShare } from '${NAME}';

const Particle = struct({ pos: vec3(f32), mass: f32, alive: bool }, 'Particle');
const Item = struct({ id: u64, name: str, tags: array(u8, 4) }, 'Item');
const Tight = packed({ a: u8, b: f32 }, 'Tight');

const row: Row<typeof Particle> = { pos: { x: 1, y: 2, z: 3 }, mass: 4, alive: true };
const site: SitePath<typeof Particle> = 'pos.x';
const view: Layout = layoutOf(Particle, 'Particle');
const A: Accessors<typeof Particle.fields> = accessors(Particle);

const arena = new Arena({ bytes: 1 << 20 });
const p = pool(arena, Particle, { capacity: 8 });
const text = strings(arena, { bytes: 1024, capacity: 16 });
const h: Str = text.intern('x');
const share: StringsShare = text.share();

void [row, site, view, A, p, h, share, EMPTY, measure, explain, zigModule,
      attachStrings, Item, Tight];
`;

// Each mode a consumer is likely to set, and the module setting that goes with
// it. `types: []` is the check that the declarations need no `@types` package:
// tsc loads none, so a Node global leaking into the surface fails the compile.
const MODES: Array<[string, string]> = [
  ['node16', 'node16'],
  ['nodenext', 'nodenext'],
  ['bundler', 'esnext'],
];

const tsconfig = (resolution: string, module: string): string => JSON.stringify({
  compilerOptions: {
    target: 'es2022',
    lib: ['es2023', 'dom'],
    module,
    moduleResolution: resolution,
    strict: true,
    noEmit: true,
    types: [],
  },
  files: ['use.ts'],
}, null, 2);

// ---------------------------------------------------------------------------

const haveNpm = spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0;
const haveTsc = existsSync(tsc);

if (!haveNpm) {
  skip('the published tarball', 'npm not found. Nothing about the package is measured here');
  report('package.test.ts');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'pridat-pack-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  report('package.test.ts');
}

function run(dir: string): void {
  // `npm pack` runs prepack, thus this measures a fresh build and not whatever
  // `dist` happened to hold.
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const packed = JSON.parse(out)[0];
  const tarball = join(dir, packed.filename);

  // npm lays a package out under its own name, so the consumer below resolves
  // it the way a real install does, with no network and no registry.
  const home = join(dir, 'consumer');
  const installed = join(home, 'node_modules', ...NAME.split('/'));
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['xzf', tarball, '-C', installed, '--strip-components', '1']);

  const shipped = new Set<string>(packed.files.map((f: { path: string }) => normalize(f.path)));

  group('the tarball holds every entry point the manifest names', t => {
    const entries = [manifest.main, manifest.types, manifest.exports['.'].types,
      manifest.exports['.'].default, './package.json'];
    for (const e of entries) {
      const rel = normalize(String(e).replace(/^\.\//, ''));
      t.ok(`${e} is in the tarball`, shipped.has(rel), `not shipped: ${rel}`);
      t.ok(`${e} is on disk after install`, existsSync(join(installed, rel)), rel);
    }
  });

  group('every source map resolves to a file the tarball ships', t => {
    const maps = [...shipped].filter(f => f.endsWith('.map'));
    // A suite that finds no maps would pass this group while checking nothing.
    t.ok('the tarball carries maps to check', maps.length > 0, 'found none');
    for (const m of maps) {
      const { sources } = JSON.parse(readFileSync(join(installed, m), 'utf8'));
      for (const s of sources as string[]) {
        const target = normalize(join(dirname(m), s));
        t.ok(`${m} names a shipped source`, shipped.has(target), `${s} resolves to ${target}`);
      }
    }
  });

  group('the tarball carries the source and not the test helpers', t => {
    t.ok('src ships, so a map and a go-to-definition land on real source',
      [...shipped].some(f => f.startsWith(`src${'/'}`) || f.startsWith('src\\')),
      'no src in the tarball');
    // wasm-emit builds a module for one test. It has no dist counterpart and no
    // map names it, thus it is not source for this package.
    t.eq('the wasm test helper stays out',
      [...shipped].filter(f => f.includes('wasm-emit')), []);
  });

  if (!haveTsc) {
    skip('a consumer typechecks the declarations',
      'typescript is not installed. Every resolution claim is unmeasured');
    return;
  }

  // The package is ESM only, so the project that consumes it declares itself
  // ESM. Without this, node16 reads `use.ts` as CommonJS and refuses the import.
  writeFileSync(join(home, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(home, 'use.ts'), CONSUMER);
  group('a consumer typechecks the declarations, and needs no @types package', t => {
    for (const [resolution, module] of MODES) {
      writeFileSync(join(home, 'tsconfig.json'), tsconfig(resolution, module));
      const r = spawnSync(process.execPath, [tsc, '-p', join(home, 'tsconfig.json')], {
        encoding: 'utf8', cwd: home,
      });
      t.ok(`moduleResolution ${resolution} resolves the package`,
        r.status === 0, (r.stdout || r.stderr || '').split('\n').slice(0, 6).join('\n'));
    }
  });
}
