import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { Catalog } from "../../js/src/catalog.ts";
import {
  bakeAnimation,
  bakeCatalog,
  checkEntry,
  checkManifest,
  contourBounds,
  frameCount,
  markerInputs,
  packAnimations,
  sampleTime,
  slug,
  splitContours,
  toAffine,
} from "./bake.ts";
import { pluginRoot } from "./emit.ts";
import {
  comp,
  el,
  fl,
  gr,
  k,
  keys,
  layer,
  mask,
  rc,
  square,
  st,
} from "./lottie.testing.ts";
import { type Contour, polygon } from "./pack.ts";
import { ProfileError } from "./profile.ts";
import { circle } from "./quadratic.ts";
import { formatReport } from "./report.ts";
import type { Lottie, ShapeItem } from "./scene.ts";
import { shade } from "./shade.ts";

const entry = { name: "test", file: "test.json", displayPx: 32 };

/** A 64x64, 60-frame composition with one filled ellipse layer. */
function dot(x = 32, y = 32, size = 20, extra: object = {}): Lottie {
  return comp([layer([el(x, y, size), fl(0, 0, 0)], extra)]);
}

/** The packed catalog of one baked animation. */
async function catalogOf(lottie: unknown, fields: object = {}) {
  const baked = await bakeAnimation({ ...entry, ...fields }, lottie);
  const packed = packAnimations([baked]);
  return { baked, packed, catalog: Catalog.parse(packed.packed.bytes) };
}

/** The shader's coverage (alpha) at canvas point (u, v) of a frame. */
function alphaAt(
  catalog: Catalog,
  record: number,
  frame: number,
  u: number,
  v: number,
): number {
  const animation = catalog.animations[record];
  return shade({
    art: {
      texels: catalog.texture,
      width: catalog.textureWidth,
      height: catalog.textureHeight,
    },
    frameTexel: (animation?.frameTexel ?? 0) + frame,
    uv: [u, v],
    dx: [0.25, 0],
    dy: [0, 0.25],
  }).color[3];
}

describe("timing", () => {
  it("keeps the authored duration at any frame rate", () => {
    expect(frameCount({ ip: 0, op: 90, fr: 60 })).toBe(90);
    expect(frameCount({ ip: 10, op: 40, fr: 30 })).toBe(60);
    expect(frameCount({ ip: 0, op: 360, fr: 60 }, 30)).toBe(180);
    expect(frameCount({ ip: 0, op: 1, fr: 1000 })).toBe(1);
    // Frame i samples Lottie time ip + i * fr / fps.
    expect(sampleTime({ ip: 10, fr: 30 }, 3)).toBe(11.5);
    expect(sampleTime({ ip: 0, fr: 60 }, 3, 30)).toBe(6);
  });
});

describe("contourBounds", () => {
  it("is the exact extent of the curves, not of their control points", () => {
    const [x0, y0, x1, y1] = contourBounds(circle(10, 20, 5));
    expect(x0).toBeCloseTo(5, 12);
    expect(y0).toBeCloseTo(15, 12);
    expect(x1).toBeCloseTo(15, 12);
    expect(y1).toBeCloseTo(25, 12);
  });
});

describe("splitContours", () => {
  it("splits contours whose bounds do not overlap into separate groups", () => {
    const parts = splitContours([
      circle(0, 0, 5),
      circle(20, 0, 5),
      circle(0, 0, 2),
    ]);
    expect(parts.map((p) => p.length)).toEqual([2, 1]);
  });

  it("keeps chains of overlapping contours together", () => {
    expect(
      splitContours([circle(0, 0, 5), circle(20, 0, 5), circle(10, 0, 6)]),
    ).toHaveLength(1);
  });

  it("keeps contours that touch or nearly touch together, so no seam shows", () => {
    const rect = (x0: number, x1: number): Contour =>
      polygon([
        [x0, 0],
        [x1, 0],
        [x1, 10],
        [x0, 10],
      ]);
    expect(splitContours([rect(0, 5), rect(5, 10)])).toHaveLength(1);
    expect(splitContours([rect(0, 5), rect(5.25, 10)], 0.5)).toHaveLength(1);
    expect(splitContours([rect(0, 5), rect(6, 10)], 0.5)).toHaveLength(2);
  });
});

