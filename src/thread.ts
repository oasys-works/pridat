// Pools over shared memory, and the barrier that sequences them.
//
// What crosses a thread boundary here is a description, never a row. The block
// is a `SharedArrayBuffer`, so posting it copies nothing, and the accessors
// cross as source text rather than as a schema: evaluating sent text costs a
// fraction of loading the library and generating them again, and a worker given
// the text needs no schema, no layout engine and no library at all.
//
// This file spawns nothing and owns no loop. A worker pool, a frame, and the
// decision of how many parties a step has are all the consumer's. What is here
// is the part a consumer cannot write correctly without the layout: the
// description of a pool, the reattachment on the other side, and a barrier.
//
// The division of labour follows from what a browser allows, not from what is
// fast. `Atomics.wait` throws on a browser main thread and is always legal in a
// worker, and `Atomics.waitAsync` costs the same order as blocking. So the
// barrier lives in a coordinator worker, every wait happens inside a worker,
// and the main thread never blocks. `arriveAsync` exists for the main thread
// that must wait anyway.
//
// One worker takes one slice of the live row list. The list holds byte
// pointers, and no two entries are equal, so two slices reach disjoint rows and
// no row needs a lock. The slices come from the owning thread, because it is
// the thread that knows when the pool is quiet.

import { Arena } from './arena.ts';
import { checkModuleSignature } from './codegen.ts';
import type { Getter, LeafView, SitePath, Setter, View } from './codegen.ts';

// ---------------------------------------------------------------------------
// A pool, described for another thread
// ---------------------------------------------------------------------------

/**
 * Everything a worker needs to read a pool's rows, and nothing that copies one.
 *
 * It is a plain object of numbers, one string and one buffer, so it survives
 * `postMessage` unchanged. Post it once for each worker. The rows and the live
 * list stay where they are.
 */
export interface PoolShare {
  /** Names the shape, so a worker can tell one message from another. */
  readonly kind: 'pridat.pool';
  readonly name: string;
  /** The arena's block. Shared, so posting it copies nothing. */
  readonly buffer: ArrayBufferLike;
  /** Byte offset of row zero. */
  readonly base: number;
  /** Byte offset of the live row list. */
  readonly listAt: number;
  readonly capacity: number;
  readonly stride: number;
  readonly ptrAlign: number;
  /** The generated accessors, as text. The worker evaluates this and no more. */
  readonly source: string;
  /**
   * What the owner's schema signs to. A worker has no schema and no layout
   * engine, so it cannot derive this. It compares two strings instead, which is
   * enough to refuse a generated module the schema has moved past.
   */
  readonly signature: string;
}

type LooseGetter = (view: LeafView, ptr: number, ...ix: number[]) => number | boolean;
type LooseSetter = (view: LeafView, ptr: number, ...args: number[]) => void;

/** The worker's half of a pool. `S` is the schema's type, which erases at run time. */
export type Attached<S> = {
  readonly name: string;
  /** Byte offset of row zero, for a reader that addresses rows itself. */
  readonly base: number;
  readonly stride: number;
  readonly capacity: number;
  /**
   * The live row list, over shared memory and the same entries the owner sees.
   *
   * Walk the range the owner sent. Entries outside it belong to another worker
   * or to nobody, and the count is not here on purpose: it changes on the
   * owning thread, and a worker that read it would be reading a number that
   * moved.
   */
  readonly rows: Uint32Array;
} & ([S] extends [never]
  ? {
    readonly get: Readonly<Record<string, LooseGetter>>;
    readonly set: Readonly<Record<string, LooseSetter>>;
    readonly view: Readonly<Record<string, LeafView>>;
  }
  : {
    readonly get: { readonly [K in SitePath<S>]: Getter<S, K> };
    readonly set: { readonly [K in SitePath<S>]: Setter<S, K> };
    readonly view: { readonly [K in SitePath<S>]: View<K> };
  });

interface Emitted {
  get: Record<string, LooseGetter>;
  set: Record<string, LooseSetter>;
  bind: (b: ArrayBufferLike) => { view: Record<string, LeafView> };
}

