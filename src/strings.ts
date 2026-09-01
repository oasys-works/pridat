// The string table: interned UTF-8 in the arena, plus a decode cache.
//
// A JS string is UTF-16, immutable and owned by the collector. A row cannot
// hold one, thus a row holds a handle and this table holds the bytes. The
// handle is a `u32`, so a `str` field is byte-identical to a Rust or Zig `u32`
// and the row keeps its exact layout.
//
// Two properties come out of interning, and they are the reason for it:
//
//   - Equality is a word compare. Two rows holding the same text hold the same
//     handle, so a filter never touches a byte of the blob.
//   - The bytes live in the arena. A worker attaches the same block and reads
//     the same string with no copy.
//
// One property does not come out of it. Materializing a JS string back out
// costs a decode, and a decode is far more expensive than holding a reference.
// The cache below hides that only when the same handles come back on a later
// pass. Within one pass over strings that are mostly distinct, this table is
// slower than holding JS strings and it will stay slower. Hold JS strings for a
// one-shot render, and use this where the same text is read again.
//
// Interning needs a hash of the text, which is a JS `Map` and cannot cross a
// thread. Thus the owner interns and a worker only reads. `attachStrings` says
// so, and `intern` on an attached table throws instead of forking the table.

import type { Arena } from './arena.ts';
import type { Str } from './schema.ts';

/** The empty string. A zeroed field reads as this, and never as a handle nobody issued. */
export const EMPTY: Str = 0;

/** Handles one table can issue. The rest of a `u32` is not addressable as a span pair. */
export const MAX_STRINGS = 1 << 26;

// The shared header, as `u32` indices. Both cross a thread, so both are read
// and written with `Atomics`. A worker that sees a count also sees the span and
// the bytes under it, because those stores precede the count store.
const COUNT = 0;
const USED = 1;
const HEAD_WORDS = 2;

export interface StringsOptions {
  /** Bytes reserved for the UTF-8 blob. The table takes them from the arena once. */
  readonly bytes: number;
  /** Distinct strings reserved. Each takes one offset and one length in the span table. */
  readonly capacity: number;
  /** Names the table in errors. It changes no bytes. */
  readonly name?: string;
}

/** What the table reserved, against what it holds. */
export interface StringsReport {
  readonly name: string;
  readonly capacity: number;
  /** Distinct strings interned, the empty string included. */
  readonly count: number;
  readonly bytes: number;
  /** Blob bytes written. */
  readonly used: number;
  readonly free: number;
  /** Handles whose text this thread has materialized and kept. */
  readonly cached: number;
  /** False on a table reached through `attachStrings`. Such a table cannot intern. */
  readonly writer: boolean;
}

export interface StringsShare {
  /** Names the shape, so a worker can tell one message from another. */
  readonly kind: 'pridat.strings';
  readonly name: string;
  /** The arena's block. Shared, so posting it copies nothing. */
  readonly buffer: ArrayBufferLike;
  readonly headAt: number;
  readonly spansAt: number;
  readonly blobAt: number;
  readonly capacity: number;
  readonly bytes: number;
}

/**
 * Interned UTF-8, addressed by handle.
 *
 * Build one with `strings(arena, ...)`. Hold it beside the pool whose rows name
 * it, because a `str` field carries the handle and nothing else knows the table
 * it came from.
 */
export class Strings {
  readonly name: string;
  readonly capacity: number;
  readonly bytes: number;
  readonly headAt: number;
  readonly spansAt: number;
  readonly blobAt: number;
  /** False on an attached table. It reads and never interns. */
  readonly writer: boolean;

  /** Null on an attached table. The hash of the text cannot cross a thread. */
  readonly #index: Map<string, Str> | null;

  /**
   * Text this thread has already materialized, indexed by handle.
   *
   * It holds JS strings, which the collector owns, thus it is the one place
   * this library gives memory back to the host. It is bounded by the count of
   * distinct strings and never by the count of reads, which is what keeps it
   * from growing with the work.
   */
  readonly #cache: (string | undefined)[];

  #head: Uint32Array;
  #spans: Uint32Array;
  #blob: Uint8Array;

  /** Null until the first decode. `TextDecoder` is not free to construct. */
  #decoder: TextDecoder | null = null;
  #encoder: TextEncoder | null = null;

  #arena: Arena | null;
  #buffer: ArrayBufferLike;
  #boundAt: number;
  #cached = 0;

