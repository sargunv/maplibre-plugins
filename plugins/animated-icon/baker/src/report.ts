// The bake report the CLI prints: what each animation costs in the catalog
// and in the shader, how much the dedupe saved, and what the bake skipped
// or worked around.

import { type BakedCatalog, COST_LABEL } from "./bake.ts";
import { describe } from "./profile.ts";

function kilobytes(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] ?? []).map((_, c) =>
    Math.max(...rows.map((row) => (row[c] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, c) =>
          c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The bake report as text. */
export function formatReport({ animations, packed }: BakedCatalog): string {
  const rows: string[][] = [
    [
      "animation",
      "frames@fps",
      "max ops",
      "shapes/ops",
      "max curves",
      "visits/px",
      "µs",
      "KB frames/ops/shapes/gradients",
      "fallbacks",
    ],
  ];
  for (const a of animations) {
    const dedupe = a.ops > 0 ? 100 * (1 - a.shapes / a.ops) : 0;
    rows.push([
      a.name,
      `${a.frames}@${a.fps}`,
      String(a.maxOps),
      `${a.shapes}/${a.ops} (${dedupe.toFixed(0)}%)`,
      String(a.maxCurves),
      a.visits.toFixed(1),
      `${a.micros[0].toFixed(1)}-${a.micros[1].toFixed(1)}`,
      [a.frameBytes, a.opBytes, a.shapeBytes, a.gradientBytes]
        .map(kilobytes)
        .join("/"),
      String(a.fallbacks.length),
    ]);
  }
  const lines = [
    table(rows),
    "",
    `catalog: ${packed.texelCount} texels in a ${packed.textureWidth}x${packed.textureHeight} texture; ${(packed.bytes.length / (1024 * 1024)).toFixed(2)} MB`,
    "shapes/ops: shape records against ops over every frame (the share the dedupe saved);",
    "visits/px: shader curve visits per pixel of the anchor box at displayPx x 2, the",
    "mean over the box in the costliest frame; µs: per icon at displayPx on a 3x",
    `screen, a ${COST_LABEL}.`,
  ];
  for (const a of animations) {
    const notes = [
      ...a.warnings.map((w) => `warning: ${w}`),
      ...a.fallbacks.map(
        (f) =>
          `path boolean fallback: ${f.op} at ${f.where} (${f.problem === "null" ? "no result" : "area off the raster"}; ${f.resolution})`,
      ),
      ...(a.markers.length > 0
        ? [`marker entries: ${a.markers.join(", ")}`]
        : []),
      ...a.notes.ignored.map((v) => `ignored: ${describe(v)}`),
      ...a.notes.inert.map((note) => `inert: ${note}`),
    ];
    if (notes.length === 0) continue;
    lines.push("", `${a.name} (${a.file}):`, ...notes.map((n) => `  ${n}`));
  }
  return lines.join("\n");
}