describe("toAffine", () => {
  it("writes a matrix in the catalog's canvas-to-local order", () => {
    // x' = 1x + 3y + 5, y' = 2x + 4y + 6.
    expect(toAffine([1, 2, 3, 4, 5, 6])).toEqual([1, 3, 2, 4, 5, 6]);
  });
});

describe("checkEntry and checkManifest", () => {
  it("names the field that is wrong", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [
        { name: "test", file: "test.json" },
        /^displayPx: expected a finite number > 0, got undefined$/,
      ],
      [{ ...entry, displayPX: 32 }, /^displayPX: unknown field/],
      [{ ...entry, maxDisplayPx: 0 }, /^maxDisplayPx: expected a finite/],
      [{ ...entry, box: [10, 10, 5, 50] }, /^box: expected "canvas" or/],
      [{ ...entry, name: "none" }, /^name: expected a name/],
      [{ ...entry, name: "a#b" }, /^name: expected a name without #/],
      [{ ...entry, heavy: "yes" }, /^heavy: expected true or false/],
      [{ ...entry, fps: -1 }, /^fps: expected a finite number > 0/],
      [{ ...entry, markers: "all" }, /^markers: expected true or an array/],
      [{ ...entry, slots: { primary: ["red"] } }, /^slots: expected/],
      [{ ...entry, slots: { tertiary: [] } }, /^slots: expected/],
      [{ ...entry, tint: 1 }, /^tint: expected true or false/],
    ];
    for (const [fields, message] of bad) {
      expect(() => checkEntry(fields)).toThrow(message);
    }
    checkEntry({
      ...entry,
      fps: 30,
      markers: ["a"],
      slots: { primary: ["#e53935"] },
      tint: false,
    });
  });

  it("checks the manifest's own fields", () => {
    expect(() => checkManifest({ animations: [], outptu: "x" })).toThrow(
      /^outptu: unknown field/,
    );
    expect(() => checkManifest({ animations: {} })).toThrow(
      /^animations: expected an array/,
    );
    expect(() => checkManifest({ animations: [], fps: 0 })).toThrow(
      /^fps: expected a finite number > 0/,
    );
    expect(() => checkManifest({ animations: [], notice: 1 })).toThrow(
      /^notice: expected a string/,
    );
    checkManifest({
      $comment: "",
      output: "a.mlvc",
      js: "a.ts",
      notice: "a.txt",
      fps: 30,
      animations: [],
    });
  });
});