  constructor(
    arena: Arena | null, buffer: ArrayBufferLike, name: string,
    headAt: number, spansAt: number, blobAt: number, capacity: number, bytes: number,
  ) {
    this.name = name;
    this.capacity = capacity;
    this.bytes = bytes;
    this.headAt = headAt;
    this.spansAt = spansAt;
    this.blobAt = blobAt;
    this.writer = arena !== null;

    this.#arena = arena;
    this.#buffer = buffer;
    this.#boundAt = arena ? arena.epoch : 0;
    this.#index = arena ? new Map() : null;
    this.#cache = new Array<string | undefined>(capacity);

    this.#head = new Uint32Array(buffer, headAt, HEAD_WORDS);
    this.#spans = new Uint32Array(buffer, spansAt, capacity * 2);
    this.#blob = new Uint8Array(buffer, blobAt, bytes);

    // Handle zero is the empty string, on the owner and on every worker. The
    // spans are already zero, so only the count is claimed.
    this.#cache[0] = '';
    this.#cached = 1;
    if (arena) {
      this.#index!.set('', EMPTY);
      if (Atomics.load(this.#head, COUNT) === 0) Atomics.store(this.#head, COUNT, 1);
    }
  }

  /** Distinct strings interned so far, the empty string included. */
  get count(): number { return Atomics.load(this.#rebound(), COUNT); }

  /** Blob bytes written so far. */
  get used(): number { return Atomics.load(this.#rebound(), USED); }

  /**
   * The handle for `s`, interning it if this table has not seen it. Cold path.
   *
   * The same text always gives the same handle, thus a caller may compare two
   * handles instead of two strings. Call this at the edge where text arrives,
   * and never inside a walk.
   */
  intern(s: string): Str {
    if (typeof s !== 'string') {
      throw new TypeError(`${this.name}: intern takes a string, got ${typeof s}`);
    }
    const index = this.#index;
    if (index === null) {
      throw new TypeError(
        `${this.name}: this table is attached, and an attached table cannot intern. ` +
        'Interning needs a hash of the text, which does not cross a thread. Intern on the ' +
        'thread that owns the arena and send the handle.',
      );
    }

    const hit = index.get(s);
    if (hit !== undefined) return hit;

    const head = this.#rebound();
    const h = Atomics.load(head, COUNT);
    if (h >= this.capacity) {
      throw new RangeError(
        `${this.name}: the span table is full. It holds ${this.capacity} distinct strings. ` +
        'Reserve a larger capacity.',
      );
    }

    const used = Atomics.load(head, USED);
    const room = this.bytes - used;
    const enc = this.#encoder ??= new TextEncoder();
    let written: number;

    // Every code unit encodes to at most three bytes, and a surrogate pair to
    // four, thus this bound never rejects a string that fits. The exact path
    // below runs only near the end of the blob, where it is owed.
    if (s.length * 3 <= room) {
      written = enc.encodeInto(s, this.#blob.subarray(used)).written;
    } else {
      const exact = enc.encode(s);
      if (exact.length > room) {
        throw new RangeError(
          `${this.name}: the blob is full. ${exact.length} bytes do not fit in the ` +
          `${room} left of ${this.bytes}. Reserve more bytes.`,
        );
      }
      this.#blob.set(exact, used);
      written = exact.length;
    }

    this.#spans[h * 2] = used;
    this.#spans[h * 2 + 1] = written;
    // The bytes and the span are written. Claim the handle last, so a worker
    // that reads this count reads a span that is already complete.
    Atomics.store(head, USED, used + written);
    Atomics.store(head, COUNT, h + 1);

    index.set(s, h);
    // The text is in hand, so caching it here costs nothing and spares the
    // first reader on this thread a decode.
    this.#cache[h] = s;
    this.#cached++;
    return h;
  }

  /** True if `s` already has a handle. It interns nothing. Owner only. */
  has(s: string): boolean {
    if (this.#index === null) {
      throw new TypeError(
        `${this.name}: an attached table holds no index, thus it cannot answer has(). ` +
        'Ask on the thread that owns the arena.',
      );
    }
    return this.#index.has(s);
  }

  /**
   * The JS string for `h`. Cold path, and the one that pays.
   *
   * A handle this thread has materialized before comes back from the cache. A
   * handle it has not is decoded once and kept. Do not call this for each row
   * of a walk that then discards the string.
   */
  get(h: Str): string {
    const hit = this.#cache[h];
    if (hit !== undefined) return hit;

    this.#check(h, 'get');
    const at = this.#spans[h * 2]!;
    const len = this.#spans[h * 2 + 1]!;
    const dec = this.#decoder ??= new TextDecoder('utf-8');
    const s = len === 0 ? '' : dec.decode(this.#blob.subarray(at, at + len));
    this.#cache[h] = s;
    this.#cached++;
    return s;
  }

  /**
   * The UTF-8 bytes of `h`, as a view on the arena. It copies nothing and
   * decodes nothing.
   *
   * This is what to hand a hash, a comparison against other bytes, or a WASM
   * function. The view is dead once the arena grows, as every other view is.
   */
  utf8(h: Str): Uint8Array {
    this.#check(h, 'utf8');
    const at = this.#spans[h * 2]!;
    return this.#blob.subarray(at, at + this.#spans[h * 2 + 1]!);
  }

  /** Bytes of UTF-8 behind `h`. It is not the count of JS characters. */
  byteLength(h: Str): number {
    this.#check(h, 'byteLength');
    return this.#spans[h * 2 + 1]!;
  }

  /**
   * Describe this table to another thread. It copies no byte.
   *
   * Post it once for each worker and call `attachStrings` on the other side.
   * The count and the blob cursor live in the block, so a worker sees handles
   * the owner interned after the message was sent.
   */
  share(): StringsShare {
    if (!this.#arena) {
      throw new TypeError(`${this.name}: an attached table cannot be shared again. Share the owner's.`);
    }
    if (!this.#arena.shared) {
      throw new TypeError(
        `${this.name}: this table is over an arena that is not shared, so another thread would ` +
        'have to copy every byte to read one. Build the arena with { shared: true }.',
      );
    }
    return {
      kind: 'pridat.strings',
      name: this.name,
      buffer: this.#arena.buffer,
      headAt: this.headAt,
      spansAt: this.spansAt,
      blobAt: this.blobAt,
      capacity: this.capacity,
      bytes: this.bytes,
    };
  }

  report(): StringsReport {
    const head = this.#rebound();
    const used = Atomics.load(head, USED);
    return {
      name: this.name,
      capacity: this.capacity,
      count: Atomics.load(head, COUNT),
      bytes: this.bytes,
      used,
      free: this.bytes - used,
      cached: this.#cached,
      writer: this.writer,
    };
  }

  /**
   * Refuse a handle this table never issued, and re-bind while we are here.
   *
   * It returns nothing and allocates nothing. The caller reads `#spans`
   * directly afterwards, because a pair returned from here would put an object
   * on the heap for every span read.
   */
  #check(h: Str, verb: string): void {
    const head = this.#rebound();
    const n = Atomics.load(head, COUNT);
    if (!Number.isInteger(h) || h < 0 || h >= n) {
      throw new RangeError(
        `${this.name}: cannot ${verb} handle ${h}. This table has issued ${n}. ` +
        'Pass a handle intern() returned.',
      );
    }
  }

  /**
   * Re-bind after the arena moved, and return the header.
   *
   * Growth replaces the block and detaches the old one, so every view here is
   * dead until it is made again. The offsets survive, because the arena keeps
   * them. A shared arena never grows, thus an attached table never re-binds.
   */
  #rebound(): Uint32Array {
    const arena = this.#arena;
    if (arena !== null && this.#boundAt !== arena.epoch) {
      this.#buffer = arena.buffer;
      this.#head = new Uint32Array(this.#buffer, this.headAt, HEAD_WORDS);
      this.#spans = new Uint32Array(this.#buffer, this.spansAt, this.capacity * 2);
      this.#blob = new Uint8Array(this.#buffer, this.blobAt, this.bytes);
      this.#boundAt = arena.epoch;
    }
    return this.#head;
  }
}

/**
 * Reserve a string table in `arena`.
 *
 *   const text = strings(arena, { bytes: 1 << 20, capacity: 50_000 })
 *   p.write(h, { name: text.intern('com.example.item') })
 *   text.get(p.get['name'](v, ptr))
 *
 * Both reservations are taken once and never grow. The blob holds the UTF-8,
 * and the span table holds one offset and one length for each distinct string.
 */
export function strings(arena: Arena, opts: StringsOptions): Strings {
  const { bytes, capacity, name = 'strings' } = opts;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`strings capacity must be a positive integer, got ${capacity}`);
  }
  if (capacity > MAX_STRINGS) {
    throw new RangeError(`strings capacity must not exceed ${MAX_STRINGS}, got ${capacity}`);
  }
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new RangeError(`strings bytes must be a non-negative integer, got ${bytes}`);
  }

  const headAt = arena.alloc(HEAD_WORDS * 4, 4);
  const spansAt = arena.alloc(capacity * 2 * 4, 4);
  const blobAt = arena.alloc(bytes, 4);
  return new Strings(arena, arena.buffer, name, headAt, spansAt, blobAt, capacity, bytes);
}

/**
 * The worker's half of a string table. It reads and it cannot intern.
 *
 * The decode cache is this thread's own, because a JS string does not cross a
 * thread either. Two workers that read the same handle each decode it once.
 */
export function attachStrings(share: StringsShare): Strings {
  if (share?.kind !== 'pridat.strings') {
    throw new TypeError(
      `attachStrings expects the object strings.share() returns. Got ${JSON.stringify(share?.kind)}.`,
    );
  }
  return new Strings(
    null, share.buffer, share.name,
    share.headAt, share.spansAt, share.blobAt, share.capacity, share.bytes,
  );
}
