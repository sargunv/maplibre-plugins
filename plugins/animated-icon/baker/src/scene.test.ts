import { describe, expect, it } from "vite-plus/test";

import { keys, mask, square } from "./lottie.testing.ts";
import type { Point } from "./pack.ts";
import {
  type Draw,
  evaluateFrame,
  hexColor,
  type Layer,
  type Lottie,
  type MatteClip,
  type MaskClip,
  precompFrame,
  prepare,
  type ShapeItem,
} from "./scene.ts";
import { apply } from "./transform.ts";

/** A solid draw's color. */
function color(draw: Draw | undefined): readonly number[] | undefined {
  return draw?.paint.kind === "solid" ? draw.paint.color : undefined;
}

const k = (value: unknown) => ({ a: 0, k: value });

function el(x: number, y: number, size = 10): ShapeItem {
  return { ty: "el", p: k([x, y]), s: k([size, size]) };
}

function fl(
  r: number,
  g: number,
  b: number,
  extra: Partial<ShapeItem> = {},
): ShapeItem {
  return {
    ty: "fl",
    c: k([r, g, b, 1]),
    o: k(100),
    r: 1,
    ...extra,
  } as ShapeItem;
}

function tr(extra: Record<string, unknown> = {}): ShapeItem {
  return { ty: "tr", ...extra } as ShapeItem;
}

function layer(shapes: ShapeItem[], extra: Partial<Layer> = {}): Layer {
  return { ty: 4, ip: 0, op: 60, ks: {}, shapes, ...extra };
}

function comp(layers: Layer[], extra: Partial<Lottie> = {}): Lottie {
  return { w: 64, h: 64, fr: 60, ip: 0, op: 60, layers, ...extra };
}

/** The first vertex of a draw's first path, in canvas pixels. */
function top(draw: {
  matrix: readonly number[];
  paths: { v: readonly Point[] }[];
}): Point {
  const m = draw.matrix as [number, number, number, number, number, number];
  return apply(m, draw.paths[0]?.v[0] ?? [0, 0]);
}

describe("evaluateFrame", () => {
  it("draws later layers and later items below earlier ones", () => {
    const draws = evaluateFrame(
      comp([
        layer([
          { ty: "gr", it: [el(0, 0), fl(1, 0, 0), tr()] },
          { ty: "gr", it: [el(0, 0), fl(0, 1, 0), tr()] },
        ]),
        layer([el(0, 0), fl(0, 0, 1)]),
      ]),
      0,
    );
    expect(draws.map(color)).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  });

  it("styles every path before the style, including earlier nested groups", () => {
    const draws = evaluateFrame(
      comp([
        layer([
          el(1, 1),
          { ty: "gr", it: [el(2, 2), fl(1, 0, 0), tr({ p: k([100, 0]) })] },
          fl(0, 1, 0),
          el(3, 3),
        ]),
      ]),
      0,
    );
    const [outer, inner] = draws;
    // The outer fill covers the first ellipse and the group's, seen through
    // the group's transform; not the ellipse after it.
    expect(color(outer)).toEqual([0, 1, 0]);
    expect(outer?.paths.map((p) => p.v[0])).toEqual([
      [102, -3],
      [1, -4],
    ]);
    // The group's own fill covers only its ellipse, in the group's space.
    expect(color(inner)).toEqual([1, 0, 0]);
    expect(inner?.paths.map((p) => p.v[0])).toEqual([[2, -3]]);
    expect(top(inner ?? { matrix: [], paths: [] })).toEqual([102, -3]);
  });

  it("parents transforms but not opacity, and respects in and out points", () => {
    const lottie = comp([
      layer([el(0, 0), fl(1, 1, 1)], {
        ind: 1,
        parent: 2,
        ks: { p: k([10, 0]) },
      }),
      {
        ty: 3,
        ind: 2,
        ip: 0,
        op: 60,
        ks: { p: k([0, 20]), o: k(0), r: k(90) },
      },
      layer([el(0, 0), fl(0, 0, 0)], { ip: 30, op: 40 }),
    ]);
    const [child] = evaluateFrame(lottie, 0);
    expect(child?.alpha).toBe(1);
    // (0, -5) in the child is (10, -5) in the null, turned 90 degrees
    // clockwise to (5, 10), then moved down 20.
    const [x, y] = top(child ?? { matrix: [], paths: [] });
    expect(x).toBeCloseTo(5, 9);
    expect(y).toBeCloseTo(30, 9);
    expect(evaluateFrame(lottie, 29)).toHaveLength(1);
    expect(evaluateFrame(lottie, 30)).toHaveLength(2);
    expect(evaluateFrame(lottie, 40)).toHaveLength(1);
  });

  it("folds fill, group and layer opacity and records translucent groups", () => {
    const [draw] = evaluateFrame(
      comp([
        layer(
          [
            {
              ty: "gr",
              it: [el(0, 0), fl(1, 1, 1, { o: k(50) }), tr({ o: k(50) })],
            },
          ],
          {
            ks: { o: k(80) },
          },
        ),
      ]),
      0,
    );
    expect(draw?.alpha).toBeCloseTo(0.2, 12);
    expect(draw?.translucent).toEqual([
      "layers[0].ks.o",
      "layers[0].shapes[0].it[2].o",
    ]);
  });

  it("reads strokes, fill rules, slots and solids", () => {
    const lottie = comp(
      [
        layer([
          el(0, 0),
          {
            ty: "st",
            c: { a: 0, k: [0, 0, 0, 1], sid: "primary" },
            o: k(100),
            w: k(3),
            lc: 1,
            lj: 1,
            ml: 7,
          } as ShapeItem,
          fl(0, 0, 0, { r: 2 }),
          { ty: "st", c: k([0, 0, 0, 1]), o: k(100), w: k(0) } as ShapeItem,
        ]),
        { ty: 1, ip: 0, op: 60, ks: {}, sw: 20, sh: 10, sc: "#ff8000" },
      ],
      { slots: { primary: { p: k([0.2, 0.4, 0.6, 1]) } } },
    );
    const [solid, fill, stroke, ...rest] = evaluateFrame(lottie, 0);
    // The zero-width stroke draws nothing.
    expect(rest).toEqual([]);
    expect(color(solid)).toEqual(hexColor("#ff8000"));
    expect(solid?.paths[0]?.v).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ]);
    expect(fill?.fillRule).toBe("evenodd");
    expect(stroke?.stroke).toEqual({
      width: 3,
      cap: "butt",
      join: "miter",
      miterLimit: 7,
    });
    expect(stroke?.paint).toEqual({
      kind: "solid",
      color: [0.2, 0.4, 0.6],
      slot: 1,
    });
  });

  it("skips hidden layers and items and matte sources", () => {
    const draws = evaluateFrame(
      comp([
        layer([el(0, 0), fl(1, 0, 0)], { hd: true }),
        layer([el(0, 0), { ...fl(0, 1, 0), hd: true }, fl(0, 0, 1)]),
        layer([el(0, 0), fl(1, 1, 1)], { td: 1 }),
      ]),
      0,
    );
    expect(draws.map(color)).toEqual([[0, 0, 1]]);
  });
});