/**
 * Rebuild a pool's read surface on this thread. Call it one time for each
 * worker, not one time for each step.
 *
 * ```ts
 * // in the worker
 * const p = attach<typeof Particle>(share)          // once
 * const getX = p.get['pos.x'], v = p.view['pos.x']  // hoist
 * onmessage = ({ data: { from, to } }) => {         // each step
 *   let sum = 0
 *   for (let i = from; i < to; i++) sum += getX(v, p.rows[i])
 *   postMessage(sum)                                // accumulate per thread
 * }
 * ```
 *
 * The type argument is the schema's type and it erases, so importing it costs
 * the worker nothing at run time. Leave it off and the sites are string-keyed.
 *
 * This evaluates the source text with `new Function`. Where a
 * Content-Security-Policy forbids that, ship the text through a build step and
 * hand the module's exports to `bindShare` instead.
 */
export function attach<S = never>(share: PoolShare): Attached<S> {
  if (share?.kind !== 'pridat.pool') {
    throw new TypeError(
      `attach expects the object pool.share() returns. Got ${JSON.stringify(share?.kind)}.`,
    );
  }
  let mod: Emitted;
  try {
    mod = new Function(share.source)() as Emitted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof EvalError || /unsafe-eval|Content Security Policy|CSP/i.test(msg)) {
      throw new EvalError(
        `pridat: attach() needs \`new Function\`, which this environment forbids (${msg}). ` +
        `Evaluate the accessor source in a build step and call bindShare() with its exports.`,
      );
    }
    throw e;
  }
  return bindShare<S>(share, mod);
}

/**
 * `attach`, for a host that evaluated the source ahead of time.
 *
 * `mod` is what `accessorModule()` produced, imported. This is the whole of what
 * `attach` does once the text is a module, and it exists so that a
 * Content-Security-Policy costs a build step and not the parallel layer.
 *
 * It refuses a module the owner's schema has moved past, because a generated
 * file outlives the schema that made it and a stale one reads plausible wrong
 * numbers.
 */
export function bindShare<S = never>(share: PoolShare, mod: unknown): Attached<S> {
  checkModuleSignature(share.signature, share.name, mod, 'bindShare');
  const m = mod as Emitted;
  const bound = m.bind(share.buffer);
  return {
    name: share.name,
    base: share.base,
    stride: share.stride,
    capacity: share.capacity,
    rows: new Uint32Array(share.buffer, share.listAt, share.capacity),
    get: m.get,
    set: m.set,
    view: bound.view,
    // The generic is a claim about text that was generated from a schema, and
    // no value here carries the schema to prove it. The caller names the type
    // it asked the owner to share, and this trusts that name.
  } as unknown as Attached<S>;
}

// ---------------------------------------------------------------------------
// The barrier
// ---------------------------------------------------------------------------

/** Two `i32` in shared memory: the arrivals, and the sense the round runs at. */
const BARRIER_BYTES = 8;
const COUNT = 0;
const SENSE = 1;

/**
 * `Atomics.waitAsync` is ES2024 and this project compiles against ES2023, so
 * the one method it needs is named here rather than by widening the library.
 */
interface AtomicsAsync {
  waitAsync(
    ta: Int32Array, index: number, value: number,
  ): { async: true; value: Promise<'ok' | 'timed-out'> } | { async: false; value: 'not-equal' | 'timed-out' };
}

const hasWaitAsync = typeof (Atomics as Partial<AtomicsAsync>).waitAsync === 'function';

/** Everything a worker needs to join a barrier. Plain, so it posts unchanged. */
export interface BarrierShare {
  readonly kind: 'pridat.barrier';
  readonly buffer: ArrayBufferLike;
  readonly at: number;
  readonly parties: number;
}

/**
 * A sense-reversing barrier over shared memory.
 *
 * Every party calls `arrive`, and none returns until all have. The sense flips
 * on each round, so a party that is slow to leave one round cannot be counted
 * into the next.
 *
 * Put it in a coordinator worker. `arrive` blocks, which a worker may always do
 * and a browser main thread may never do. The overhead of a round is a small
 * fraction of a parallel step either way, so this is a rule about legality and
 * not about speed.
 */
export class Barrier {
  readonly parties: number;
  /** Byte offset of the barrier's two words inside the block. */
  readonly at: number;
  readonly #buffer: ArrayBufferLike;
  readonly #a: Int32Array;
  readonly #i: number;

