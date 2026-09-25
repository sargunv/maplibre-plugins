// The paint JSON the gallery shows, in the form the native plugin loads. The
// JS layers accept [r, g, b, a] float arrays for colors, which spec.json
// defaults use, but the native host takes only CSS strings and rejects the
// whole layer for an array, so the gallery never shows one.

import type { PaintPropertySpec } from "@maplibre-plugins/paint";

/**
 * A straight-alpha [r, g, b, a] in 0..1 as a CSS `rgba()` string, the form
 * the native host takes for a color. Channels round to 8 bits, as the host's
 * CSS parser rounds them anyway.
 */
export function cssColor(rgba: readonly number[]): string {
  const [r = 0, g = 0, b = 0, a = 1] = rgba.map((c) =>
    Math.min(Math.max(c, 0), 1),
  );
  const channels = [r, g, b].map((c) => Math.round(c * 255));
  return `rgba(${channels.join(", ")}, ${a})`;
}

function isColorArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((c) => typeof c === "number")
  );
}

/**
 * A layer's paint as the native plugin loads it, so it reads like the
 * example file. A property that holds its spec default is left out unless
 * `authored` (the example's paint) sets it, and a color that is still a
 * float array becomes a CSS string. Other keys, such as `<name>-transition`,
 * pass through.
 */
export function nativePaint(
  paint: Readonly<Record<string, unknown>>,
  spec: Readonly<Record<string, PaintPropertySpec>>,
  authored: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(paint)) {
    const property = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (
      property &&
      !Object.hasOwn(authored, name) &&
      JSON.stringify(value) === JSON.stringify(property.default)
    )
      continue;
    result[name] =
      property?.type === "color" && isColorArray(value)
        ? cssColor(value)
        : value;
  }
  return result;
}
