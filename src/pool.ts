// One schema's rows over an arena.
//
// The pool holds the stride, the free list, the handles it issues, and a dense
// list of its live rows. A row keeps its place for as long as it lives, so a
// handle stays one step from its bytes and no walk can observe a row move.
//
// Three placements here were measured before they were written:
//
//   - The generation lives in a side array, never in a header word inside the
//     row. A header word takes the row's first bytes or widens the stride, and
//     either one breaks the promise that an array of rows is byte-identical to
//     a Rust `[T; N]`. `test/repr.test.ts` is where that promise is checked.
//     The two placements cost the same, so the promise wins the argument for
//     free.
//   - A walk gets a dense list of live rows, not a liveness flag. Wherever a
//     hole exists the list wins on every engine, and its cost over a compacted
//     walk stays flat as the pool empties. A test on each row does not: it is a
//     guard per row rather than a guard in the preheader, and it reaches an
//     order of magnitude at three quarters dead.
//   - The free list needs no memory of its own. `#at` maps a live slot to its
//     place in the live list, and that word is dead for exactly as long as the
//     slot is. So the free list lives in it, and neither a side array nor four
//     bytes of stride is spent. Liveness moves to the generation's parity,
//     which is a word the pool already reads.
//
// The check belongs where a user hands us a handle. `alloc`, `free`, `ptr`,
// `read` and `write` all check, and all are the cold path. A loop over `rows`
// consumed no handle, so it owes nothing and pays nothing.

import { Arena } from './arena.ts';
import { accessors, accessorsFrom } from './codegen.ts';
import type { Accessors, Bound, ExpandOnly, Leaf64, SitePath } from './codegen.ts';
import type { Layout, Row, Struct } from './layout.ts';
import type { PoolShare } from './thread.ts';
import type { Fields } from './schema.ts';

/**
 * A row of a pool, and the generation it was issued at.
 *
 * It is one number: the generation above the slot. Both halves are read back
 * with arithmetic rather than with `>>>`, because the pair reaches past 2^32
 * and a 32-bit shift would drop the generation.
 *
 * Zero is never a live handle, so a zeroed field reads as absent.
 *
 * It carries no pool identity, and that is a limit worth stating. Two pools of
 * one schema issue the same numbers for the same history, so handing pool A a
 * handle from pool B reads A's row of the same slot and does not stop. The
 * generation is what the bits buy, and it is worth more: a pool identity wide
 * enough to be exact would take them from the generation, which is what stops a
 * use after free. `alive` and every check below answer about this pool's own
 * history and claim nothing wider.
 */
export type Handle = number;

/** Slots a pool can hold. The rest of a handle's 2^53 is generation. */
export const MAX_POOL_CAPACITY = 1 << 26;

const SLOT_SPAN = MAX_POOL_CAPACITY;

/**
 * The last generation a slot may reach.
 *
 * A slot that reaches it retires instead of recycling. Wrapping would hand a
 * second row the generation of a handle somebody still holds, which is the one
 * failure the generation exists to stop. A retired slot costs the pool one row
 * and keeps the promise exact.
 */
const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / SLOT_SPAN);

/**
 * The largest power of two that divides `n`, up to the widest access unit.
 *
 * The search stops at 8 because no access moves more than eight bytes, and it
 * divides rather than masking because a base offset reaches past 2^31 where
 * `n & -n` would return a signed result.
 */
function alignOf(n: number): number {
  if (n === 0) return 8;
  let a = 1;
  while (a < 8 && n % (a * 2) === 0) a *= 2;
  return a;
}

/**
 * The pointer alignment a `pool()` over `s` will prove, without building one.
 *
 * A build step needs this to generate accessors that make the same typed access
 * against DataView decision the pool would. It is a pure function of the
 * schema: the arena aligns the rows to what the stride can carry, so the base
 * never gives back less than that.
 */
export const poolPtrAlign = (s: Layout): number => alignOf(s.size);

