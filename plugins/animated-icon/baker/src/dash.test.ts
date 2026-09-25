import { describe, expect, it } from "vite-plus/test";

import { dashPath, dashSpans } from "./dash.ts";
import { bezierCmds, toPath } from "./geometry.ts";
import type { Point } from "./pack.ts";
import { dashAt } from "./scene.ts";
import { canvasKit } from "./skia.ts";

describe("dashSpans", () => {
  it("lays one pair along the length from the offset", () => {
    expect(dashSpans(100, [20, 10], 0)).toEqual([
      [0, 20],
      [30, 50],
      [60, 80],
      [90, 100],
    ]);
    // A positive offset moves the pattern back along the path; a negative
    // one forward, the same as its complement to a period.
    expect(dashSpans(50, [20, 10], 5)).toEqual([
      [0, 15],
      [25, 45],
    ]);
    expect(dashSpans(50, [20, 10], 25)).toEqual([
      [5, 25],
      [35, 50],
    ]);
    expect(dashSpans(50, [20, 10], -5)).toEqual(dashSpans(50, [20, 10], 25));
  });

  it("walks several pairs in order", () => {
    expect(dashSpans(60, [10, 5, 2, 3], 0)).toEqual([
      [0, 10],
      [15, 17],
      [20, 30],
      [35, 37],
      [40, 50],
      [55, 57],
    ]);
  });

  it("keeps zero-length dashes, as Skia does, for dotted strokes", () => {
    expect(dashSpans(50, [0, 10], 0)).toEqual([
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
      [40, 40],
    ]);
    expect(dashSpans(50, [0, 10], 5)).toEqual([
      [5, 5],
      [15, 15],
      [25, 25],
      [35, 35],
      [45, 45],
    ]);
    // A dash that ends exactly at the start is skipped, not kept as a dot.
    expect(dashSpans(30, [10, 5], 10)).toEqual([
      [5, 15],
      [20, 30],
    ]);
  });

  it("draws nothing for an empty pattern or path", () => {
    expect(dashSpans(100, [0, 0], 0)).toEqual([]);
    expect(dashSpans(0, [10, 10], 0)).toEqual([]);
  });
});

describe("dashAt", () => {
  const item = (n: string, v: number) => ({ n, v: { a: 0, k: v } });

  it("reads the dash and gap values in order and the offset", () => {
    expect(
      dashAt(
        [item("d", 10), item("g", 5), item("d", 2), item("g", 3), item("o", 7)],
        0,
      ),
    ).toEqual({ intervals: [10, 5, 2, 3], offset: 7 });
  });

  it("repeats an odd list and draws solid for a negative or all-zero one", () => {
    expect(dashAt([item("d", 10)], 0)).toEqual({
      intervals: [10, 10],
      offset: 0,
    });
    expect(dashAt([item("d", 10), item("g", -1)], 0)).toBeUndefined();
    expect(dashAt([item("d", 0), item("g", 0)], 0)).toBeUndefined();
  });
});

describe("dashPath", async () => {
  const ck = await canvasKit();
  const square: Point[] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const path = (closed: boolean) =>
    toPath(ck, bezierCmds(ck, [{ closed, v: square, i: square, o: square }]));
  const contours = (cmds: number[]): number[][] => {
    const out: number[][] = [];
    for (let i = 0; i < cmds.length;) {
      const verb = cmds[i] as number;
      if (verb === ck.MOVE_VERB) out.push([]);
      const size =
        verb === ck.MOVE_VERB || verb === ck.LINE_VERB
          ? 3
          : verb === ck.CLOSE_VERB
            ? 1
            : verb === ck.QUAD_VERB
              ? 5
              : verb === ck.CONIC_VERB
                ? 6
                : 7;
      out.at(-1)?.push(...cmds.slice(i + 1, i + size));
      i += size;
    }
    return out;
  };

  it("joins the last dash of a closed contour to the first", () => {
    // 400 long, [60, 40] from 20: the dash at 380..400 runs on into 0..40.
    const dashed = contours(dashPath(ck, path(true), [60, 40], 20));
    expect(dashed).toHaveLength(4);
    const joined = dashed.at(-1) ?? [];
    expect(joined.slice(0, 2)).toEqual([0, 20]);
    expect(joined).toContain(0);
    expect(joined.slice(-2)).toEqual([40, 0]);
    // Without a dash through the start, every dash stands alone.
    expect(contours(dashPath(ck, path(true), [60, 40], 0))).toHaveLength(4);
  });

  it("keeps separate ends on an open contour", () => {
    const dashed = contours(dashPath(ck, path(false), [60, 40], 0));
    // 300 long: 0..60, 100..160, 200..260.
    expect(dashed).toHaveLength(3);
    expect(dashed[0]?.slice(0, 2)).toEqual([0, 0]);
  });

  it("strokes zero-length dashes as dots with round or square caps", () => {
    // 300 long, [0, 50]: a dot every 50, none at the very end.
    const dotted = dashPath(ck, path(false), [0, 50], 0);
    expect(contours(dotted)).toHaveLength(6);
    const outlined = (cap: "Butt" | "Round" | "Square") => {
      const dashed = toPath(ck, dotted);
      const stroked = dashed.makeStroked({
        width: 6,
        cap: ck.StrokeCap[cap],
        join: ck.StrokeJoin.Round,
      });
      const cmds = stroked ? Array.from(stroked.toCmds()) : [];
      const bounds = stroked ? Array.from(stroked.computeTightBounds()) : [];
      dashed.delete();
      stroked?.delete();
      return { dots: contours(cmds).length, bounds };
    };
    const round = outlined("Round");
    expect(round.dots).toBe(6);
    // The first dot sits at (0, 0) and the last at (100, 100), radius 3.
    expect(round.bounds.map((v) => Math.round(v))).toEqual([-3, -3, 103, 103]);
    expect(outlined("Square").dots).toBe(6);
    expect(outlined("Butt").dots).toBe(0);
  });

  it("dashes several pairs", () => {
    const dashed = contours(dashPath(ck, path(false), [30, 10, 5, 5], 0));
    // 300 long, period 50: two dashes a period.
    expect(dashed).toHaveLength(12);
  });
});
