// The string table, and the `str` field that names it.
//
// Three claims are checked here, and each one is the reason a `str` field is a
// handle rather than the text.
//
//   - The row stays a row. A `str` occupies one aligned word, so a schema
//     holding one lays out exactly as the same schema holding a `u32`.
//     test/repr.test.ts then compiles that claim against rustc, cc and zig.
//   - Equality is the word compare. The same text always gives the same handle,
//     so a filter over a walk never touches the blob.
//   - The bytes cross a thread. A worker attaches the same block and reads the
//     same text, including text interned after the message was posted.
//
// The fourth thing is not a claim. It is a cost, and the last group states it.
// Materializing a JS string is a decode, and the cache hides that only for text
// that is read again.

import {
  Arena, EMPTY, accessors, attachStrings, pool, str, strings, struct, u32, u64, u8,
} from '../src/index.ts';
import type { Row } from '../src/index.ts';
import { group, report, skip } from './harness.ts';

const Item = struct({ id: u64, name: str, kind: str, tag: u8 }, 'Item');
const AsWords = struct({ id: u64, name: u32, kind: u32, tag: u8 }, 'AsWords');

// ---------------------------------------------------------------------------

group('a str field is one aligned word, and the row is unchanged by it', t => {
  t.eq('Item lays out as the same schema written with u32',
    [Item.size, Item.align, Item.leaves.map(l => [l.path, l.offset])],
    [AsWords.size, AsWords.align, AsWords.leaves.map(l => [l.path, l.offset])]);
  t.eq('a str leaf is 4 B', Item.leaf('name').size, 4);
  t.eq('a str leaf aligns to 4', Item.leaf('name').align, 4);
  t.eq('a str leaf keeps its kind, thus explain() and the emitters can see it',
    Item.leaf('name').kind, 'str');
  t.eq('nothing is unaligned', Item.unaligned, []);
});

group('the accessor reads the handle through a typed array, and never decodes', t => {
  const A = accessors(Item);
  const plan = A.plan;
  const site = plan.sites.find(s => s.path === 'name')!;
  t.eq('a str site moves a u32', site.unit, 'u32');
  t.eq('a str site reads through a typed array, not a DataView', site.via, 'typed');
  t.eq('a str leaf is one site, not two as a 64-bit leaf is',
    plan.sites.filter(s => s.leaf === 'name').length, 1);
  t.ok('the generated getter carries no decode and no table',
    !/TextDecoder|decode|intern/.test(A.source), 'the source mentioned a decode');
});

// ---------------------------------------------------------------------------

group('interning: the same text gives the same handle', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const text = strings(arena, { bytes: 1 << 12, capacity: 100, name: 'text' });

  const a = text.intern('com.example.module.item');
  const b = text.intern('com.example.module.item');
  const c = text.intern('com.example.module.other');

  t.eq('the same text interns to one handle', a, b);
  t.ok('different text interns to a different handle', a !== c, `${a} and ${c}`);
  t.eq('the text comes back', text.get(a), 'com.example.module.item');
  t.eq('and so does the other', text.get(c), 'com.example.module.other');
  t.eq('three interns of two distinct strings issued two handles, plus the empty one',
    text.count, 3);
  t.ok('has() answers without interning', text.has('com.example.module.item') && !text.has('nope'));
  t.eq('has() interned nothing', text.count, 3);
});

group('the empty string is handle zero, thus a zeroed row reads as empty', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const text = strings(arena, { bytes: 1 << 12, capacity: 10 });
  t.eq('EMPTY is zero', EMPTY, 0);
  t.eq('interning the empty string gives zero', text.intern(''), 0);
  t.eq('handle zero reads as the empty string', text.get(0), '');
  t.eq('an untouched table has issued exactly the empty string', text.count, 1);
  t.eq('the empty string wrote no byte', text.used, 0);

  // A pool hands out a slot whose bytes are whatever the last tenant left, so
  // this is checked over a row the caller zeroed rather than over a fresh one.
  const p = pool(arena, Item, { capacity: 4 });
  const h = p.alloc();
  p.write(h, { id: { lo: 0, hi: 0 }, name: 0, kind: 0, tag: 0 });
  t.eq('a zeroed str field reads as the empty string', text.get(p.read(h).name), '');
});