describe("bakeAnimation", () => {
  it("bakes a content box and one shape for a static draw", async () => {
    const { animation, stats } = await bakeAnimation(entry, dot());
    animation.box.forEach((v, i) =>
      expect(v).toBeCloseTo([22, 22, 42, 42][i] as number, 1),
    );
    expect(animation.frames).toHaveLength(60);
    expect(stats).toMatchObject({
      geometries: 1,
      shapes: 1,
      ops: 60,
      maxOps: 1,
    });
    expect(
      (await bakeAnimation({ ...entry, box: "canvas" }, dot())).animation.box,
    ).toEqual([0, 0, 64, 64]);
  });

  it("samples at the entry's frame rate, before the manifest's default", async () => {
    expect(
      (await bakeAnimation({ ...entry, fps: 30 }, dot())).animation.frames,
    ).toHaveLength(30);
    expect(
      (await bakeAnimation(entry, dot(), { fps: 20 })).animation.frames,
    ).toHaveLength(20);
    expect(
      (await bakeAnimation({ ...entry, fps: 30 }, dot(), { fps: 20 })).animation
        .fps,
    ).toBe(30);
  });

  it("shares one shape across rigid motion and places it with each frame's affine", async () => {
    // The dot moves right 1 px a frame and turns; its geometry never changes.
    const moving = comp([
      layer([gr([rc(0, 0, 20, 10), fl(0, 0, 0)])], {
        ks: {
          p: keys([0, [12, 32]], [40, [52, 32]]),
          r: keys([0, 0], [40, 90]),
        },
      }),
    ]);
    const { baked, catalog } = await catalogOf(moving, { box: "canvas" });
    expect(baked.stats).toMatchObject({ geometries: 1, shapes: 1, ops: 60 });
    // Frame 0: a 20x10 bar centred at (12, 32). Frame 40: turned upright
    // at (52, 32).
    expect(alphaAt(catalog, 0, 0, 20, 32)).toBeCloseTo(1, 3);
    expect(alphaAt(catalog, 0, 0, 12, 40)).toBeCloseTo(0, 3);
    expect(alphaAt(catalog, 0, 40, 52, 40)).toBeCloseTo(1, 3);
    expect(alphaAt(catalog, 0, 40, 60, 32)).toBeCloseTo(0, 3);
  });

  it("rejects translucent layers over overlapping shapes unless ignored", async () => {
    const overlapping = comp([
      layer(
        [gr([el(30, 32, 20), fl(1, 0, 0)]), gr([el(36, 32, 20), fl(0, 0, 1)])],
        {
          ks: { o: k(50) },
        },
      ),
    ]);
    await expect(bakeAnimation(entry, overlapping)).rejects.toThrow(
      ProfileError,
    );
    await expect(bakeAnimation(entry, overlapping)).rejects.toThrow(
      /layers\[0\]\.ks\.o: translucent layers or groups over overlapping shapes need profile tier Composite \(M3\)/,
    );
    const { stats } = await bakeAnimation(
      { ...entry, ignore: ["opacity-isolation"] },
      overlapping,
    );
    expect(stats.notes.ignored).toEqual([
      { path: "layers[0].ks.o", feature: "opacity-isolation" },
    ]);
    const apart = comp([
      layer([el(10, 10, 8), fl(0, 0, 0)], { ks: { o: k(50) } }),
      layer([el(50, 50, 8), fl(0, 0, 0)], { ks: { o: k(50) } }),
    ]);
    await expect(bakeAnimation(entry, apart)).resolves.toBeDefined();
  });

  it("rejects precomposition content outside the precomposition unless ignored", async () => {
    const precomp = (x: number): Lottie =>
      comp([{ ty: 0, refId: "c", w: 32, h: 32, ip: 0, op: 60, ks: {} }], {
        assets: [{ id: "c", layers: [layer([el(x, 16, 10), fl(0, 0, 0)])] }],
      });
    await expect(bakeAnimation(entry, precomp(16))).resolves.toBeDefined();
    await expect(bakeAnimation(entry, precomp(30))).rejects.toThrow(
      /layers\[0\]: precomposition content outside the precomposition's bounds need profile tier Composite \(M3\)/,
    );
    await expect(
      bakeAnimation({ ...entry, ignore: ["precomp-clip"] }, precomp(30)),
    ).resolves.toBeDefined();
  });

  it("bakes opaque masks and mattes as booleans, and refuses translucent matte sources", async () => {
    // A 20x20 square with its left half masked off.
    const masked = comp([
      layer([rc(32, 32, 20, 20), fl(0, 0, 0)], {
        masksProperties: [mask("s", square(0, 0, 32, 64))],
      }),
    ]);
    const { catalog } = await catalogOf(masked, { box: "canvas" });
    expect(alphaAt(catalog, 0, 0, 28, 32)).toBeCloseTo(0, 3);
    expect(alphaAt(catalog, 0, 0, 36, 32)).toBeCloseTo(1, 3);
    // The same through an inverted matte of the left half.
    const source = layer([rc(16, 32, 32, 64), fl(1, 1, 1)], { td: 1 });
    const matted = comp([
      source,
      layer([rc(32, 32, 20, 20), fl(0, 0, 0)], { tt: 2 }),
    ]);
    const inverted = await catalogOf(matted, { box: "canvas" });
    expect(alphaAt(inverted.catalog, 0, 0, 28, 32)).toBeCloseTo(0, 3);
    expect(alphaAt(inverted.catalog, 0, 0, 36, 32)).toBeCloseTo(1, 3);
    // An alpha matte keeps the left half instead.
    const alpha = await catalogOf(
      comp([source, layer([rc(32, 32, 20, 20), fl(0, 0, 0)], { tt: 1 })]),
      {
        box: "canvas",
      },
    );
    expect(alphaAt(alpha.catalog, 0, 0, 28, 32)).toBeCloseTo(1, 3);
    expect(alphaAt(alpha.catalog, 0, 0, 36, 32)).toBeCloseTo(0, 3);
    const translucent = comp([
      layer([rc(16, 32, 32, 64), fl(1, 1, 1, { o: k(50) })], { td: 1 }),
      layer([rc(32, 32, 20, 20), fl(0, 0, 0)], { tt: 1 }),
    ]);
    await expect(bakeAnimation(entry, translucent)).rejects.toThrow(
      /layers\[1\]\.tt: track mattes with translucent sources need profile tier Composite \(M3\)/,
    );
  });

  it("bakes gradients, and refuses more than eight merged stops unless ignored", async () => {
    const gradient = (values: number[], p: number): Lottie =>
      comp([
        layer([
          rc(32, 32, 40, 40),
          {
            ty: "gf",
            t: 1,
            s: k([12, 32]),
            e: k([52, 32]),
            o: k(100),
            r: 1,
            g: { p, k: k(values) },
          } as ShapeItem,
        ]),
      ]);
    const two = await catalogOf(gradient([0, 1, 0, 0, 1, 0, 0, 1], 2), {
      box: "canvas",
    });
    const paint = two.baked.animation.frames[0]?.ops[0]?.paint;
    expect(paint).toMatchObject({
      kind: "linear",
      from: [12, 32],
      to: [52, 32],
      opacity: 1,
    });
    const colors = Array.from({ length: 5 }, (_, i) => [i / 4, 0, 0, 0]).flat();
    const alphas = [0.1, 1, 0.3, 1, 0.6, 1, 0.9, 1];
    const many = gradient([...colors, ...alphas], 5);
    await expect(bakeAnimation(entry, many)).rejects.toThrow(
      /gradients with more than 8 color and opacity stops/,
    );
    const resampled = await bakeAnimation(
      { ...entry, ignore: ["gradient-stops"] },
      many,
    );
    const stops = resampled.animation.frames[0]?.ops[0]?.paint;
    expect(stops?.kind === "linear" ? stops.stops.length : 0).toBe(8);
  });

  it("puts listed colors and every color under tint in the primary slot", async () => {
    const red = comp([
      layer([el(32, 32, 20), fl(0xe5 / 255, 0x39 / 255, 0x35 / 255)]),
    ]);
    const slot = async (fields: object) =>
      (await bakeAnimation({ ...entry, ...fields }, red)).animation.frames[0]
        ?.ops[0]?.paint;
    expect(await slot({})).toMatchObject({ slot: 0 });
    expect(await slot({ slots: { primary: ["#e53a35"] } })).toMatchObject({
      slot: 1,
    });
    expect(await slot({ slots: { secondary: ["#e53935"] } })).toMatchObject({
      slot: 2,
    });
    expect(await slot({ tint: true })).toMatchObject({ slot: 1 });
  });

  it("limits ops per frame, curve visits and size unless heavy", async () => {
    const crowd = comp(
      Array.from({ length: 65 }, (_, i) => layer([el(i, 32, 1), fl(0, 0, 0)])),
    );
    await expect(bakeAnimation(entry, crowd)).rejects.toThrow(
      /frame 0 has 65 draws/,
    );
    // Sixty concentric discs: every pixel walks the curves of each one
    // whose box it is in.
    const star = comp(
      Array.from({ length: 60 }, (_, i) =>
        layer([el(32, 32, 4 + i), fl(0, 0, 0)]),
      ),
    );
    const baked = await bakeAnimation(entry, star);
    expect(() => packAnimations([baked])).toThrow(
      /curve visits per pixel, over the limit of 64/,
    );
    const heavy = packAnimations([
      await bakeAnimation({ ...entry, heavy: true }, star),
    ]);
    expect(heavy.animations[0]?.visits).toBeGreaterThan(64);
    expect(heavy.animations[0]?.warnings[0]).toMatch(/visits per pixel/);
  });

  it("names malformed files", async () => {
    await expect(bakeAnimation(entry, comp([]))).rejects.toThrow(
      /draws nothing in any frame/,
    );
    await expect(bakeAnimation(entry, { ...dot(), w: 0 })).rejects.toThrow(
      /w, h: expected a canvas size > 0/,
    );
    await expect(bakeAnimation(entry, { ...dot(), op: 0 })).rejects.toThrow(
      /op > ip/,
    );
  });
});

