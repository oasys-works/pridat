// pridat: primitive data types for JavaScript.
//
// This is not a framework. It gives the parts that a framework is built from: a
// layout you declare, a table that describes it exactly, and, as later steps
// land, the accessors, arena and shared memory on those bytes.
//
// Thus this file has no privileged surface. The field table is the product, not
// an implementation detail. Code generators, WASM emitters, column allocators
// and entity systems all read the same table. No reader is the intended one.

// ---------------------------------------------------------------------------
// Declare a layout
// ---------------------------------------------------------------------------
export { array, bool, f32, f64, i8, i16, i32, i64, str, u8, u16, u32, u64 } from './schema.ts';
export { packed, struct, vec2, vec3, vec4 } from './layout.ts';
export type { ArrayTy, Fields, I64Pair, Scalar, ScalarKind, Str, StructTy, Ty } from './schema.ts';

// ---------------------------------------------------------------------------
// Read a layout. Code generators, WASM emitters and allocators need this.
// ---------------------------------------------------------------------------
export { layoutOf, leafAligned, leafCount, leafOffset, measure, scalarAlign, scalarSize, soaColumns }
  from './layout.ts';
export type { Column, Dim, Hole, Layout, Leaf, Node, Struct } from './layout.ts';

// ---------------------------------------------------------------------------
// Infer TypeScript types from a layout
// ---------------------------------------------------------------------------
export type { LeafPath, Row } from './layout.ts';
export type { Value } from './schema.ts';

// ---------------------------------------------------------------------------
// Generate accessors over a layout
// ---------------------------------------------------------------------------
export {
  accessorModule, accessorPlan, accessors, accessorsFrom, accessorSource,
  emitAccessorModule, emitAccessors, planSignature,
} from './codegen.ts';
export type {
  AccessorOptions, Accessors, AccessUnit, Bound, ExpandOnly, Getter, Leaf64,
  LeafView, Plan, Setter, Site, SiteIndices, SitePath, SiteValue, View,
} from './codegen.ts';

// ---------------------------------------------------------------------------
// Emit the layout as Zig, for a WASM or native side that reads the same bytes
// ---------------------------------------------------------------------------
export { zigModule } from './zig-emit.ts';

// ---------------------------------------------------------------------------
// Own the memory
// ---------------------------------------------------------------------------
export { Arena, MAX_ARENA_BYTES } from './arena.ts';
export type { ArenaOptions, ArenaReport, Growth } from './arena.ts';

// ---------------------------------------------------------------------------
// Hold one schema's rows, with handles that trap
// ---------------------------------------------------------------------------
export { MAX_POOL_CAPACITY, Pool, pool, poolPtrAlign } from './pool.ts';
export type { Handle, PoolOptions, PoolReport } from './pool.ts';

// ---------------------------------------------------------------------------
// Hold the text a `str` field names
// ---------------------------------------------------------------------------
export { attachStrings, EMPTY, MAX_STRINGS, Strings, strings } from './strings.ts';
export type { StringsOptions, StringsReport, StringsShare } from './strings.ts';

// ---------------------------------------------------------------------------
// Share a pool with another thread
// ---------------------------------------------------------------------------
export { attach, attachBarrier, Barrier, barrier, bindShare } from './thread.ts';
export type { Attached, BarrierShare, PoolShare } from './thread.ts';

// ---------------------------------------------------------------------------
// Look at a layout
// ---------------------------------------------------------------------------
export { explain } from './explain.ts';