  constructor(buffer: ArrayBufferLike, at: number, parties: number) {
    if (!Number.isInteger(parties) || parties < 1) {
      throw new RangeError(`barrier parties must be a positive integer, got ${parties}`);
    }
    if (!Number.isInteger(at) || at < 0 || at % 4 !== 0) {
      throw new RangeError(`barrier offset must be a non-negative multiple of 4, got ${at}`);
    }
    if (typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer)) {
      throw new TypeError(
        'a barrier needs shared memory, because a party on another thread has to see the ' +
        'arrivals. Build the arena with { shared: true }.',
      );
    }
    this.parties = parties;
    this.at = at;
    this.#buffer = buffer;
    this.#a = new Int32Array(buffer, 0, buffer.byteLength >> 2);
    this.#i = at >> 2;
  }

  /** Post this to each worker that will join. It copies nothing. */
  share(): BarrierShare {
    return { kind: 'pridat.barrier', buffer: this.#buffer, at: this.at, parties: this.parties };
  }

  /** Arrivals so far in the current round. For a report, never for a decision. */
  get waiting(): number { return Atomics.load(this.#a, this.#i + COUNT); }

  /**
   * Arrive, and block until every party has.
   *
   * Legal on a worker and never on a browser main thread. Use `arriveAsync`
   * there, or keep the barrier in a coordinator worker so that no main thread
   * ever waits.
   */
  arrive(): void {
    const a = this.#a, sense = this.#i + SENSE;
    const was = Atomics.load(a, sense);
    if (this.#last()) return;
    // A loop, not one wait. `Atomics.wait` may return before the value changes,
    // and the sense is what says the round is over.
    while (Atomics.load(a, sense) === was) {
      try {
        Atomics.wait(a, sense, was);
      } catch (e) {
        throw new TypeError(
          'Atomics.wait is forbidden on this thread, which is what a browser main thread does. ' +
          'Call arriveAsync here, or move the barrier into a coordinator worker so that no main ' +
          `thread waits at all. (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
  }

  /**
   * Arrive, and resolve when every party has. For a thread that may not block.
   *
   * It costs the same order as blocking, so choose between them on what the
   * thread is allowed to do rather than on what is quicker.
   */
  async arriveAsync(): Promise<void> {
    if (!hasWaitAsync) {
      throw new TypeError(
        'this host has no Atomics.waitAsync, so a thread that may not block cannot join a ' +
        'barrier here. Move the barrier into a coordinator worker, where blocking is legal.',
      );
    }
    const a = this.#a, sense = this.#i + SENSE;
    const was = Atomics.load(a, sense);
    if (this.#last()) return;
    while (Atomics.load(a, sense) === was) {
      const r = (Atomics as unknown as AtomicsAsync).waitAsync(a, sense, was);
      if (r.async) await r.value;
    }
  }

  /** Reset to a fresh round. The owning thread only, and only when nobody waits. */
  reset(): void {
    Atomics.store(this.#a, this.#i + COUNT, 0);
    Atomics.store(this.#a, this.#i + SENSE, 0);
  }

  /**
   * Count this arrival, and release the round if it was the last.
   *
   * The sense is stored before the notify, so a party that wakes for any other
   * reason still sees a round that ended.
   */
  #last(): boolean {
    const a = this.#a, count = this.#i + COUNT, sense = this.#i + SENSE;
    if (Atomics.add(a, count, 1) + 1 < this.parties) return false;
    Atomics.store(a, count, 0);
    Atomics.store(a, sense, Atomics.load(a, sense) ^ 1);
    Atomics.notify(a, sense);
    return true;
  }
}

/**
 * Reserve a barrier for `parties` in a shared arena.
 *
 * ```ts
 * const arena = new Arena({ bytes: 1 << 20, shared: true })
 * const b = barrier(arena, workers + 1)   // the coordinator counts as a party
 * worker.postMessage({ pool: p.share(), barrier: b.share() })
 * ```
 */
export function barrier(arena: Arena, parties: number): Barrier {
  if (!arena.shared) {
    throw new TypeError(
      'a barrier needs a shared arena, because a party on another thread has to see the ' +
      'arrivals. Build it with { shared: true }.',
    );
  }
  const at = arena.alloc(BARRIER_BYTES, 4);
  const b = new Barrier(arena.buffer, at, parties);
  b.reset();
  return b;
}

/** Rejoin a barrier on the thread that received its share. */
export function attachBarrier(share: BarrierShare): Barrier {
  if (share?.kind !== 'pridat.barrier') {
    throw new TypeError(
      `attachBarrier expects the object Barrier.share() returns. Got ${JSON.stringify(share?.kind)}.`,
    );
  }
  return new Barrier(share.buffer, share.at, share.parties);
}