export interface PoolOptions<K extends string = string> {
  /** Rows to reserve. The pool takes `capacity * stride` bytes from the arena, once. */
  readonly capacity: number;
  /** Emit accessors for these site paths only. See `AccessorOptions.only`. */
  readonly only?: readonly K[];
  /** Emit whole-row read and write. Default true. */
  readonly row?: boolean;
  /**
   * Use these exports instead of generating and evaluating the accessors here.
   *
   * For a host whose Content-Security-Policy forbids `new Function`. Generate
   * the text in a build step with `accessorModule(s, { ptrAlign: poolPtrAlign(s) })`
   * and import it. The pool refuses a module its schema has moved past.
   */
  readonly module?: unknown;
}

/** What the pool reserved, against what it holds. */
export interface PoolReport {
  readonly name: string;
  readonly capacity: number;
  /** Rows live now. */
  readonly live: number;
  /** Slots ever handed out. The pool's high-water mark. */
  readonly issued: number;
  /** Slots on the free list, waiting to be recycled. */
  readonly free: number;
  /** Slots that reached the last generation and will not be recycled. */
  readonly retired: number;
  readonly stride: number;
  readonly base: number;
  /** Arena bytes the rows take. */
  readonly bytes: number;
  /** Arena bytes the live list takes, beside the rows. */
  readonly listBytes: number;
  /** The alignment the pool proved for every row, and gave to the generator. */
  readonly ptrAlign: number;
  /** Site paths that fell to DataView, which is slower on two engine families. */
  readonly dataview: readonly string[];
}

export class Pool<F extends Fields, P extends string> {
  readonly arena: Arena;
  readonly layout: Struct<F>;
  readonly name: string;
  /** The distance to the next row, tail padding included. */
  readonly stride: number;
  readonly capacity: number;
  /** Byte offset of row zero, inside the arena's block. */
  readonly base: number;
  /**
   * The alignment every row of this pool holds.
   *
   * It is the largest power of two dividing both the base and the stride, and
   * it decides typed access against DataView at each site. The layout knows the
   * offsets and the strides above them. Only an allocator knows the third term,
   * which is why the pool derives this rather than letting the generator assume
   * the layout's own alignment. For a packed schema that assumption is 1, and it
   * drops an ordinary schema to DataView for no reason.
   */
  readonly ptrAlign: number;
  readonly accessors: Accessors<F, P>;

  /** Generation of each slot. Odd is live, even is dead. */
  readonly #gen: Uint32Array;
  /**
   * Two meanings over one word, and their lifetimes do not overlap.
   *
   * A live slot holds its index in `#rows`, so `free` is a swap-remove and not
   * a scan. A dead slot holds the next slot on the free list, or -1 to end it.
   * Liveness is never read from here. It is the parity of the generation.
   */
  readonly #at: Int32Array;
  /**
   * Byte pointers of the live rows, dense in `[0, count)`.
   *
   * It lives in the arena and not on the JS heap, because a worker takes a
   * slice of it and a worker can only reach the arena's block. The generation
   * and the free list stay on the heap: they are the owner's bookkeeping, and
   * nothing that crosses a thread boundary reads either.
   */
  #rows: Uint32Array;
  /** Byte offset of the live list inside the arena's block. */
  readonly listAt: number;

  #count = 0;
  #issued = 0;
  #freeHead = -1;
  #freeCount = 0;
  #retired = 0;

  #bound: Bound<F, P>;
  #boundAt: number;

  constructor(
    arena: Arena, layout: Struct<F>, ptrAlign: number,
    base: number, listAt: number, capacity: number, a: Accessors<F, P>,
  ) {
    this.arena = arena;
    this.layout = layout;
    this.name = layout.name;
    this.stride = layout.size;
    this.capacity = capacity;
    this.base = base;
    this.ptrAlign = ptrAlign;
    this.accessors = a;

    this.#gen = new Uint32Array(capacity);
    this.#at = new Int32Array(capacity);

    this.listAt = listAt;
    this.#rows = new Uint32Array(arena.buffer, listAt, capacity);
    this.#bound = a.bind(arena.buffer);
    this.#boundAt = arena.epoch;
  }

  /** Free `(view, ptr, ...indices)` getters, keyed by site path. */
  get get(): Accessors<F, P>['get'] { return this.accessors.get; }
  /** Free `(view, ptr, ...indices, value)` setters, keyed by site path. */
  get set(): Accessors<F, P>['set'] { return this.accessors.set; }

