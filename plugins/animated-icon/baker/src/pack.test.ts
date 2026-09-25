import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "../../js/src/catalog.ts";
import { circle, rect } from "./fixtures.ts";
import {
  type AnimationInput,
  type CatalogInput,
  type OpInput,
  packCatalog,
  type PaintInput,
  polygon,
} from "./pack.ts";

const square = rect(2, 3, 10, 12);
const shapes = [
  { contours: [square], pxPerUnit: 2 },
  { contours: [circle(8, 8, 5)], pxPerUnit: 2 },
  { contours: [rect(0, 0, 1, 1)], pxPerUnit: 1 },
];
const linear: PaintInput = {
  kind: "linear",
  from: [2, 3],
  to: [10, 3],
  stops: [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 0.5, color: [0, 1, 0, 0.5] },
    { offset: 1, color: [0, 0, 1, 1] },
  ],
  opacity: 0.5,
};

function op(
  shape: number,
  paint: PaintInput,
  fillRule: "nonzero" | "evenodd" = "nonzero",
): OpInput {
  return {
    bbox: [0, 0, 16, 16],
    affine: [1, 0, 0, 1, 0, 0],
    shape,
    fillRule,
    paint,
  };
}

function animation(name: string, frames: OpInput[][]): AnimationInput {
  return {
    name,
    canvas: [16, 16],
    box: [0, 0, 16, 16],
    displayPx: 32,
    fps: 30,
    frames: frames.map((ops) => ({ ops })),
  };
}

const red: PaintInput = { kind: "solid", color: [1, 0, 0, 0.5], slot: 1 };
const blue: PaintInput = { kind: "solid", color: [0, 0, 1, 1], slot: 2 };

const input: CatalogInput = {
  shapes,
  animations: [
    animation("a", [
      [op(0, red)],
      [op(0, red), op(1, linear, "evenodd")],
      [op(0, red)],
    ]),
    animation("b", [[op(1, blue), op(0, linear)]]),
    { name: "a#tail", of: "a", start: 1, count: 2 },
  ],
};

function parse(catalogInput: CatalogInput): {
  catalog: Catalog;
  at: (i: number) => number[];
} {
  const catalog = Catalog.parse(packCatalog(catalogInput).bytes);
  const at = (i: number): number[] =>
    Array.from(catalog.texels.subarray(4 * i, 4 * i + 4));
  return { catalog, at };
}

