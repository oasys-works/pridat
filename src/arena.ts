// The arena owns the memory. Everything above it borrows.
//
// One block, one bump pointer, and a reset that is one store. It hands out byte
// offsets and never views. A view outlives the block that made it, and a view
// onto memory that moved is the worst failure this library can have.
//
// Two constraints here come from measurement, and this file does not negotiate
// them:
//
//   - The block is never resizable. A resizable `ArrayBuffer` charges its
//     reader on every access, and a growable `SharedArrayBuffer` read through a
//     length-tracking view charges far more than that. The charge lands even
//     when the view has a fixed length, so it is the buffer being growable that
//     costs, not the view tracking it.
//   - A shared arena reserves and never grows. Another thread holds the block,
//     and nothing here can replace it under that thread.
//
// Where growth is declared, it allocates a new block, moves the bytes, and
// detaches the old one. A view built before growth then reads nothing, instead
// of reading plausible bytes at an address that moved. `epoch` counts the
// moves, so a consumer knows when to bind again.

/**
 * The ceiling on one arena, and it is the WASM ceiling.
 *
 * A pool addresses its rows with a `u32`, and a WASM memory32 addresses the same
 * range. The layout is the contract both sides read, so the arena stops where
 * the narrower of the two stops rather than where JavaScript would.
 */
export const MAX_ARENA_BYTES = 0x1_0000_0000;

/**
 * What the arena does when a request does not fit.
 *
 * `reserve` throws and names both numbers. It is the default, because growth is
 * a memory decision and the caller should make it in the open. Sizing to a
 * declared peak so that nothing ever doubles costs resident memory and costs
 * nothing in speed.
 *
 * `grow` allocates a new block, moves the bytes and detaches the old block.
 * Every view made before that moment stops working, by design.
 */
export type Growth = 'reserve' | 'grow';

export interface ArenaOptions {
  /** Bytes to reserve up front. Rounded up to the alignment of the first request. */
  readonly bytes: number;
  /** Back the arena with a `SharedArrayBuffer`. A shared arena cannot grow. */
  readonly shared?: boolean;
  /** Default `reserve`. See `Growth`. */
  readonly growth?: Growth;
  /** Ceiling for `grow`. Defaults to `MAX_ARENA_BYTES`. */
  readonly max?: number;
}

/** What the arena reserved, against what it uses. */
export interface ArenaReport {
  readonly reserved: number;
  readonly used: number;
  readonly free: number;
  /** Bytes skipped to align a request. They are reserved and unreachable. */
  readonly padding: number;
  readonly shared: boolean;
  readonly growth: Growth;
  /** Blocks allocated. One means the arena never moved. */
  readonly blocks: number;
  /** Moves so far. A bound view is stale unless this matches what it was bound at. */
  readonly epoch: number;
}

const isPow2 = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/**
 * Round `n` up to a multiple of `a`, in arithmetic rather than in bit operations.
 *
 * An arena reaches past 2^31, where `&` truncates to a signed 32-bit result and
 * would return a smaller address than it was given. This runs once for each
 * allocation, which is a cold path.
 */
const alignUp = (n: number, a: number): number => {
  const r = n % a;
  return r === 0 ? n : n + (a - r);
};

/**
 * The one ES2024 method this file needs, named here rather than by widening the
 * library for every file. `transfer` moves the bytes into a new block and
 * detaches the old one, and the detach is the reason it is used at all.
 */
interface MovableBuffer { transfer(newByteLength: number): ArrayBuffer }

const canDetach = typeof (ArrayBuffer.prototype as Partial<MovableBuffer>).transfer === 'function';

export class Arena {
  #buffer: ArrayBufferLike;
  #used = 0;
  #padding = 0;
  #blocks = 1;
  #epoch = 0;

  readonly shared: boolean;
  readonly growth: Growth;
  readonly max: number;