describe("markers", () => {
  const withMarkers = {
    ...dot(),
    fr: 30,
    ip: 0,
    op: 60,
    markers: [
      { cm: "Hover In", tm: 10, dr: 15 },
      { cm: "rest", tm: 50, dr: 30 },
      { cm: "late", tm: 90, dr: 5 },
    ],
  };

  it("names each marker after the entry and clips it to the animation", () => {
    const { inputs, notes } = markerInputs(
      { ...entry, name: "pin", markers: true },
      withMarkers,
      120,
      60,
    );
    expect(inputs).toEqual([
      { name: "pin#hover-in", of: "pin", start: 20, count: 30 },
      { name: "pin#rest", of: "pin", start: 100, count: 20 },
    ]);
    expect(notes).toEqual([
      'marker "late" lies outside the animation\'s frames; skipped',
    ]);
    expect(
      markerInputs(
        { ...entry, name: "pin", markers: ["rest"] },
        withMarkers,
        120,
        60,
      ).inputs,
    ).toHaveLength(1);
    expect(
      markerInputs({ ...entry, name: "pin" }, withMarkers, 120, 60).inputs,
    ).toEqual([]);
    expect(() =>
      markerInputs({ ...entry, markers: ["missing"] }, withMarkers, 120, 60),
    ).toThrow(/no marker "missing"/);
    expect(slug("Hover In!")).toBe("hover-in-");
  });

  it("becomes catalog entries that share the animation's frames", async () => {
    const { packed, catalog } = await catalogOf(withMarkers, {
      name: "pin",
      markers: true,
    });
    expect(catalog.enumValues()).toEqual([
      "none",
      "pin",
      "pin#hover-in",
      "pin#rest",
    ]);
    const [pin, hover] = catalog.animations;
    expect(hover?.frameTexel).toBe((pin?.frameTexel ?? 0) + 20);
    expect(hover?.frameCount).toBe(30);
    expect(packed.animations[0]?.markers).toEqual(["pin#hover-in", "pin#rest"]);
  });
});