group('non-ASCII text survives the round trip, and byteLength is bytes', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const text = strings(arena, { bytes: 1 << 12, capacity: 10 });

  const cases = ['ascii', 'héllo', '日本語', '👋🏽 emoji', 'mixed 日本 text'];
  for (const s of cases) {
    const h = text.intern(s);
    t.eq(`${JSON.stringify(s)} comes back exactly`, text.get(h), s);
  }
  const jp = text.intern('日本語');
  t.eq('byteLength counts UTF-8 bytes and not characters', text.byteLength(jp), 9);
  t.eq('utf8() is a view on those bytes', Array.from(text.utf8(jp)).length, 9);
  t.eq('utf8() decodes back to the same text',
    new TextDecoder().decode(text.utf8(jp)), '日本語');
});

group('a handle the table never issued is refused, and named', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const text = strings(arena, { bytes: 1 << 12, capacity: 10, name: 'labels' });
  text.intern('one');
  t.throws('a handle above the issued count throws', () => text.get(99), /labels.*99.*issued/);
  t.throws('a negative handle throws', () => text.get(-1), /cannot get handle -1/);
  t.throws('a fractional handle throws', () => text.get(1.5), /cannot get handle 1.5/);
  t.throws('intern refuses a non-string', () => text.intern(7 as unknown as string), /got number/);
});

group('a full table stops and states the remedy', t => {
  const arena = new Arena({ bytes: 1 << 16 });
  const small = strings(arena, { bytes: 1 << 12, capacity: 2, name: 'small' });
  small.intern('one');
  t.throws('the span table fills and names its capacity',
    () => small.intern('two'), /small.*span table is full.*2 distinct.*larger capacity/);

  const narrow = strings(arena, { bytes: 8, capacity: 100, name: 'narrow' });
  narrow.intern('12345678');
  t.throws('the blob fills and names both numbers',
    () => narrow.intern('x'), /narrow.*blob is full.*Reserve more bytes/);
  t.eq('the refused intern wrote nothing', narrow.used, 8);
  t.eq('and issued no handle', narrow.count, 2);
});

group('a string longer than the blob is refused rather than truncated', t => {
  // The fast path bounds a string at three bytes per code unit, so a string
  // that fits only exactly takes the slower exact path. Both must refuse, and
  // neither may write a partial string.
  const arena = new Arena({ bytes: 1 << 16 });
  const text = strings(arena, { bytes: 16, capacity: 10, name: 'tight' });
  const exact = text.intern('0123456789abcdef');
  t.eq('a string that fills the blob exactly is interned whole', text.get(exact), '0123456789abcdef');
  t.eq('and it used every byte', text.used, 16);
  t.throws('one more byte is refused', () => text.intern('x'), /blob is full/);

  const other = new Arena({ bytes: 1 << 16 });
  const t2 = strings(other, { bytes: 4, capacity: 10, name: 'four' });
  t.throws('a string past the blob is refused and not truncated',
    () => t2.intern('日本語'), /blob is full/);
  t.eq('nothing was written', t2.used, 0);
});

// ---------------------------------------------------------------------------

group('a walk filters on the handle and never touches the blob', t => {
  const arena = new Arena({ bytes: 1 << 20 });
  const text = strings(arena, { bytes: 1 << 14, capacity: 100 });
  const p = pool(arena, Item, { capacity: 300 });

  const WANT = text.intern('wanted');
  const OTHER = text.intern('other');

  for (let i = 0; i < 300; i++) {
    const h = p.alloc();
    p.write(h, {
      id: { lo: i, hi: 0 },
      name: i % 3 === 0 ? WANT : OTHER,
      kind: EMPTY,
      tag: 1,
    });
  }

  const getName = p.get['name'], v = p.view['name'];
  const rows = p.rows;
  let hits = 0;
  for (let i = 0, n = p.count; i < n; i++) if (getName(v, rows[i]!) === WANT) hits++;

  t.eq('the filter found every matching row', hits, 100);
  // Three is the empty string plus the two the owner interned. Interning caches
  // the text it was handed, so a walk that decoded would push this higher.
  t.eq('the walk materialized no string of its own', text.report().cached, 3);
  t.ok('the getter returned a handle and not text',
    typeof getName(v, rows[0]!) === 'number', 'the getter returned something else');
  t.eq('every row holds one of the two handles',
    [...new Set(Array.from({ length: p.count }, (_, i) => getName(v, rows[i]!)))].sort(),
    [WANT, OTHER].sort());
});

