// Minimal WebAssembly binary encoder.
//
// It emits module bytes directly and needs no toolchain. It tests the JS to
// WASM bridge honestly, and it is the seed of the WASM backend: the layout
// engine that computes struct offsets for JS puts the same offsets into the
// memarg immediates here. That is "one layout, two backends" in miniature.

export const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, void: 0x40 };

export const OP = {
  block: 0x02, loop: 0x03, end: 0x0b, br: 0x0c, br_if: 0x0d, ret: 0x0f,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  i32_load: 0x28, f32_load: 0x2a, f64_load: 0x2b,
  // Byte-width accessors. A bool or u8 field is the most probable place for a
  // wrong offset table, thus the bridge test must reach one.
  i32_load8_u: 0x2d, i32_store8: 0x3a,
  i32_store: 0x36, f32_store: 0x38, f64_store: 0x39,
  i32_const: 0x41, f32_const: 0x43, f64_const: 0x44,
  i32_eqz: 0x45, i32_lt_s: 0x48, i32_ge_s: 0x4e,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c,
  f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94,
  f64_add: 0xa0,
};

export function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n !== 0) b |= 0x80; out.push(b); } while (n !== 0);
  return out;
}

export function sleb(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

export function f32Bytes(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...b];
}

const str = s => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = items => [...uleb(items.length), ...items.flat()];
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

/** memarg immediate: alignment is an exponent (2 => 4-byte), then byte offset. */
export const mem = (align, offset) => [...uleb(align), ...uleb(offset)];

/**
 * Build a module.
 *   types:   [{ params: [T], results: [T] }]
 *   imports: [{ module, name, kind: 'memory', min, max?, shared? }]
 *   funcs:   [{ type: idx, locals: [[count, T]], body: [bytes], export?: name }]
 */
export function buildModule({ types = [], imports = [], funcs = [] }) {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  bytes.push(...section(1, vec(types.map(t =>
    [0x60, ...vec(t.params.map(p => [p])), ...vec(t.results.map(r => [r]))]))));

  if (imports.length) {
    bytes.push(...section(2, vec(imports.map(im => {
      if (im.kind !== 'memory') throw new Error('wasm-emit supports memory imports only');
      // limits flags: bit0 = has max, bit1 = shared
      const flags = (im.max !== undefined ? 1 : 0) | (im.shared ? 2 : 0);
      const lim = im.max !== undefined ? [flags, ...uleb(im.min), ...uleb(im.max)] : [flags, ...uleb(im.min)];
      return [...str(im.module), ...str(im.name), 0x02, ...lim];
    }))));
  }

  bytes.push(...section(3, vec(funcs.map(f => uleb(f.type)))));

  const exports = funcs.map((f, i) => ({ f, i })).filter(x => x.f.export);
  if (exports.length) {
    bytes.push(...section(7, vec(exports.map(x => [...str(x.f.export), 0x00, ...uleb(x.i)]))));
  }

  bytes.push(...section(10, vec(funcs.map(f => {
    const body = [...vec(f.locals.map(([c, t]) => [...uleb(c), t])), ...f.body, OP.end];
    return [...uleb(body.length), ...body];
  }))));

  return new Uint8Array(bytes);
}