/** A draw's first vertex in canvas pixels, rounded to 1e-6. */
function first(draw: Draw | undefined): Point {
  const [x, y] = top(draw ?? { matrix: [], paths: [] });
  return [Math.round(x * 1e6) / 1e6 + 0, Math.round(y * 1e6) / 1e6 + 0];
}

describe("precompositions", () => {
  // The asset's ellipse moves right one pixel per frame of its own time.
  const asset = {
    id: "moving",
    layers: [
      layer([el(0, 0), fl(1, 0, 0)], {
        ks: { p: keys([0, [0, 0]], [100, [100, 0]]) },
        ip: 0,
        op: 100,
      }),
    ],
  };
  const precomp = (extra: Partial<Layer>): Lottie =>
    comp(
      [
        {
          ty: 0,
          refId: "moving",
          w: 64,
          h: 64,
          ip: 0,
          op: 100,
          ks: { p: k([10, 20]) },
          ...extra,
        },
      ],
      { assets: [asset] },
    );

  it("plays its layers from the layer's start time, stretched", () => {
    // The ellipse's top is at (x, -5) in the asset; the layer moves it by
    // (10, 20).
    expect(first(evaluateFrame(precomp({}), 30)[0])).toEqual([40, 15]);
    expect(first(evaluateFrame(precomp({ st: 10 }), 30)[0])).toEqual([30, 15]);
    expect(first(evaluateFrame(precomp({ st: 10, sr: 2 }), 30)[0])).toEqual([
      20, 15,
    ]);
    expect(precompFrame({ st: 10, sr: 2, op: 100 }, 30, 60)).toBe(10);
  });

  it("remaps time to seconds times the frame rate", () => {
    // Half a second is frame 30 at 60 fps, whatever the parent's frame.
    const remapped = precomp({ tm: k(0.5) });
    expect(first(evaluateFrame(remapped, 3)[0])).toEqual([40, 15]);
    // lottie-web steps a remap that lands on the layer's out point back a
    // frame (CompElement.js:49-54).
    expect(precompFrame({ tm: k(100 / 60), op: 100 }, 0, 60)).toBe(99);
    expect(precompFrame({ tm: k(0.5), st: 10, sr: 2, op: 100 }, 0, 60)).toBe(
      30,
    );
    // Without the feature, time runs as if unmapped.
    expect(
      precompFrame({ tm: k(0.5), op: 100 }, 3, 60, new Set(["time-remap"])),
    ).toBe(3);
  });

  it("tests its layers' in and out points in its own time", () => {
    const late = precomp({ st: -50 });
    // Frame 60 of the parent is frame 110 of the asset: past its layer.
    expect(evaluateFrame(late, 60)).toEqual([]);
    expect(evaluateFrame(late, 40)).toHaveLength(1);
  });

  it("records its rectangle, folds its opacity and nests its transform", () => {
    const [draw] = evaluateFrame(
      precomp({ ks: { p: k([10, 20]), o: k(50) } }),
      0,
    );
    expect(draw?.alpha).toBe(0.5);
    expect(draw?.translucent).toEqual(["layers[0].ks.o"]);
    expect(draw?.precomps).toEqual([
      { path: "layers[0]", matrix: [1, 0, 0, 1, 10, 20], w: 64, h: 64 },
    ]);
    expect(draw?.path).toBe("assets[0].layers[0].shapes[1]");
  });

  it("draws nothing when the entry ignores precompositions", () => {
    expect(
      evaluateFrame(precomp({}), 0, { ignore: new Set(["precomps"]) }),
    ).toEqual([]);
  });

  it("names a missing asset", () => {
    expect(() =>
      evaluateFrame(comp([{ ty: 0, refId: "x", ip: 0, op: 1 }]), 0),
    ).toThrow(/no precomposition asset "x"/);
  });
});