describe("packCatalog", () => {
  const { catalog, at } = parse(input);
  const [a, b, tail] = catalog.animations;

  it("writes frame records first, then op lists, shapes and gradients", () => {
    expect(catalog.enumValues()).toEqual(["none", "a", "b", "a#tail"]);
    expect(a).toMatchObject({
      frameTexel: 0,
      frameCount: 3,
      fps: 30,
      displayPx: 32,
    });
    expect(b).toMatchObject({ frameTexel: 3, frameCount: 1 });
    // Frames 0 and 2 of `a` share one op list.
    expect(at(0)).toEqual([1, 4, 0, 0]);
    expect(at(1)).toEqual([2, 8, 0, 0]);
    expect(at(2)).toEqual(at(0));
    expect(at(3)).toEqual([2, 16, 0, 0]);
  });

  it("encodes an op's bbox, affine, shape, style and paint", () => {
    const place = at(6);
    expect(at(4)).toEqual([0, 0, 16, 16]);
    expect(at(5)).toEqual([1, 0, 0, 1]);
    // The shape is moved so its bounds start at 0; the op's translation
    // moves by the same amount.
    expect(place.slice(0, 2)).toEqual([-2, -3]);
    // Slot 1, nonzero, solid; premultiplied color.
    expect(place[3]).toBe(1);
    expect(at(7)).toEqual([0.5, 0, 0, 0.5]);
    // Op 1 of frame 1: slot 0, even-odd (4), linear (8).
    expect(at(8 + 4 + 2)[3]).toBe(4 | 8);
    // Op 0 of `b`: slot 2.
    expect(at(16 + 2)[3]).toBe(2);
  });

  it("shares shapes by index and gradients by content", () => {
    const shapeOf = (o: number): number => at(o + 2)[2] ?? -1;
    expect(shapeOf(4)).toBe(shapeOf(8));
    expect(shapeOf(8 + 4)).toBe(shapeOf(16));
    expect(shapeOf(4)).not.toBe(shapeOf(8 + 4));
    // The linear gradient of frame 1 (on shape 1) and of `b` (on shape 0)
    // are in different shape spaces, so they are two records.
    const g1 = at(8 + 4 + 3);
    const g2 = at(16 + 4 + 3);
    expect(g1.slice(1)).toEqual([3, 0.5, 0]);
    expect(g1[0]).not.toBe(g2[0]);
  });

  it("lays out a gradient record", () => {
    const g = at(16 + 4 + 3)[0] ?? 0;
    // Shape 0 is moved by (-2, -3).
    expect(at(g)).toEqual([0, 0, 8, 0]);
    expect(at(g + 1)).toEqual([0, 0.5, 1, 1]);
    expect(at(g + 2)).toEqual([1, 1, 1, 1]);
    expect(at(g + 3)).toEqual([1, 0, 0, 1]);
    expect(at(g + 4)).toEqual([0, 1, 0, 0.5]);
    expect(at(g + 5)).toEqual([0, 0, 1, 1]);
  });

  it("lays out a shape: counts, transform, band headers, lists, curves", () => {
    const s = at(4 + 2)[2] ?? 0;
    const [h, v] = at(s);
    expect([h, v]).toEqual([1, 1]);
    // Moved to the origin: 8 × 9 units.
    expect(at(s + 1)).toEqual([Math.fround(1 / 9), 0, Math.fround(1 / 8), 0]);
    const [, count, list] = at(s + 2);
    expect(count).toBe(4);
    // Curves follow the lists; the contour closes with its first point.
    const curves = (list ?? 0) + 2 + 2;
    expect(at(curves)).toEqual([0, 0, 4, 0]);
    expect(at(curves + 4)).toEqual([0, 0, 0, 0]);
  });

  it("points marker entries into their animation's frames", () => {
    expect(tail).toMatchObject({
      frameTexel: 1,
      frameCount: 2,
      fps: 30,
      box: a?.box,
      canvas: a?.canvas,
    });
    expect(tail?.loopRate).toBe(Math.fround(30 / 2));
  });

  it("is deterministic and reports each entry's texels", () => {
    const first = packCatalog(input);
    expect(packCatalog(input).bytes).toEqual(first.bytes);
    const [sa, sb, st] = first.animations;
    expect(sa).toMatchObject({ name: "a", frameTexels: 3, opTexels: 12 });
    expect(sb).toMatchObject({
      name: "b",
      frameTexels: 1,
      opTexels: 8,
      shapeTexels: 0,
    });
    expect(st).toEqual({
      name: "a#tail",
      frameTexels: 0,
      opTexels: 0,
      shapeTexels: 0,
      gradientTexels: 0,
      bytes: 0,
    });
    const total = first.animations.reduce(
      (sum, s) =>
        sum + s.frameTexels + s.opTexels + s.shapeTexels + s.gradientTexels,
      0,
    );
    expect(total).toBe(first.texelCount);
    expect(sa?.bytes).toBe(
      16 *
        ((sa?.frameTexels ?? 0) +
          (sa?.opTexels ?? 0) +
          (sa?.shapeTexels ?? 0) +
          (sa?.gradientTexels ?? 0)),
    );
  });

  it("drops unused shapes and writes an empty catalog", () => {
    const empty = packCatalog({ shapes, animations: [] });
    expect(empty.texelCount).toBe(0);
    expect(Catalog.parse(empty.bytes).enumValues()).toEqual(["none"]);
    expect(empty.bytes.length).toBe(64);
  });

  it("uses a 2048-wide texture when asked", () => {
    const wide = packCatalog({ ...input, textureWidth: 2048 });
    expect([wide.textureWidth, wide.textureHeight]).toEqual([2048, 1]);
    expect(Catalog.parse(wide.bytes).artShift).toBe(11);
  });

  it("keeps a frame with no ops", () => {
    const { at: empty } = parse({
      shapes,
      animations: [animation("e", [[], [op(2, red)]])],
    });
    expect(empty(0)).toEqual([0, 0, 0, 0]);
    expect(empty(1)).toEqual([1, 2, 0, 0]);
  });

  it("rejects what readers would reject and what the baker limits", () => {
    const pack = (
      animations: CatalogInput["animations"],
      shapeList = shapes,
    ): unknown => packCatalog({ shapes: shapeList, animations });
    const a0 = animation("a", [[op(0, red)]]);
    expect(() => pack([{ ...a0, name: "None" }])).toThrow(/must match/);
    expect(() => pack([{ ...a0, name: "none" }])).toThrow(/must match/);
    expect(() => pack([a0, a0])).toThrow(/repeated/);
    expect(() =>
      pack(Array.from({ length: 511 }, (_, i) => ({ ...a0, name: `a${i}` }))),
    ).toThrow(/511 entries/);
    expect(() => pack([animation("a", [])])).toThrow(/0 frames/);
    expect(() => pack([animation("a", [Array(65).fill(op(0, red))])])).toThrow(
      /65 ops/,
    );
    expect(() => pack([{ ...a0, box: [10, 10, 5, 50] }])).toThrow(
      /box \[10, 10, 5, 50\]/,
    );
    expect(() => pack([{ ...a0, displayPx: 0 }])).toThrow(/displayPx 0/);
    expect(() => pack([{ ...a0, fps: Number.NaN }])).toThrow(/fps NaN/);
    expect(() => pack([{ ...a0, canvas: [0, 8] }])).toThrow(/canvas \[0, 8\]/);
    expect(() => pack([animation("a", [[op(3, red)]])])).toThrow(
      /shape 3 does not exist/,
    );
    expect(() =>
      pack([animation("a", [[{ ...op(0, red), bbox: [1, 0, 0, 1] }]])]),
    ).toThrow(/bbox/);
    expect(() =>
      pack([
        animation("a", [
          [{ ...op(0, red), affine: [1, 0, 0, Infinity, 0, 0] }],
        ]),
      ]),
    ).toThrow(/affine/);
    expect(() =>
      pack([
        animation("a", [[op(0, { kind: "solid", color: [1.5, 0, 0, 1] })]]),
      ]),
    ).toThrow(/color/);
    const gradient = (
      stops: { offset: number; color: [number, number, number, number] }[],
      opacity = 1,
    ): PaintInput => ({
      kind: "radial",
      from: [0, 0],
      to: [1, 0],
      stops,
      opacity,
    });
    const stop = (
      offset: number,
    ): { offset: number; color: [number, number, number, number] } => ({
      offset,
      color: [1, 1, 1, 1],
    });
    expect(() =>
      pack([animation("a", [[op(0, gradient([stop(0)]))]])]),
    ).toThrow(/1 stops/);
    expect(() =>
      pack([
        animation("a", [
          [op(0, gradient(Array.from({ length: 9 }, () => stop(0))))],
        ]),
      ]),
    ).toThrow(/9 stops/);
    expect(() =>
      pack([animation("a", [[op(0, gradient([stop(0.5), stop(0.2)]))]])]),
    ).toThrow(/non-decreasing/);
    expect(() =>
      pack([animation("a", [[op(0, gradient([stop(0), stop(1)], 2))]])]),
    ).toThrow(/opacity 2/);
    expect(() =>
      pack([a0, { name: "a#m", of: "a", start: 0, count: 2 }]),
    ).toThrow(/frames 0..2/);
    expect(() =>
      pack([a0, { name: "a#m", of: "b", start: 0, count: 1 }]),
    ).toThrow(/"b" is not an animation/);
    expect(() =>
      pack([
        a0,
        { name: "a#m", of: "a", start: 0, count: 1 },
        { name: "a#n", of: "a#m", start: 0, count: 1 },
      ]),
    ).toThrow(/"a#m" is not an animation/);
    expect(() =>
      pack(
        [animation("a", [[op(0, red)]])],
        [{ contours: [[]], pxPerUnit: 1 }],
      ),
    ).toThrow(/no curves/);
    expect(() =>
      pack(
        [animation("a", [[op(0, red)]])],
        [{ contours: [square], pxPerUnit: 0 }],
      ),
    ).toThrow(/pxPerUnit/);
    // One band lists every curve of a shape too small to have more.
    const busy = Array.from({ length: 300 }, (_, k) =>
      polygon([
        [k / 300, 0],
        [k / 300 + 0.001, 0.5],
        [k / 300, 1],
      ]),
    );
    expect(() =>
      pack(
        [animation("a", [[op(0, red)]])],
        [{ contours: busy, pxPerUnit: 1 }],
      ),
    ).toThrow(/lists 900 curves, at most 256/);
  });
});