  constructor(opts: ArenaOptions) {
    const { bytes, shared = false, growth = 'reserve', max = MAX_ARENA_BYTES } = opts;

    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(`arena bytes must be a non-negative integer, got ${bytes}`);
    }
    if (bytes > MAX_ARENA_BYTES) {
      throw new RangeError(
        `arena bytes must not exceed ${MAX_ARENA_BYTES}, got ${bytes}. A pool addresses its rows ` +
        `with a u32, and so does a WASM memory32.`,
      );
    }
    if (!Number.isInteger(max) || max < bytes || max > MAX_ARENA_BYTES) {
      throw new RangeError(
        `arena max must be an integer between the reservation and ${MAX_ARENA_BYTES}, got ${max}`,
      );
    }
    if (shared && growth === 'grow') {
      throw new RangeError(
        'a shared arena cannot grow. Another thread holds the block, and growth replaces it. ' +
        'Reserve the peak instead, or keep the arena unshared.',
      );
    }
    if (growth === 'grow' && !canDetach) {
      throw new RangeError(
        'this host has no ArrayBuffer.prototype.transfer, so growth cannot detach the block it ' +
        'replaces and a view made before growth would keep reading moved memory. Use ' +
        "growth: 'reserve'.",
      );
    }
    if (shared && typeof SharedArrayBuffer === 'undefined') {
      throw new RangeError(
        'this host has no SharedArrayBuffer, so a shared arena cannot be made. Cross-origin ' +
        'isolation turns it on in a browser.',
      );
    }

    this.shared = shared;
    this.growth = growth;
    this.max = max;
    this.#buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  }

  /**
   * The block. Bind accessors to it, and post it to a worker if it is shared.
   *
   * It is replaced by growth. Read it again after `epoch` moves, and never hold
   * it across an allocation on an arena that grows.
   */
  get buffer(): ArrayBufferLike { return this.#buffer; }

  get reserved(): number { return this.#buffer.byteLength; }
  get used(): number { return this.#used; }

  /**
   * Moves so far, and zero until the first one.
   *
   * A consumer that holds views compares this with the value it bound at. They
   * differ exactly when the views are stale.
   */
  get epoch(): number { return this.#epoch; }

  /**
   * Reserve `bytes`, aligned to `align`, and return the byte offset.
   *
   * This is the cold path. A pool allocates its rows one time and then addresses
   * them itself.
   *
   * The offset is stable for the life of the block. Growth moves the block and
   * keeps every offset, so a pool never re-bases and only re-binds.
   */
  alloc(bytes: number, align = 1): number {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(`allocation size must be a non-negative integer, got ${bytes}`);
    }
    if (!isPow2(align)) {
      throw new RangeError(`allocation alignment must be a positive power of two, got ${align}`);
    }

    const p = alignUp(this.#used, align);
    const end = p + bytes;

    if (end > this.reserved) {
      if (this.growth === 'reserve') {
        throw new RangeError(
          `arena is full. ${bytes} bytes aligned to ${align} need ${end - this.#used} more than ` +
          `the ${this.reserved - this.#used} left of a ${this.reserved} byte reservation. ` +
          "Reserve more up front, or declare growth: 'grow'.",
        );
      }
      this.#moveTo(end);
    }

    this.#padding += p - this.#used;
    this.#used = end;
    return p;
  }

  /**
   * Take every byte back. One store.
   *
   * Nothing is zeroed, so a pool over this arena must forget its rows in the
   * same breath. `Pool.reset` does that, and this does not reach up to it.
   */
  reset(): void { this.#used = 0; this.#padding = 0; }

  report(): ArenaReport {
    return {
      reserved: this.reserved,
      used: this.#used,
      free: this.reserved - this.#used,
      padding: this.#padding,
      shared: this.shared,
      growth: this.growth,
      blocks: this.#blocks,
      epoch: this.#epoch,
    };
  }

  /**
   * Double until `need` fits, then move.
   *
   * Doubling is what makes growth cost resident memory: the pages of every block
   * along the way are already faulted, so they stay resident. That cost is why
   * `reserve` is the default and why `blocks` is reported.
   */
  #moveTo(need: number): void {
    let next = Math.max(this.reserved, 1);
    while (next < need) next *= 2;
    if (next > this.max) next = this.max;
    if (next < need) {
      throw new RangeError(
        `arena cannot grow past its declared max of ${this.max} bytes, and ${need} bytes are ` +
        `now in use. Raise max, or reserve the peak up front.`,
      );
    }

    // `transfer` moves the bytes and detaches the source in one step. The
    // detach is the point: a typed array over the old block then reads
    // undefined and a DataView over it throws, where a plain copy would leave
    // both reading a stale row that looks correct.
    this.#buffer = (this.#buffer as unknown as MovableBuffer).transfer(next);
    this.#blocks++;
    this.#epoch++;
  }
}
