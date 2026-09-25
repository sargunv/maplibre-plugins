// Rigid-shape dedupe. Every draw is baked in its own (style) space, and the
// catalog places it with an affine op, so any two draws whose geometry in
// their own space is the same share one shape record: rigid motion, a
// group moving or turning while its paths stay put, and periodic dash or
// trim phases. The key is the SHA-1 of a canonical serialization of what
// decides the shape before fitting (geometry.ts's DrawGeometry): the
// outline after modifiers and dashes, the fill rule, the stroke's width,
// caps, joins and miter limit, and the masks and matte sources moved into
// the draw's space, every number rounded to 1e-4.

import { createHash } from "node:crypto";

import type { DrawGeometry } from "./geometry.ts";

/** Numbers as the key sees them: rounded to 1e-4, without negative zero. */
function round(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
}

/** The canonical text of a geometry. */
export function canonical(geometry: DrawGeometry): string {
  return JSON.stringify(geometry, (_, value: unknown) =>
    typeof value === "number" ? round(value) : value,
  );
}

/** The dedupe key of a geometry. */
export function geometryKey(geometry: DrawGeometry): string {
  return createHash("sha1").update(canonical(geometry)).digest("hex");
}