describe("dedupe on the demo and weather animations", () => {
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(join(pluginRoot, "animations", path), "utf8"));

  it("stores fewer shapes than frames times paints", async () => {
    for (const file of ["pulse.json", "pin.json", "meteocons/clear-day.json"]) {
      const { stats } = await bakeAnimation(
        { name: "a", file, displayPx: 48, maxDisplayPx: 192 },
        read(file),
      );
      expect(stats.shapes).toBeLessThan(stats.draws);
    }
  });

  it("stores wind's marching dash once per phase: 36 outlines per dash at 60 fps", async () => {
    const file = "meteocons/flat/wind.json";
    const { stats } = await bakeAnimation(
      { name: "wind", file, displayPx: 48, box: [15, 15, 113, 118] },
      read(file),
      {
        fps: 60,
      },
    );
    // Two dashed strokes are all the file draws.
    expect(stats.draws).toBe(2 * 360);
    expect(stats.geometries).toBeLessThanOrEqual(2 * 36);
  });
});

describe("bakeCatalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "animated-icon-bake-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("bakes the same bytes every time and reports every animation", async () => {
    const path = join(pluginRoot, "animations", "catalog.json");
    const first = await bakeCatalog(path);
    const second = await bakeCatalog(path);
    expect(Buffer.compare(first.packed.bytes, second.packed.bytes)).toBe(0);
    const catalog = Catalog.parse(first.packed.bytes);
    expect(catalog.enumValues()).toEqual(["none", "pulse", "pin", "clear-day"]);
    const report = formatReport(first);
    expect(report).toMatch(/^animation +frames@fps +max ops +shapes\/ops/);
    expect(report).toMatch(/\npulse +90@60 +\d+ +\d+\/270 \(\d+%\)/);
    expect(report).toMatch(/catalog: \d+ texels in a 1024x\d+ texture/);
    expect(report).toMatch(/unmeasured/);
  });

  it("recolors the demo's pulse and pin bodies through the primary slot", async () => {
    const { packed } = await bakeCatalog(
      join(pluginRoot, "animations", "catalog.json"),
    );
    expect(packed.animations.map((a) => a.name)).toEqual([
      "pulse",
      "pin",
      "clear-day",
    ]);
    const baked = await bakeAnimation(
      { name: "pin", file: "pin.json", displayPx: 48 },
      JSON.parse(
        readFileSync(join(pluginRoot, "animations", "pin.json"), "utf8"),
      ),
    );
    const slots = baked.animation.frames[0]?.ops.map((op) =>
      op.paint.kind === "solid" ? op.paint.slot : 0,
    );
    expect(slots).toContain(1);
    expect(slots).toContain(0);
  });

  it("takes the manifest's frame rate, and the caller's before it", async () => {
    writeFileSync(join(dir, "dot.json"), JSON.stringify(dot()));
    writeFileSync(
      join(dir, "rate.json"),
      JSON.stringify({
        fps: 30,
        animations: [{ name: "a", file: "dot.json", displayPx: 32 }],
      }),
    );
    expect((await bakeCatalog(join(dir, "rate.json"))).animations[0]?.fps).toBe(
      30,
    );
    expect(
      (await bakeCatalog(join(dir, "rate.json"), { fps: 12 })).animations[0]
        ?.fps,
    ).toBe(12);
  });

  it("prefixes an entry's errors with its name and file", async () => {
    writeFileSync(
      join(dir, "typo.json"),
      JSON.stringify({
        animations: [{ name: "dot", file: "dot.json", displayPX: 32 }],
      }),
    );
    await expect(bakeCatalog(join(dir, "typo.json"))).rejects.toThrow(
      /^dot \(dot\.json\): displayPX: unknown field/,
    );
  });

  it("collects the notices of third-party licenses", async () => {
    writeFileSync(join(dir, "dot.json"), JSON.stringify(dot()));
    writeFileSync(
      join(dir, "LICENSE"),
      "MIT License\n\nCopyright (c) Someone\n",
    );
    writeFileSync(
      join(dir, "licensed.json"),
      JSON.stringify({
        animations: [
          {
            name: "a",
            file: "dot.json",
            displayPx: 32,
            credit: "Dots by Someone",
            license: "LICENSE",
          },
          { name: "b", file: "dot.json", displayPx: 32, license: "LICENSE" },
          { name: "c", file: "dot.json", displayPx: 32 },
        ],
      }),
    );
    const { licenses } = await bakeCatalog(join(dir, "licensed.json"));
    expect(licenses).toEqual([
      {
        credits: ["a: Dots by Someone", "b: dot.json"],
        text: "MIT License\n\nCopyright (c) Someone",
      },
    ]);
  });

  it("stores identical shapes of different animations once", async () => {
    writeFileSync(
      join(dir, "twice.json"),
      JSON.stringify({
        animations: ["a", "b"].map((name) => ({
          name,
          file: "dot.json",
          displayPx: 32,
        })),
      }),
    );
    const { packed } = await bakeCatalog(join(dir, "twice.json"));
    expect(packed.animations[1]?.shapeTexels).toBe(0);
  });
});

describe("stroke dashes through the pipeline", () => {
  it("dashes with several pairs and strokes the dashes", async () => {
    const dashed = comp([
      layer([
        el(32, 32, 40),
        st(2, {
          d: [
            { n: "d", v: k(10) },
            { n: "g", v: k(4) },
            { n: "d", v: k(2) },
            { n: "g", v: k(4) },
            { n: "o", v: k(0) },
          ],
        }),
      ]),
    ]);
    const { stats } = await bakeAnimation({ ...entry, box: "canvas" }, dashed);
    expect(stats.shapes).toBeGreaterThan(0);
    expect(stats.maxOps).toBeGreaterThanOrEqual(1);
  });
});
