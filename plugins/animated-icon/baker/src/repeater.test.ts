import { describe, expect, it } from "vite-plus/test";

import { comp, el, fl, gr, k, layer } from "./lottie.testing.ts";
import type { Point } from "./pack.ts";
import { repeaterCopies, type RepeaterItem } from "./repeater.ts";
import { evaluateFrame, type ShapeItem } from "./scene.ts";
import { apply } from "./transform.ts";

function repeater(
  copies: number,
  transform: Record<string, unknown>,
  extra: Partial<RepeaterItem> = {},
): RepeaterItem {
  return {
    ty: "rp",
    c: k(copies),
    o: k(0),
    m: 1,
    tr: { so: k(100), eo: k(100), ...transform } as RepeaterItem["tr"],
    ...extra,
  };
}

const at = (m: readonly number[], p: Point): Point =>
  apply(m as [number, number, number, number, number, number], p).map(
    (v) => Math.round(v * 1e9) / 1e9 + 0,
  ) as unknown as Point;

describe("repeaterCopies", () => {
  it("steps the transform once per copy, the first copy on top", () => {
    const copies = repeaterCopies(repeater(3, { p: k([10, 0]) }), 0);
    expect(copies.map((c) => at(c.matrix, [0, 0]))).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    // Composite "below" (m 2) reverses which copy stays put.
    const below = repeaterCopies(repeater(3, { p: k([10, 0]) }, { m: 2 }), 0);
    expect(below.map((c) => at(c.matrix, [0, 0]))).toEqual([
      [20, 0],
      [10, 0],
      [0, 0],
    ]);
  });

  it("starts from the offset and rounds fractional copies up", () => {
    const copies = repeaterCopies(
      repeater(2.2, { p: k([10, 0]) }, { o: k(1.5) }),
      0,
    );
    expect(copies.map((c) => at(c.matrix, [0, 0]))).toEqual([
      [15, 0],
      [25, 0],
      [35, 0],
    ]);
  });

  it("turns and scales about the anchor, and steps the position alone", () => {
    const [, turned] = repeaterCopies(
      repeater(2, { a: k([5, 0]), r: k(90) }),
      0,
    );
    expect(at(turned?.matrix ?? [], [5, 0])).toEqual([5, 0]);
    expect(at(turned?.matrix ?? [], [0, 0])).toEqual([5, -5]);
    const [, , scaled] = repeaterCopies(repeater(3, { s: k([50, 50]) }), 0);
    expect(at(scaled?.matrix ?? [], [8, 4])).toEqual([2, 1]);
  });

  it("ramps opacity from the start to the end opacity", () => {
    const copies = repeaterCopies(repeater(3, { so: k(100), eo: k(50) }), 0);
    expect(copies.map((c) => c.opacity)).toEqual([1, 0.75, 0.5]);
  });

  it("makes no copies for a count of zero", () => {
    expect(repeaterCopies(repeater(0, {}), 0)).toEqual([]);
  });
});

describe("repeaters in the scene", () => {
  const scene = (ignore?: string[]) =>
    evaluateFrame(
      comp([
        layer([
          gr([
            el(0, 0),
            fl(1, 0, 0),
            repeater(3, { p: k([10, 0]) }) as unknown as ShapeItem,
          ]),
        ]),
      ]),
      0,
      ignore ? { ignore: new Set(ignore) } : {},
    );

  it("draws each copy with its own transform, the original items not at all", () => {
    const draws = scene();
    // Bottom first: the last copy is drawn first.
    expect(draws.map((d) => at(d.matrix, [0, 0]))).toEqual([
      [20, 0],
      [10, 0],
      [0, 0],
    ]);
  });

  it("draws the items once when the entry ignores repeaters", () => {
    expect(scene(["repeaters"])).toHaveLength(1);
  });
});