  /** Rows live now. `rows` is meaningful over `[0, count)` and stale above it. */
  get count(): number { return this.#count; }

  /**
   * The dense list of live rows, as byte pointers into the arena's block.
   *
   * This is the product. Hoist it and `count` into the preheader, then walk
   * `rows[i]` and pass it straight to a getter. It carries no multiply and no
   * base, so it does less work per row than the list this was measured as.
   *
   * Entries above `count` are stale, and reading one is a bug the pool cannot
   * catch. Entries below it are distinct, which is what lets `slice` hand
   * workers ranges that reach disjoint rows.
   *
   * The order is not the order rows were allocated in. `free` swaps the last
   * entry into the freed one, so a walk sees every live row exactly once and
   * sees them in an order that changes.
   */
  get rows(): Uint32Array { this.#rebound(); return this.#rows; }

  /**
   * The views the generated accessors read through, bound to the arena's block.
   *
   * Read this again after the arena's `epoch` moves. Growth replaces the block
   * and detaches the old one, so a view hoisted before growth is dead: it reads
   * nothing rather than reading a row that moved. This getter re-binds for you,
   * but a binding you hoisted into a loop is yours to refresh.
   */
  get view(): Bound<F, P>['view'] { return this.#rebound().view; }

  /** The bound block, the views, and the cold-path row moves. */
  get bound(): Bound<F, P> { return this.#rebound(); }

  #rebound(): Bound<F, P> {
    if (this.#boundAt !== this.arena.epoch) {
      this.#bound = this.accessors.bind(this.arena.buffer);
      this.#rows = new Uint32Array(this.arena.buffer, this.listAt, this.capacity);
      this.#boundAt = this.arena.epoch;
    }
    return this.#bound;
  }

  /**
   * Take a row. Cold path.
   *
   * The slot comes off the free list, or off the bump pointer when the list is
   * empty. Its bytes are whatever the last tenant left, so write every field
   * you intend to read.
   */
  alloc(): Handle {
    // The live list lives in the arena's block, so growth detaches it. A write
    // to a detached view reaches nobody and says nothing, thus the row would go
    // missing from every walk with no error anywhere.
    this.#rebound();

    let slot = this.#freeHead;
    if (slot >= 0) {
      this.#freeHead = this.#at[slot]!;
      this.#freeCount--;
    } else {
      if (this.#issued >= this.capacity) {
        throw new RangeError(
          `${this.name}: pool is full. It holds ${this.capacity} rows, ${this.#count} are live and ` +
          `${this.#retired} slots have retired. Reserve a larger capacity.`,
        );
      }
      slot = this.#issued++;
    }

    // Even to odd, which is dead to live. The generation the handle carries is
    // always the odd one, so a handle can never name a slot's dead state.
    const g = this.#gen[slot]! + 1;
    this.#gen[slot] = g;

    const i = this.#count++;
    this.#rows[i] = this.base + slot * this.stride;
    this.#at[slot] = i;
    return g * SLOT_SPAN + slot;
  }

  /**
   * Give a row back. Cold path.
   *
   * The row keeps its bytes and its place. What moves is one entry of the live
   * list, so the list stays dense and a walk never sees a hole.
   */
  free(h: Handle): void {
    // As `alloc`. A detached list also reads back undefined, and the swap-remove
    // below would then map a slot at NaN and leave a dead row in the list.
    this.#rebound();

    const slot = this.#slotOf(h, 'free');

    const i = this.#at[slot]!;
    const last = --this.#count;
    const moved = this.#rows[last]!;
    this.#rows[i] = moved;
    // Write the moved row's new place before the freed slot's word is reused by
    // the free list. When the freed row is the last one, these are the same
    // word, and the free list must have the final say.
    this.#at[(moved - this.base) / this.stride] = i;

    const g = this.#gen[slot]! + 1;
    this.#gen[slot] = g;
    if (g > MAX_GENERATION) {
      // Retire it. Recycling now would reissue a generation somebody may hold.
      this.#retired++;
      this.#at[slot] = -1;
    } else {
      this.#at[slot] = this.#freeHead;
      this.#freeHead = slot;
      this.#freeCount++;
    }
  }

  /** True if `h` names a live row of this pool. It does not throw. */
  alive(h: Handle): boolean {
    if (!Number.isInteger(h) || h <= 0 || h > Number.MAX_SAFE_INTEGER) return false;
    const slot = h % SLOT_SPAN;
    const g = (h - slot) / SLOT_SPAN;
    return slot < this.#issued && (g & 1) === 1 && this.#gen[slot] === g;
  }

  /**
   * The byte pointer of `h`'s row, checked. Cold path.
   *
   * A stale handle stops here and names the slot. Pass the result to a getter,
   * and hoist it out of any loop that reads the same row twice.
   */
  ptr(h: Handle): number {
    return this.base + this.#slotOf(h, 'read') * this.stride;
  }

  /** Copy a whole row out, checked. The cold path, and it allocates. */
  read(h: Handle): Row<Struct<F>> {
    return this.#rebound().read(this.ptr(h));
  }

  /** Copy a whole row in, checked. The cold path, as `read`. */
  write(h: Handle, row: Row<Struct<F>>): void {
    this.#rebound().write(this.ptr(h), row);
  }

  /**
   * Describe this pool to another thread. It copies no row.
   *
   * Post the result once for each worker, and call `attach` on the other side.
   * The block is shared, so posting it moves nothing, and the accessors travel
   * as text because a worker given the text needs no schema and no library.
   *
   * The live count is not in it. It changes on this thread, so the ranges go
   * out with the work: take them from `slice` while the pool is quiet, and post
   * a `{ from, to }` for each step.
   */
  share(): PoolShare {
    if (!this.arena.shared) {
      throw new TypeError(
        `${this.name}: this pool is over an arena that is not shared, so another thread would ` +
        'have to copy every row to read one. Build the arena with { shared: true }.',
      );
    }
    return {
      kind: 'pridat.pool',
      name: this.name,
      buffer: this.arena.buffer,
      base: this.base,
      listAt: this.listAt,
      capacity: this.capacity,
      stride: this.stride,
      ptrAlign: this.ptrAlign,
      source: this.accessors.source,
      signature: this.accessors.signature,
    };
  }

  /**
   * The `[from, to)` range of `rows` that worker `i` of `parts` takes.
   *
   * The ranges cover `[0, count)` with no gap and no overlap, and the entries
   * inside them are distinct, so two workers never reach one row. Take the
   * slice before the workers start: `alloc` and `free` both move entries, and a
   * range taken before one of those describes the list as it was.
   */
  slice(parts: number, i: number): { from: number; to: number } {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new RangeError(`slice parts must be a positive integer, got ${parts}`);
    }
    if (!Number.isInteger(i) || i < 0 || i >= parts) {
      throw new RangeError(`slice index must be an integer in [0, ${parts}), got ${i}`);
    }
    const n = this.#count;
    return { from: Math.floor((n * i) / parts), to: Math.floor((n * (i + 1)) / parts) };
  }

  /**
   * Forget every row. Every handle outstanding goes stale.
   *
   * It costs one pass over the slots this pool has issued, which is its
   * high-water mark and not its live count. The bump pointer does not rewind. A
   * slot's generation is the only thing keeping its old handles dead, and a
   * rewound slot would be handed out again with no memory of them.
   *
   * The arena keeps the bytes. Call `Arena.reset` to take those back, and call
   * it only once every pool over that arena has been reset too.
   */
  reset(): void {
    this.#count = 0;
    this.#freeHead = -1;
    this.#freeCount = 0;
    // Backwards, so the free list hands the slots back in the order they were
    // first issued. A pool reset each frame then walks the same rows in the
    // same order, which is the order the rows are laid out in.
    for (let slot = this.#issued - 1; slot >= 0; slot--) {
      const g = this.#gen[slot]!;
      const live = (g & 1) === 1;
      const next = live ? g + 1 : g;
      this.#gen[slot] = next;
      if (next > MAX_GENERATION) {
        // Already counted at `free` unless this slot is retiring right now.
        if (live) this.#retired++;
        continue;
      }
      this.#at[slot] = this.#freeHead;
      this.#freeHead = slot;
      this.#freeCount++;
    }
  }

  report(): PoolReport {
    return {
      name: this.name,
      capacity: this.capacity,
      live: this.#count,
      issued: this.#issued,
      free: this.#freeCount,
      retired: this.#retired,
      stride: this.stride,
      base: this.base,
      bytes: this.capacity * this.stride,
      listBytes: this.capacity * 4,
      ptrAlign: this.ptrAlign,
      dataview: this.accessors.plan.sites.filter(s => s.via === 'dataview').map(s => s.path),
    };
  }

  /** Decode a handle and prove it names a live row of this pool's own history. */
  #slotOf(h: Handle, verb: string): number {
    if (!Number.isInteger(h) || h <= 0 || h > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(
        `${this.name}: cannot ${verb} ${h}. A handle is a positive integer below 2^53.`,
      );
    }
    const slot = h % SLOT_SPAN;
    const g = (h - slot) / SLOT_SPAN;
    if (slot >= this.#issued) {
      throw new RangeError(
        `${this.name}: cannot ${verb} handle ${h}. It names slot ${slot}, and this pool has ` +
        `issued ${this.#issued} of ${this.capacity}.`,
      );
    }
    const now = this.#gen[slot]!;
    if ((g & 1) !== 1 || now !== g) {
      throw new RangeError(
        `${this.name}: cannot ${verb} handle ${h}. Slot ${slot} was at generation ${g} and is now ` +
        `at ${now}. That row was freed.`,
      );
    }
    return slot;
  }
}

/**
 * Reserve `capacity` rows of `s` in `arena`, and generate the accessors for them.
 *
 * ```ts
 * const arena = new Arena({ bytes: 1 << 20 })
 * const p = pool(arena, Particle, { capacity: 10_000 })
 *
 * const h = p.alloc()
 * p.set['pos.x'](p.view['pos.x'], p.ptr(h), 1.5)
 *
 * const getX = p.get['pos.x'], v = p.view['pos.x']   // hoist, once
 * const rows = p.rows, n = p.count                   // hoist, once
 * for (let i = 0; i < n; i++) sum += getX(v, rows[i])
 * ```
 *
 * The base is aligned to the largest power of two the stride can carry, and the
 * accessors are generated against that. So an ordinary schema keeps typed
 * access, which it loses when the generator assumes the layout's own alignment.
 * One case stays out of reach: no base alignment moves a float that sits at an
 * odd offset inside a packed row. Only the declaration reaches that one, by not
 * being packed, and it costs the padding.
 */
export function pool<
  const F extends Fields,
  const K extends SitePath<Struct<F>> | Leaf64<Struct<F>> = SitePath<Struct<F>>,
>(arena: Arena, s: Struct<F>, opts: PoolOptions<K>): Pool<F, ExpandOnly<Struct<F>, K>> {
  const { capacity } = opts;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`pool capacity must be a positive integer, got ${capacity}`);
  }
  if (capacity > MAX_POOL_CAPACITY) {
    throw new RangeError(
      `pool capacity must not exceed ${MAX_POOL_CAPACITY}, got ${capacity}. A handle carries the ` +
      `slot below the generation, and both must stay inside 2^53.`,
    );
  }
  if (s.size === 0) {
    throw new RangeError(
      `${s.name} occupies no bytes, so a pool of its rows has nothing to hand out. Give it a field.`,
    );
  }

  const stride = s.size;
  const want = alignOf(stride);
  const base = arena.alloc(stride * capacity, want);
  // The live list follows the rows in the same block. A worker reaches the
  // arena and nothing else, so a list on the JS heap could not be sliced across
  // a thread. The rows come first, so their base carries the alignment the
  // stride can hold rather than whatever the list left behind.
  const listAt = arena.alloc(capacity * 4, 4);
  // Derive it from the base the arena actually gave, rather than from the one
  // that was asked for. The two agree today, and this keeps agreeing if the
  // arena's placement ever changes.
  const ptrAlign = Math.min(alignOf(base), want);

  // Built up rather than written whole, because `exactOptionalPropertyTypes`
  // separates an absent option from one that is present and undefined.
  const ao: { only?: readonly K[]; row?: boolean; ptrAlign: number } = { ptrAlign };
  if (opts.only !== undefined) ao.only = opts.only;
  if (opts.row !== undefined) ao.row = opts.row;

  const a = opts.module === undefined ? accessors(s, ao) : accessorsFrom(s, opts.module, ao);
  return new Pool(arena, s, ptrAlign, base, listAt, capacity, a as Accessors<F, ExpandOnly<Struct<F>, K>>);
}
