import type { CanvasKit, Path } from "canvaskit-wasm";
import { describe, expect, it } from "vite-plus/test";

import {
  bezierCmds,
  Booleans,
  type ClipGeometry,
  dashCmds,
  type DrawGeometry,
  fillRuleOf,
  finalPath,
  fitPath,
  toPath,
  TOLERANCE_PX,
} from "./geometry.ts";
import type { Point } from "./pack.ts";
import { distanceToQuad } from "./quadratic.ts";
import type { BezierPath } from "./shapes.ts";
import { canvasKit } from "./skia.ts";

const ck = await canvasKit();
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/** A rectangle path; clockwise on screen unless `ccw`. */
function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ccw = false,
): BezierPath {
  const v: Point[] = ccw
    ? [
        [x0, y0],
        [x0, y1],
        [x1, y1],
        [x1, y0],
      ]
    : [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
  return { closed: true, v, i: v, o: v };
}

function fill(paths: BezierPath[], clips: ClipGeometry[] = []): DrawGeometry {
  return { cmds: bezierCmds(ck, paths), fillRule: "nonzero", clips };
}

/** A path's area in square units, from an anti-aliased raster (0..256). */
function area(path: Path): number {
  const surface = ck.MakeSurface(256, 256);
  if (!surface) throw new Error("no surface");
  const canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setColor(ck.BLACK);
  canvas.drawPath(path, paint);
  const pixels = canvas.readPixels(0, 0, {
    width: 256,
    height: 256,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  }) as Uint8Array;
  let sum = 0;
  for (let i = 3; i < pixels.length; i += 4) sum += pixels[i] as number;
  paint.delete();
  surface.dispose();
  return sum / 255;
}

function region(g: DrawGeometry, booleans = new Booleans(ck)): number {
  const path = finalPath(ck, g, 1, booleans, "test");
  const a = area(path);
  path.delete();
  return a;
}

const mask = (
  masks: { mode: "a" | "s" | "i"; paths: BezierPath[]; expansion?: number }[],
): ClipGeometry => ({
  kind: "mask",
  rel: IDENTITY,
  universe: null,
  masks: masks.map((m) => ({
    mode: m.mode,
    cmds: bezierCmds(ck, m.paths),
    expansion: m.expansion ?? 0,
  })),
});

describe("masks", () => {
  const square = [rect(0, 0, 100, 100)];

  it("adds, subtracts and intersects in order", () => {
    expect(
      region(
        fill(square, [mask([{ mode: "a", paths: [rect(0, 0, 50, 100)] }])]),
      ),
    ).toBeCloseTo(5000, 0);
    // A first subtract or intersect starts from everything.
    expect(
      region(
        fill(square, [mask([{ mode: "s", paths: [rect(0, 0, 50, 100)] }])]),
      ),
    ).toBeCloseTo(5000, 0);
    expect(
      region(
        fill(square, [mask([{ mode: "i", paths: [rect(25, 25, 75, 75)] }])]),
      ),
    ).toBeCloseTo(2500, 0);
    expect(
      region(
        fill(square, [
          mask([
            { mode: "a", paths: [rect(0, 0, 60, 100)] },
            { mode: "s", paths: [rect(0, 0, 30, 100)] },
          ]),
        ]),
      ),
    ).toBeCloseTo(3000, 0);
    expect(
      region(
        fill(square, [
          mask([
            { mode: "a", paths: [rect(0, 0, 60, 100)] },
            { mode: "i", paths: [rect(40, 0, 100, 100)] },
          ]),
        ]),
      ),
    ).toBeCloseTo(2000, 0);
    expect(
      region(
        fill(square, [
          mask([
            { mode: "a", paths: [rect(0, 0, 20, 100)] },
            { mode: "a", paths: [rect(80, 0, 100, 100)] },
          ]),
        ]),
      ),
    ).toBeCloseTo(4000, 0);
  });

  it("inverts as lottie-web does: the rectangle and the path filled nonzero", () => {
    // Wound against the rectangle, the path is cut out of it...
    const cut = mask([
      { mode: "a", paths: [rect(0, 0, 200, 200), rect(0, 0, 50, 100, true)] },
    ]);
    expect(region(fill(square, [cut]))).toBeCloseTo(5000, 0);
    // ...wound with it, it adds to it (lottie-web's nonzero mask fill).
    const kept = mask([
      { mode: "a", paths: [rect(0, 0, 200, 200), rect(0, 0, 50, 100)] },
    ]);
    expect(region(fill(square, [kept]))).toBeCloseTo(10000, 0);
  });

  it("grows by a stroke twice the expansion wide, with miter joins", () => {
    const grown = mask([
      { mode: "a", paths: [rect(25, 25, 75, 75)], expansion: 5 },
    ]);
    expect(region(fill(square, [grown]))).toBeCloseTo(3600, 0);
  });

  it("clips in the draw's space through the layer's map", () => {
    // The mask sits in a layer shifted 50 left of the draw's space.
    const shifted: ClipGeometry = {
      ...(mask([
        { mode: "a", paths: [rect(50, 0, 150, 100)] },
      ]) as ClipGeometry & { kind: "mask" }),
      rel: [1, 0, 0, 1, -50, 0],
    };
    expect(region(fill(square, [shifted]))).toBeCloseTo(10000, 0);
  });

  it("clips to the composition when it does not hold the draw", () => {
    const edge: ClipGeometry = {
      kind: "mask",
      rel: IDENTITY,
      universe: bezierCmds(ck, [rect(0, 0, 100, 40)]),
      masks: [
        {
          mode: "s",
          cmds: bezierCmds(ck, [rect(0, 0, 50, 100)]),
          expansion: 0,
        },
      ],
    };
    expect(region(fill(square, [edge]))).toBeCloseTo(2000, 0);
  });
});

describe("mattes", () => {
  const square = [rect(0, 0, 100, 100)];
  const matte = (inverted: boolean, sources: BezierPath[][]): ClipGeometry => ({
    kind: "matte",
    inverted,
    sources: sources.map((paths) => ({ geometry: fill(paths), rel: IDENTITY })),
  });

  it("keeps what the source covers (alpha) or what it does not (inverted)", () => {
    expect(
      region(fill(square, [matte(false, [[rect(50, 0, 150, 100)]])])),
    ).toBeCloseTo(5000, 0);
    expect(
      region(fill(square, [matte(true, [[rect(50, 0, 150, 100)]])])),
    ).toBeCloseTo(5000, 0);
  });

  it("unions every draw of the source, strokes included", () => {
    const stroked: DrawGeometry = {
      cmds: bezierCmds(ck, [rect(10, 10, 90, 90)]),
      fillRule: "nonzero",
      stroke: { width: 20, cap: "butt", join: "miter", miterLimit: 4 },
      clips: [],
    };
    const both: ClipGeometry = {
      kind: "matte",
      inverted: false,
      sources: [
        { geometry: fill([rect(0, 0, 10, 10)]), rel: IDENTITY },
        { geometry: stroked, rel: IDENTITY },
      ],
    };
    // The 20-wide ring around 10..90 spans 0..100 minus 20..80.
    expect(region(fill(square, [both]))).toBeCloseTo(10000 - 3600, 0);
  });

  it("hides the target entirely when the source draws nothing", () => {
    expect(region(fill(square, [matte(false, [])]))).toBe(0);
    expect(region(fill(square, [matte(true, [])]))).toBeCloseTo(10000, 0);
  });
});

describe("Booleans", () => {
  /** canvaskit with MakeFromOp replaced for the first `calls` calls. */
  function failing(calls: number, result: (a: Path) => Path | null): CanvasKit {
    let n = 0;
    const Path = new Proxy(ck.Path, {
      get(target, key, receiver) {
        if (key === "MakeFromOp") {
          return (a: Path, b: Path, op: unknown) =>
            n++ < calls ? result(a) : target.MakeFromOp(a, b, op as never);
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return new Proxy(ck, {
      get(target, key, receiver) {
        return key === "Path"
          ? Path
          : (Reflect.get(target, key, receiver) as unknown);
      },
    });
  }
  const a = () => toPath(ck, bezierCmds(ck, [rect(0, 0, 100, 100)]));
  const b = () => toPath(ck, bezierCmds(ck, [rect(50, 0, 150, 100)]));

  it("retries a null result on simplified operands", () => {
    const booleans = new Booleans(failing(1, () => null));
    const result = booleans.op(a(), b(), "intersect", "draw");
    expect(area(result)).toBeCloseTo(5000, 0);
    expect(booleans.fallbacks).toEqual([
      {
        where: "draw",
        op: "intersect",
        problem: "null",
        resolution: "simplified",
      },
    ]);
  });

  it("checks results against a raster and leaves the clip out when every retry fails", () => {
    const empty = () => new ck.Path();
    const booleans = new Booleans(failing(3, empty));
    const result = booleans.op(a(), b(), "intersect", "draw");
    // Left out: the target unclipped.
    expect(area(result)).toBeCloseTo(10000, 0);
    expect(booleans.fallbacks).toEqual([
      {
        where: "draw",
        op: "intersect",
        problem: "area",
        resolution: "left out",
      },
    ]);
    // A union that fails keeps both operands.
    const union = new Booleans(failing(3, () => null)).op(
      a(),
      b(),
      "union",
      "draw",
    );
    expect(area(union)).toBeCloseTo(15000, 0);
  });

  it("accepts sound results and tags them even-odd", () => {
    const booleans = new Booleans(ck);
    const result = booleans.op(a(), b(), "difference", "draw");
    expect(booleans.fallbacks).toEqual([]);
    expect(fillRuleOf(ck, result)).toBe("evenodd");
    expect(area(result)).toBeCloseTo(5000, 0);
  });
});

describe("finalPath", () => {
  it("outlines strokes, and a zero-width stroke draws nothing", () => {
    const line: BezierPath = {
      closed: false,
      v: [
        [10, 50],
        [90, 50],
      ],
      i: [
        [10, 50],
        [90, 50],
      ],
      o: [
        [10, 50],
        [90, 50],
      ],
    };
    const style = {
      width: 10,
      cap: "butt",
      join: "miter",
      miterLimit: 4,
    } as const;
    const g: DrawGeometry = {
      cmds: bezierCmds(ck, [line]),
      fillRule: "nonzero",
      stroke: style,
      clips: [],
    };
    expect(region(g)).toBeCloseTo(800, 0);
    expect(region({ ...g, stroke: { ...style, width: 0 } })).toBe(0);
    // At scale 2 the outline is in device pixels: four times the area.
    const scaled = finalPath(ck, g, 2, new Booleans(ck), "x");
    expect(area(scaled)).toBeCloseTo(3200, 0);
  });

  it("dashes closed contours with several pairs, scaled first", () => {
    // A 100-unit square in a space scaled 0.1: dashes measured at scale 10.
    const small = rect(2, 2, 12, 12);
    const cmds = dashCmds(ck, bezierCmds(ck, [small]), [3, 1, 1, 1], 0, 10);
    const style = {
      width: 1,
      cap: "butt",
      join: "miter",
      miterLimit: 4,
    } as const;
    const path = finalPath(
      ck,
      { cmds, fillRule: "nonzero", stroke: style, clips: [] },
      10,
      new Booleans(ck),
      "x",
    );
    // 40 long, 6-long pattern: 4 of every 6 units drawn, 1 wide; corners
    // inside a dash add up to a quarter unit each.
    const drawn = area(path) / (10 * 10);
    expect(drawn).toBeGreaterThan((40 * 4) / 6 - 0.5);
    expect(drawn).toBeLessThan((40 * 4) / 6 + 1.5);
    path.delete();
  });
});

describe("fitPath", () => {
  it("stays within the tolerance of the source curves", () => {
    const c = 0.5519 * 50;
    const circle: BezierPath = {
      closed: true,
      v: [
        [100, 50],
        [150, 100],
        [100, 150],
        [50, 100],
      ],
      o: [
        [100 + c, 50],
        [150, 100 + c],
        [100 - c, 150],
        [50, 100 - c],
      ],
      i: [
        [100 - c, 50],
        [150, 100 - c],
        [100 + c, 150],
        [50, 100 + c],
      ],
    };
    const path = toPath(ck, bezierCmds(ck, [circle]));
    for (const refined of [false, true]) {
      const [contour] = fitPath(ck, path, refined);
      expect(contour?.length).toBeGreaterThan(4);
      // Every fitted point lies near the circle-like cubic path (the 0.5519
      // circle strays about 0.0003 of the radius).
      for (const [k, curve] of (contour ?? []).entries()) {
        const end = (contour?.[(k + 1) % (contour?.length ?? 1)] ?? curve).on;
        const mid = distanceToQuad([100, 100], [curve.on, curve.ctrl, end]);
        expect(Math.abs(mid - 50)).toBeLessThan(TOLERANCE_PX + 0.05);
      }
    }
    path.delete();
  });
});
