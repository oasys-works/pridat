# Using pridat

You declare a layout. pridat computes every byte position, generates the code
that reads it, and hands you the table. You build your idiom on top.

Read this in order. Each part needs the one above it.

```ts
import { struct, vec3, f32, bool, accessors, Arena, pool, explain } from 'pridat'
```

Nothing is published yet. Until it is, import from `src/index.ts`.

## Declare a schema

A struct knows its own size. There is no separate define step.

```ts
const Particle = struct({
  pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool,
}, 'Particle')

Particle.size                    // 32, and that is the stride
Particle.offsetOf('vel.y')       // 16
type P = Row<typeof Particle>    // { pos: {x,y,z}, vel: {x,y,z}, mass, alive }
```

Name the struct. The name reaches every error and the generated code.

```ts
const Particle = struct({ /* ... */ })               // wrong, errors say "struct"
const Particle = struct({ /* ... */ }, 'Particle')   // right
```

A field path that does not exist fails to compile, and the error lists the paths
that do.

```ts
Particle.offsetOf('pos.q')   // wrong: not assignable to "pos.x" | "pos.y" | ...
```

Field order decides padding. Both of these match a C struct written the same way.

```ts
struct({ a: u8, b: u32, c: u8, d: f64 }, 'Ragged')   // 24 bytes, 10 hold nothing
struct({ d: f64, b: u32, a: u8, c: u8 }, 'Tidy')     // 16 bytes, 2 hold nothing
```

Order widest-first to drop padding. Keep the declaration order when a Rust or C
struct must match field for field.

## Look at the row

Print the byte map before you tune anything.

```ts
console.log(explain(Particle))
```

```
Particle - 32 B/row, align 4, 3 B padding (9.4%)

    off  size  field   type
      0     4  pos.x   f32
      ...
     28     1  alive   bool
     29     3  -- padding --
```

It names every leaf, every offset and every hole. `Particle.unaligned` names the
leaves off their natural alignment, which read through a DataView and are
slower.

## Read and write

Generate the accessors once, bind them to a buffer, then hoist.

```ts
const A = accessors(Particle)
const B = A.bind(new ArrayBuffer(Particle.size * N))

const getX = A.get['pos.x'], v = B.view['pos.x']   // hoist both, once
A.check(v, 0, N)                                   // guard, in the preheader

for (let p = 0; p < N * Particle.size; p += Particle.size) sum += getX(v, p)
```

Getters and setters are free functions taking `(view, ptr)`. Every other shape
costs.

Hoist the lookup out of the loop.

```ts
for (...) sum += A.get['pos.x'](B.view['pos.x'], p)   // wrong, two lookups a row
```

Move whole rows at the edges only. `read` allocates a row object.

```ts
for (...) sum += B.read(p).pos.x   // wrong, one object per row
for (...) sum += getX(v, p)        // right
```

Use `read` and `write` for a test, a serializer or a debugger.

Bound-check once, in the preheader.

```ts
for (...) { A.check(v, p, 1); sum += getX(v, p) }   // wrong, a throw site a row
```

`check` throws and `fits` returns a boolean. Both are free outside a loop.

Pass the view that belongs to the site. A crossed pair returns a plausible wrong
number, so the checker stops it.

```ts
A.get['pos.x'](B.view['alive'], p)   // wrong: View<"alive"> is not View<"pos.x">
```

Sites that share an access unit share one view object, so `pos.x` and `vel.z`
are the same array.

## Ask for less

Parse time grows with source size. A walk over two fields asks for two fields.

```ts
const A = accessors(Particle, { only: ['pos.x', 'mass'], row: false })
A.plan.omitted   // the six sites left out, named and never silent
```

`row: false` drops whole-row `read` and `write`, which touch every field.

## Wide fields and inline arrays

A 64-bit field reads as two 32-bit halves. It is never a BigInt.

```ts
const Ev = struct({ id: u64, t: f32 }, 'Ev')

const E = accessors(Ev)
E.set['id.lo'](B.view['id.lo'], p, lo)
E.set['id.hi'](B.view['id.hi'], p, hi)
```

Do not reach for `f64` instead. It loses data above 2^53 and gives no error.

An inline array is one site that takes one index for each dimension.

```ts
const Mesh = struct({ verts: array(vec3(f32), 3), lod: u8 }, 'Mesh')

const M = accessors(Mesh)
M.get['verts.x'](v, p, 1)   // right, element 1
M.get['verts.x'](v, p)      // wrong: expected 3 arguments, but got 2
```

Elements live in the row, not behind a pointer.

## Own the memory

One block, a bump pointer, and a declared growth policy.

```ts
const arena = new Arena({ bytes: 1 << 20 })
```

Reserve the peak. That is the default, and a full arena throws and names both
numbers.

Growth replaces the block and detaches the old one on purpose.

```ts
const arena = new Arena({ bytes: 1 << 16, growth: 'grow' })
```

Every view made before growth is dead. A dead typed array reads nothing, and a
dead DataView throws. Reading moved memory would be worse than either.

```ts
const v = B.view['pos.x']    // wrong on an arena that grows
arena.alloc(big)             // the block moved, v is dead
```

Compare `arena.epoch` and bind again when it moves. A pool does that for you.

## Hold rows

A pool holds one schema's rows, and its handles trap.

```ts
const p = pool(arena, Particle, { capacity: 10_000 })

const h = p.alloc()
p.write(h, { pos: {x:1,y:2,z:3}, vel: {x:0,y:0,z:0}, mass: 1, alive: true })
p.free(h)
p.ptr(h)   // throws: slot 0 was at generation 1 and is now at 2
```

