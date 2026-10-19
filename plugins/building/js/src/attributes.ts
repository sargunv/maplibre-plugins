// The GPU layout of the data-driven paint attributes. @maplibre-plugins/paint
// fills them as floats, [min..., max...] per bound property and vertex, the
// way the native binders evaluate them; this packs that into the bytes the
// shader reads, as the native host stores them: a number as one float2
// (min, max), and a color (PROPERTY_ENCODING_COLOR_RGBA8) as two
// UINT8_X4_NORMALIZED attributes, min then max, each component truncated to
// a byte (plugin_bucket.cpp PluginPaintVertexVector::set). Every bound
// property takes 8 bytes per vertex either way.

import type { AttributeLayout } from "@maplibre-plugins/paint";

import { BINDINGS, type BoundName } from "./shaders.ts";

/** Bytes each bound property takes per vertex. */
export const BYTES_PER_PROPERTY = 8;

/** One bound property's attributes in the packed buffer. */
export interface PackedAttribute {
  readonly location: number;
  /** 2 floats, or 4 normalized bytes. */
  readonly kind: "float2" | "rgba8";
  /** Bytes from the vertex start. */
  readonly offset: number;
}

export interface PackedLayout {
  /** Bytes per vertex. */
  readonly stride: number;
  readonly attributes: readonly PackedAttribute[];
}

function isColor(name: BoundName): boolean {
  return BINDINGS[name].encoding === "PROPERTY_ENCODING_COLOR_RGBA8";
}

/** Where each bound property's attributes go, in the layout's order. */
export function packedLayout(layout: AttributeLayout<BoundName>): PackedLayout {
  const attributes: PackedAttribute[] = [];
  layout.bound.forEach((name, i) => {
    const offset = i * BYTES_PER_PROPERTY;
    const binding = BINDINGS[name];
    if (isColor(name)) {
      attributes.push(
        { location: binding.minimumAttribute, kind: "rgba8", offset },
        {
          location: binding.maximumAttribute,
          kind: "rgba8",
          offset: offset + 4,
        },
      );
    } else {
      attributes.push({
        location: binding.minimumAttribute,
        kind: "float2",
        offset,
      });
    }
  });
  return { stride: layout.bound.length * BYTES_PER_PROPERTY, attributes };
}

/**
 * A color component as the host's RGBA8 encoding stores it:
 * uint8(clamp(c, 0, 1) × 255) in f32, truncated, NaN as 0.
 */
export function colorByte(component: number): number {
  if (Number.isNaN(component)) return 0;
  const clamped = Math.min(Math.max(Math.fround(component), 0), 1);
  return Math.trunc(Math.fround(clamped * 255));
}

/**
 * Packs vertices [first, end) of `floats` (vertex count × layout.stride, as
 * fillAttributes writes them) into `out` (vertex count × packed stride
 * bytes).
 */
export function packAttributes(
  floats: Float32Array,
  layout: AttributeLayout<BoundName>,
  out: ArrayBuffer,
  first = 0,
  end = layout.stride > 0 ? floats.length / layout.stride : 0,
): void {
  const stride = layout.bound.length * BYTES_PER_PROPERTY;
  if (stride === 0) return;
  const f32 = new Float32Array(out);
  const u8 = new Uint8Array(out);
  for (let vertex = first; vertex < end; vertex++) {
    const source = vertex * layout.stride;
    const target = vertex * stride;
    layout.bound.forEach((name, i) => {
      const from = source + (layout.offsets[name] ?? 0);
      const to = target + i * BYTES_PER_PROPERTY;
      if (isColor(name)) {
        for (let c = 0; c < 8; c++) u8[to + c] = colorByte(floats[from + c]!);
      } else {
        f32[to / 4] = floats[from]!;
        f32[to / 4 + 1] = floats[from + 1]!;
      }
    });
  }
}
