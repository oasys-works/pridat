# pridat

**Primitive data types for JavaScript.**

pridat gives JavaScript three things a managed host forbids: a fixed layout,
copy-free parallelism, and memory safety. WebAssembly interoperability follows
from the first. If the layout is the interface, a boundary is a pointer and not
a translation.

It is not a framework. An entity-component system, a dataframe, a physics
engine and a WASM binding layer need one thing underneath. pridat is that thing.
It hands you a layout, an exact description of it, and the machinery to put
bytes in it. You build the API your system wants on top.

The corollary is that the field table is not an implementation detail we
tolerate exposing. It is the product.

## Install

```sh
npm install @oasys/pridat
```

Nothing is published yet. Until it is, clone this repository and import from
`src/index.ts`.

## Declare a layout

```ts
import { struct, vec3, f32, bool, accessors, type Row } from '@oasys/pridat'

const Particle = struct({
  pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool,
}, 'Particle')

Particle.size                    // 32, and that is the stride
Particle.offsetOf('vel.y')       // 16
type P = Row<typeof Particle>    // { pos: {x,y,z}, vel: {x,y,z}, mass, alive }
```

The row type comes from the schema value. You write the shape one time. A field
path that does not exist fails to compile, and the error lists the paths that
do.

## Read and write

Accessors are free functions taking `(view, ptr)`, generated for your schema on
the engine that runs them.

```ts
const A = accessors(Particle)
const B = A.bind(new ArrayBuffer(Particle.size * 1000))

const getX = A.get['pos.x'], v = B.view['pos.x']   // hoist both, once
A.check(v, 0, 1000)                                // guard, in the preheader

for (let p = 0; p < 1000 * Particle.size; p += Particle.size) sum += getX(v, p)
```

## Store rows

An arena owns the bytes. A pool holds one schema's rows and issues handles that
trap.

```ts
import { Arena, pool } from '@oasys/pridat'

const arena = new Arena({ bytes: 1 << 20 })
const p = pool(arena, Particle, { capacity: 10_000 })

const h = p.alloc()
p.write(h, { pos: {x:1,y:2,z:3}, vel: {x:0,y:0,z:0}, mass: 1, alive: true })
p.free(h)
p.ptr(h)                                           // throws, and names the slot

const getX = p.get['pos.x'], v = p.view['pos.x']   // hoist, once
const rows = p.rows, n = p.count                   // the live list, dense
for (let i = 0; i < n; i++) sum += getX(v, rows[i])
```

## Cross a thread

What crosses is a description. No row is copied.

```ts
const arena = new Arena({ bytes: 1 << 24, shared: true })
const p = pool(arena, Particle, { capacity: 100_000 })

worker.postMessage({ pool: p.share(), ...p.slice(WORKERS, i) })

// in the worker
const p = attach<typeof Particle>(share)
for (let i = from; i < to; i++) sum += p.get['pos.x'](p.view['pos.x'], p.rows[i])
```

The share holds the block, two byte offsets, the stride, and the accessors as
text. The block is a `SharedArrayBuffer`, so posting it copies nothing. The text
means the worker needs no schema, no layout engine and no library.

## Read next

| | |
|---|---|
| **[USAGE.md](USAGE.md)** | **Start here.** Every part in order, with the correct and the incorrect shape side by side. |
| [PHILOSOPHY.md](PHILOSOPHY.md) | Why this must exist, and how we work. |

## What is built

The schema, the layout engine, the accessor generator, the byte map, the arena,
the pool and the parallel layer. WebAssembly reads the same field table, and
`test/wasm.test.ts` runs both backends over one set of offsets.

Strings stay specified and unclaimed.

```
npm test    # three engines, plus rustc, cc and tsc
```

The suite emits the same schemas as Rust `#[repr(C)]` and as C, then compiles
both. It compares every size, alignment and field offset. `test/repr.test.ts` is
where that agreement is checked.

## The honest claims

Buffer-backed rows win on memory-bound, multi-field work, and they hold far less
memory. On branch-heavy work they are roughly a wash, and on one engine
fractionally behind plain objects. Raw single-threaded speed is real, it is
conditional, and it is not the headline.

The durable advantages are three things plain objects cannot do at any speed:

- a zero-copy WebAssembly bridge
- shared-memory parallelism
- a pause profile a collector cannot give you

Two cautions come with those. A naive WASM bridge is slower than never using
WASM at all. A barrier on every round costs far more than one round trip.

Each of these is a direction and not a measurement. They come from a substrate
study run over five engines, before the library they justify was written.

## License

MIT