describe("masks", () => {
  const masked = (
    masks: ReturnType<typeof mask>[],
    extra: Partial<Layer> = {},
  ) =>
    evaluateFrame(
      comp([
        layer([el(0, 0), fl(1, 1, 1)], { masksProperties: masks, ...extra }),
      ]),
      0,
    );

  it("turns a layer's masks into one clip in the layer's space", () => {
    const [draw] = masked(
      [
        mask("a", square(0, 0, 10, 10)),
        mask("s", square(2, 2, 4, 4)),
        mask("i", square(1, 1, 9, 9)),
        mask("n", square(0, 0, 1, 1)),
        mask("f", square(5, 5, 6, 6)),
        mask("l", square(5, 5, 6, 6)),
        mask("d", square(5, 5, 6, 6)),
      ],
      { ks: { p: k([7, 0]) } },
    );
    const clip = draw?.clips[0] as MaskClip;
    expect(clip.kind).toBe("mask");
    expect(clip.matrix).toEqual([1, 0, 0, 1, 7, 0]);
    // n is off; f, l and d add, as lottie-web draws them.
    expect(clip.masks.map((m) => m.mode)).toEqual([
      "a",
      "s",
      "i",
      "a",
      "a",
      "a",
    ]);
    expect(clip.universe.v).toEqual(square(0, 0, 64, 64));
  });

  it("inverts with the animation's rectangle and ignores open paths", () => {
    const open = mask("a", square(0, 0, 10, 10));
    (open.pt as { k: { c: boolean } }).k.c = false;
    const [draw] = masked([
      mask("a", square(0, 0, 10, 10), { inv: true }),
      open,
      mask("a", square(0, 0, 10, 10), { x: k(3) }),
    ]);
    const [inverted, openMask, expanded] =
      (draw?.clips[0] as MaskClip | undefined)?.masks ?? [];
    expect(inverted?.paths.map((p) => p.v)).toEqual([
      square(0, 0, 64, 64),
      square(0, 0, 10, 10),
    ]);
    expect(openMask?.paths).toEqual([]);
    expect(expanded?.expansion).toBe(3);
  });

  it("drops masks the entry ignores", () => {
    const draws = evaluateFrame(
      comp([
        layer([el(0, 0), fl(1, 1, 1)], {
          masksProperties: [mask("a", square(0, 0, 1, 1))],
        }),
      ]),
      0,
      { ignore: new Set(["masks"]) },
    );
    expect(draws[0]?.clips).toEqual([]);
  });
});