group('a row round trips through read and write as handles', t => {
  const arena = new Arena({ bytes: 1 << 18 });
  const text = strings(arena, { bytes: 1 << 12, capacity: 50 });
  const p = pool(arena, Item, { capacity: 8 });

  const row: Row<typeof Item> = {
    id: { lo: 7, hi: 0 },
    name: text.intern('com.example.item'),
    kind: text.intern('widget'),
    tag: 3,
  };
  const h = p.alloc();
  p.write(h, row);
  const back = p.read(h);

  t.eq('the row comes back with the same handles', back, row);
  t.eq('and the handles resolve to the same text',
    [text.get(back.name), text.get(back.kind)], ['com.example.item', 'widget']);
});

// ---------------------------------------------------------------------------

if (typeof (ArrayBuffer.prototype as { transfer?: unknown }).transfer !== 'function') {
  skip('strings: growth re-binds the table', 'this host has no ArrayBuffer.prototype.transfer');
} else group('growth re-binds the table rather than leaving it on a detached block', t => {
  const arena = new Arena({ bytes: 1 << 12, growth: 'grow' });
  const text = strings(arena, { bytes: 1 << 8, capacity: 20 });
  const before = text.intern('written before the move');
  const epoch = arena.epoch;

  // Force a move by asking for more than the reservation holds.
  arena.alloc(1 << 13, 4);
  t.ok('the arena moved', arena.epoch > epoch, `epoch ${epoch} to ${arena.epoch}`);

  t.eq('a handle from before the move still reads its text',
    text.get(before), 'written before the move');
  const after = text.intern('written after the move');
  t.eq('and the table still interns', text.get(after), 'written after the move');
  t.eq('both handles are live', text.count, 3);
});

group('an unshared table refuses to be shared, and says why', t => {
  const arena = new Arena({ bytes: 1 << 14 });
  const text = strings(arena, { bytes: 1 << 8, capacity: 10, name: 'local' });
  t.throws('share() names the remedy', () => text.share(), /local.*shared: true/);
});

group('attachStrings refuses anything that is not a share', t => {
  t.throws('a pool share is refused',
    () => attachStrings({ kind: 'pridat.pool' } as never), /attachStrings expects/);
  t.throws('undefined is refused', () => attachStrings(undefined as never), /attachStrings expects/);
});

// ---------------------------------------------------------------------------

interface Reply {
  before: string[];
  after: string;
  twice: boolean;
  bytes: number[];
  count: number;
  writer: boolean;
  internThrew: boolean;
}

async function crossThread(): Promise<Reply | null> {
  if (typeof SharedArrayBuffer === 'undefined') return null;
  const { Worker } = await import('node:worker_threads');

  const arena = new Arena({ bytes: 1 << 20, shared: true });
  const text = strings(arena, { bytes: 1 << 14, capacity: 100, name: 'shared' });
  const before = ['com.example.first', 'héllo 日本', 'third'].map(s => text.intern(s));

  const url = new URL('./strings.worker.ts', import.meta.url);
  const w = new Worker(url, { workerData: { strings: text.share(), before } as never });

  // Intern after the worker was told about the table. The count lives in the
  // block, so the worker must see this handle even though the message predates it.
  const after = text.intern('interned after the message went out');
  w.postMessage({ after });

  const reply = await new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not reply')), 10_000);
    w.once('message', m => { clearTimeout(timer); resolve(m as Reply); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
  });
  await w.terminate();
  return reply;
}

let reply: Reply | null = null;
let crossFailed: string | null = null;
try {
  reply = await crossThread();
} catch (e) {
  crossFailed = e instanceof Error ? e.message : String(e);
}

if (crossFailed !== null) {
  // An error is an error. It is never a refutation, and it is never silence.
  group('strings cross a thread', t => {
    t.ok(`the worker ran: ${crossFailed}`, false);
  });
} else if (reply === null) {
  skip('strings cross a thread', 'this host has no SharedArrayBuffer');
} else {
  const r = reply;
  group('the text crosses a thread as bytes, not as a copy', t => {
    t.eq('a worker reads text the owner interned',
      r.before, ['com.example.first', 'héllo 日本', 'third']);
    t.eq('including text interned after the message was posted',
      r.after, 'interned after the message went out');
    t.eq('the worker saw the owner\'s count, not a snapshot', r.count, 5);
    t.eq('the same handle read twice agrees with itself', r.twice, true);
    t.eq('utf8() on the worker sees the owner\'s bytes',
      new TextDecoder().decode(new Uint8Array(r.bytes)), 'com.example.first');
  });

  group('an attached table reads and does not intern', t => {
    t.eq('it says it is not a writer', r.writer, false);
    t.ok('intern on an attached table throws', r.internThrew,
      'the worker interned, which would fork the table');
  });
}

report('strings.test.ts');
