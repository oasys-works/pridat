// Publish the derivation.
//
// This shows where each byte of a row went, including the bytes that hold
// nothing. A person never writes a byte position, thus a person must still be
// able to see one.

import type { Hole, Layout, Leaf } from './layout.ts';
import { leafAligned, leafCount } from './layout.ts';

interface Line { offset: number; size: number; label: string; type: string }

const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number, w: number) => String(n).padStart(w);

function lines(l: Layout): Line[] {
  const out: Line[] = [];

  for (const leaf of l.leaves as Leaf[]) {
    const n = leafCount(leaf);
    const dims = leaf.dims.map(d => `x${d.count}/${d.stride}B`).join(' ');
    const note = leafAligned(leaf) ? '' : ' unaligned';
    out.push({
      offset: leaf.offset,
      size: leaf.size * n,
      label: leaf.path,
      type: (dims ? `${leaf.kind} ${dims}` : leaf.kind) + note,
    });
  }

  for (const h of l.holes as Hole[]) {
    out.push({
      offset: h.offset,
      size: h.size * h.repeat,
      label: '-- padding --',
      type: h.repeat > 1 ? `${h.size}B x${h.repeat}` : '',
    });
  }

  return out.sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
}

/** A human-readable byte map of one row. */
export function explain(l: Layout): string {
  const rows = lines(l);
  const w = Math.max(5, ...rows.map(r => r.label.length));
  const pct = l.size === 0 ? 0 : (l.padding / l.size) * 100;

  const head = [
    `${l.name} - ${l.size} B/row, align ${l.align}` +
      (l.packed ? ', packed' : '') +
      `, ${l.padding} B padding (${pct.toFixed(1)}%)`,
    '',
    `  ${'off'.padStart(5)}  ${'size'.padStart(4)}  ${pad('field', w)}  type`,
  ];

  const body = rows.map(r =>
    `  ${num(r.offset, 5)}  ${num(r.size, 4)}  ${pad(r.label, w)}  ${r.type}`.trimEnd());

  const foot: string[] = [];
  if (l.unaligned.length > 0) {
    foot.push('', `  ${l.unaligned.length} of ${l.leaves.length} fields are not naturally aligned and must be`);
    foot.push(`  read through a DataView, which is slower: ${l.unaligned.join(', ')}`);
  }
  if (l.padding > 0 && !l.packed) {
    foot.push('', `  ${l.padding} B of ${l.size} hold nothing. Ordering fields widest-first removes`);
    foot.push('  padding between them, at the cost of matching a Rust struct field for field.');
  }

  return [...head, ...body, ...foot].join('\n');
}