describe("track mattes", () => {
  const source = layer([el(0, 0), fl(1, 1, 1)], { ind: 5, td: 1 });

  it("clips the layer below a matte source, which draws only through it", () => {
    const draws = evaluateFrame(
      comp([source, layer([el(0, 0), fl(1, 0, 0)], { tt: 1 })]),
      0,
    );
    expect(draws.map(color)).toEqual([[1, 0, 0]]);
    const clip = draws[0]?.clips[0] as MatteClip;
    expect(clip.kind).toBe("matte");
    expect(clip.inverted).toBe(false);
    expect(clip.source.map(color)).toEqual([[1, 1, 1]]);
    const [inverted] = evaluateFrame(
      comp([source, layer([el(0, 0), fl(1, 0, 0)], { tt: 2 })]),
      0,
    );
    expect((inverted?.clips[0] as MatteClip | undefined)?.inverted).toBe(true);
  });

  it("takes the source `tp` names", () => {
    const draws = evaluateFrame(
      comp([
        source,
        layer([el(0, 0), fl(0, 1, 0)]),
        layer([el(0, 0), fl(1, 0, 0)], { tt: 1, tp: 5 }),
      ]),
      0,
    );
    const matted = draws.find((d) => d.clips.length > 0);
    expect(color(matted)).toEqual([1, 0, 0]);
    expect(
      (matted?.clips[0] as MatteClip | undefined)?.source.map(color),
    ).toEqual([[1, 1, 1]]);
  });

  it("draws the target unclipped when the entry ignores mattes", () => {
    const draws = evaluateFrame(
      comp([source, layer([el(0, 0), fl(1, 0, 0)], { tt: 1 })]),
      0,
      { ignore: new Set(["mattes"]) },
    );
    expect(draws.map((d) => d.clips)).toEqual([[]]);
  });
});

describe("modifiers and transforms", () => {
  it("rounds the corners of the paths in scope", () => {
    const [draw] = evaluateFrame(
      comp([
        layer([
          { ty: "rc", p: k([0, 0]), s: k([20, 20]), r: k(0) } as ShapeItem,
          { ty: "rd", r: k(4) } as ShapeItem,
          fl(1, 1, 1),
        ]),
      ]),
      0,
    );
    // Four sharp corners become eight vertices.
    expect(draw?.paths[0]?.v).toHaveLength(8);
  });

  it("leaves corners sharp when the entry ignores round corners", () => {
    const [draw] = evaluateFrame(
      comp([
        layer([
          { ty: "rc", p: k([0, 0]), s: k([20, 20]), r: k(0) } as ShapeItem,
          { ty: "rd", r: k(4) } as ShapeItem,
          fl(1, 1, 1),
        ]),
      ]),
      0,
      { ignore: new Set(["round-corners"]) },
    );
    expect(draw?.paths[0]?.v).toHaveLength(4);
  });

  it("ignores a shape layer's start time and stretch, as lottie-web does", () => {
    // Keyframes are in composition frames whatever the layer's st and sr
    // (PropertyFactory.js:264), and its in and out points too
    // (RenderableElement.js:49).
    const moving = (extra: Partial<Layer>) =>
      evaluateFrame(
        comp([
          layer([el(0, 0), fl(1, 1, 1)], {
            ks: { p: keys([0, [0, 0]], [10, [10, 0]]) },
            ...extra,
          }),
        ]),
        5,
      )[0]?.matrix[4];
    expect(moving({ st: 3, sr: 2 })).toBe(moving({}));
    expect(moving({ st: 3, ip: 6 })).toBeUndefined();
  });

  it("turns an auto-oriented layer along its motion", () => {
    const lottie = comp([
      layer([el(0, 0), fl(1, 1, 1)], {
        ao: 1,
        ks: { p: keys([0, [0, 0]], [10, [10, 10]]) },
      }),
    ]);
    const [draw] = evaluateFrame(lottie, 5);
    const [a, b] = draw?.matrix ?? [];
    expect(Math.atan2(b ?? 0, a ?? 1)).toBeCloseTo(Math.PI / 4, 6);
    const [still] = evaluateFrame(lottie, 5, {
      ignore: new Set(["auto-orient"]),
    });
    expect(still?.matrix.slice(0, 4)).toEqual([1, 0, 0, 1]);
  });

  it("plays loop expressions once the file is prepared", () => {
    const lottie = comp([
      layer([el(0, 0), fl(1, 1, 1)], {
        ks: {
          p: {
            ...keys([0, [0, 0]], [10, [10, 0]]),
            x: "var $bm_rt;\n$bm_rt = loopOut('cycle');",
          },
        } as Layer["ks"],
      }),
    ]);
    // Frame 13 plays frame 3 again.
    expect(evaluateFrame(prepare(lottie), 13)[0]?.matrix[4]).toBeCloseTo(3, 9);
    // Unprepared, the value holds after the last keyframe.
    expect(evaluateFrame(lottie, 13)[0]?.matrix[4]).toBe(10);
    // Ignored, the prepared file holds too.
    expect(
      evaluateFrame(
        prepare(lottie, { ignore: new Set(["loop-expressions"]) }),
        13,
      )[0]?.matrix[4],
    ).toBe(10);
  });
});
