// Types for wasm-emit.js.
//
// Hand-written and not inferred. The emitter is older than the library and
// stays plain JS, because the study imports it unchanged. Without this file it
// reaches TypeScript as `any`, thus nothing checks the WASM side of "one
// layout, two backends". The type suite found that.

export declare const T: {
  readonly i32: number; readonly i64: number; readonly f32: number;
  readonly f64: number; readonly void: number;
};

export declare const OP: {
  readonly block: number; readonly loop: number; readonly end: number;
  readonly br: number; readonly br_if: number; readonly ret: number;
  readonly local_get: number; readonly local_set: number; readonly local_tee: number;
  readonly i32_load: number; readonly f32_load: number; readonly f64_load: number;
  readonly i32_load8_u: number; readonly i32_store8: number;
  readonly i32_store: number; readonly f32_store: number; readonly f64_store: number;
  readonly i32_const: number; readonly f32_const: number; readonly f64_const: number;
  readonly i32_eqz: number; readonly i32_lt_s: number; readonly i32_ge_s: number;
  readonly i32_add: number; readonly i32_sub: number; readonly i32_mul: number;
  readonly f32_add: number; readonly f32_sub: number; readonly f32_mul: number;
  readonly f64_add: number;
};

export declare function uleb(n: number): number[];
export declare function sleb(n: number): number[];
export declare function f32Bytes(v: number): number[];

/** memarg immediate: alignment is an exponent (2 => 4-byte), then byte offset. */
export declare const mem: (align: number, offset: number) => number[];

export interface FuncType { params: number[]; results: number[] }
export interface MemoryImport {
  module: string; name: string; kind: 'memory';
  min: number; max?: number; shared?: boolean;
}
export interface FuncDef {
  type: number;
  locals: Array<[count: number, type: number]>;
  body: number[];
  export?: string;
}

/**
 * `Uint8Array<ArrayBuffer>` and not bare `Uint8Array`. Since TypeScript 5.7 the
 * bare form widens to `ArrayBufferLike`, which includes `SharedArrayBuffer` and
 * thus is not a `BufferSource`. The emitter builds over a plain ArrayBuffer.
 */
export declare function buildModule(opts: {
  types?: FuncType[]; imports?: MemoryImport[]; funcs?: FuncDef[];
}): Uint8Array<ArrayBuffer>;
