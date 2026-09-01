// The schemas the layout tests and the repr(C) cross-check both run against.
//
// One corpus, so a shape that the invariants cover is also a shape rustc and cc
// have an opinion about. Adding a schema here adds it to both.

import {
  array, bool, f32, f64, i8, i16, i32, i64,
  packed, str, struct, u8, u16, u32, u64, vec2, vec3, vec4,
} from '../src/index.ts';
import type { Struct } from '../src/index.ts';

export interface Case { name: string; type: Struct<any>; }

export const CORPUS: Case[] = [
  { name: 'Particle', type: struct({ pos: vec3(f32), vel: vec3(f32), mass: f32, alive: bool }, 'Particle') },
  { name: 'Ragged', type: struct({ a: u8, b: u32, c: u8, d: f64, e: u8 }, 'Ragged') },
  { name: 'Tidy', type: struct({ d: f64, b: u32, a: u8, c: u8, e: u8 }, 'Tidy') },
  { name: 'Mesh', type: struct({ id: u64, tag: u8, verts: array(vec3(f32), 3), lod: u16 }, 'Mesh') },
  { name: 'Grid', type: struct({ cells: array(array(u16, 4), 3), gen: u32 }, 'Grid') },
  { name: 'Deep', type: struct({ a: i8, b: struct({ c: i16, d: struct({ e: i64, f: i8 }) }), g: u8 }, 'Deep') },
  { name: 'AllScalars', type: struct({
      a: i8, b: u8, c: i16, d: u16, e: i32, f: u32, g: i64, h: u64, i: f32, j: f64, k: bool }, 'AllScalars') },
  { name: 'Vecs', type: struct({ a: vec2(f64), b: vec3(u8), c: vec4(f32) }, 'Vecs') },
  { name: 'OneByte', type: struct({ only: bool }, 'OneByte') },
  { name: 'Padded', type: struct({ items: array(struct({ a: u8, b: f32 }), 2), n: u8 }, 'Padded') },
  { name: 'Zero', type: struct({ a: u8, none: array(f32, 0), b: u8 }, 'Zero') },
  { name: 'Packed', type: packed({ a: u8, b: u32, c: u8, d: f64 }, 'Packed') },
  { name: 'PackedNest', type: packed({ a: u8, inner: struct({ x: u8, y: u32 }), z: u16 }, 'PackedNest') },
  // A wide field at offset zero above an odd stride. No base alignment reaches
  // row one, thus this is the shape that separates a promise about row zero
  // from a promise about every row.
  { name: 'PackedWide', type: packed({ b: f64, a: u8 }, 'PackedWide') },
  // A `str` is a `u32` to rustc, cc and zig. These two cases are what holds
  // that claim: one beside a wider field that forces padding around it, and one
  // repeated inline.
  { name: 'Named', type: struct({ id: u64, name: str, tag: u8 }, 'Named') },
  { name: 'Labels', type: struct({ names: array(str, 3), n: u8 }, 'Labels') },
  { name: 'MatrixHeavy', type: struct({ m: array(f32, 16), n: array(f64, 4), tag: u8 }, 'MatrixHeavy') },
  { name: 'ArrayOfPacked', type: struct({
      head: u16, rows: array(packed({ a: u8, b: u32 }), 3), tail: u8 }, 'ArrayOfPacked') },
];