A handle carries a generation above its slot, so a stale one stops instead of
reading a recycled row. `p.alive(h)` asks the same question without throwing.

A handle carries no pool identity. Two pools of one schema issue the same
numbers for the same history, so the wrong pool answers a foreign handle and
does not stop. The bits go to the generation instead, because that is what stops
a use after free. Keep a handle with the pool that issued it.

Walk the dense live list, not the handles.

```ts
const getX = p.get['pos.x'], v = p.view['pos.x']   // hoist, once
const rows = p.rows, n = p.count                   // hoist, once
for (let i = 0; i < n; i++) sum += getX(v, rows[i])
```

```ts
for (const h of handles) sum += getX(v, p.ptr(h))   // wrong, a check a row
```

The check belongs where a user hands you a handle. A walk that consumed no
handle owes nothing.

Hoist again after `alloc` or `free`. Both move entries in the list.

```ts
const rows = p.rows, n = p.count
p.free(h)                                  // wrong, n is now one too high
for (let i = 0; i < n; i++) getX(v, rows[i])
```

Entries above `count` are stale. The order is not allocation order, because
`free` swaps the last entry into the freed one. A walk sees each live row once,
in an order that changes.

`p.reset()` forgets every row. `arena.reset()` takes the bytes back, and every
pool over that arena must reset first.

## Cross a thread

What crosses is a description. No row is copied.

```ts
const arena = new Arena({ bytes: 1 << 24, shared: true })   // shared arenas reserve
const p = pool(arena, Particle, { capacity: 100_000 })
const b = barrier(arena, WORKERS)                           // count every party that arrives

for (let i = 0; i < WORKERS; i++) {
  worker[i].postMessage({ pool: p.share(), barrier: b.share(), ...p.slice(WORKERS, i) })
}
```

```ts
// in the worker
const p = attach<typeof Particle>(share)         // once for each worker
const b = attachBarrier(barrierShare)            // once for each worker
const getX = p.get['pos.x'], v = p.view['pos.x']

let sum = 0                                      // accumulate per thread
for (let i = from; i < to; i++) sum += getX(v, p.rows[i])
b.arrive()
```

The share holds the block, two byte offsets, the stride, and the accessors as
text. The worker needs no schema, no layout engine and no library.

Post the share, never the pool.

```ts
worker.postMessage(p)          // wrong, a pool does not survive the boundary
worker.postMessage(p.share())  // right
```

Build the arena shared. `share()` throws and says so otherwise.

Call `attach` once for each worker, not once for each step. It evaluates the
source text.

Slice on the owning thread while the pool is quiet. The owner knows when that
is, and the live count does not cross.

```ts
const range = p.slice(WORKERS, i)   // right, before the workers start
p.alloc()                           // wrong here, the range now describes the past
```

Keep `arrive` off a browser main thread. It blocks, which a worker may do and a
main thread may not. Use `arriveAsync`, or put the barrier in a coordinator
worker.

A barrier makes every round pay for its slowest worker. Coarse rounds keep that
cheap.

## Packed rows

Opt in only when a format demands it.

```ts
packed({ a: u8, b: u32 }, 'P')
```

Packing sets each alignment to 1. It breaks byte compatibility with a C struct.
It also forces a DataView on everything wider than a byte, which is slower.
Order the fields instead.

A pool aligns its base to what its stride can carry, which recovers typed access
for many packed rows. `p.report().dataview` names the sites that still fall to
DataView. One case no allocator reaches is a float at an odd offset. Only the
declaration reaches that one, by not packing, and it costs the padding.

## Where eval is forbidden

`accessors()`, `pool()` and `attach()` call `new Function`, which a
Content-Security-Policy can refuse. Generate the module ahead of time and hand
its exports back.

```ts
// build step
writeFileSync('particle.accessors.js',
  accessorModule(Particle, { ptrAlign: poolPtrAlign(Particle) }))
```

```ts
// run time, evaluating nothing
import * as generated from './particle.accessors.js'

const p = pool(arena, Particle, { capacity: 10_000, module: generated })
const w = bindShare(share, generated)                            // in the worker
```

The build step and the run time pass the same options, because the options
decide the code. `poolPtrAlign(Particle)` is the one a pool will prove: a pool
aligns its base to what the stride can carry, which is more than the layout's
own alignment for many schemas.

For accessors over your own buffer, generate with the options you will read
with, and pass them again.

```ts
accessorModule(Particle, { only: ['pos.x'] })                    // build step
accessorsFrom(Particle, generated, { only: ['pos.x'] })          // run time
```

```ts
accessorModule(Particle, { ptrAlign: poolPtrAlign(Particle) })   // wrong here
accessorsFrom(Particle, generated)                               // defaults to 4, and throws
```

`accessorSource()` is the other form, a `new Function` body. `accessors()`
evaluates it, `share()` sends it to a worker, and it feeds a code cache which
keys on source. Its tail is a bare `return`, so a file cannot hold it. Use
`accessorModule()` for a file.

A generated file outlives the schema that made it. Every entry point above
compares the module against the schema it was given and refuses one that has
moved.

```
accessorsFrom: Particle: the generated module does not match the schema it was
given. expected "size=40", got "size=32". Regenerate it.
```

## When it is slow

| Symptom | Look at |
|---|---|
| A field reads through a DataView | `Particle.unaligned`, then the field order or the packing |
| The walk is slower than plain objects | a check inside the loop, or a lookup not hoisted |
| A loop allocates | `read` or `write` inside it |
| Startup is slow | `only`, and `row: false` on a partial-field plan |
| A view reads nothing | the arena grew, so read `epoch` and bind again |
| Scaling stops with workers | round size, because a barrier waits for the slowest |
