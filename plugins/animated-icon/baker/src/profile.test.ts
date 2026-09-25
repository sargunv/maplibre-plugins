import { describe, expect, it } from "vite-plus/test";

import {
  checkProfile,
  describe as describeViolation,
  FEATURES,
  type FeatureId,
  fileTier,
  isCore,
  ProfileError,
  scan,
} from "./profile.ts";

type Json = Record<string, unknown>;

const ellipse = { ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [10, 10] } };
const fill = {
  ty: "fl",
  c: { a: 0, k: [1, 0, 0, 1] },
  o: { a: 0, k: 100 },
  r: 1,
};

function shapeLayer(
  extra: Json = {},
  items: unknown[] = [ellipse, fill],
): Json {
  return {
    ty: 4,
    ind: 1,
    ip: 0,
    op: 60,
    ks: { o: { a: 0, k: 100 } },
    shapes: [{ ty: "gr", it: [...items, { ty: "tr" }] }],
    ...extra,
  };
}

function lottie(layers: unknown[], extra: Json = {}): Json {
  return { v: "5.12.0", fr: 60, ip: 0, op: 60, w: 64, h: 64, layers, ...extra };
}

/** Every path and feature the scan rejects. */
function rejected(json: unknown): [string, FeatureId][] {
  return scan(json).violations.map((v) => [v.path, v.feature]);
}

/** Every path and Core feature the scan accepts. */
function accepted(json: unknown): [string, FeatureId][] {
  return scan(json).core.map((v) => [v.path, v.feature]);
}

const k = (value: unknown) => ({ a: 0, k: value });

describe("scan", () => {
  it("accepts the Core-0 profile with no Core features", () => {
    const json = lottie([
      shapeLayer({ parent: 2 }, [
        ellipse,
        { ty: "rc", p: { k: [0, 0] }, s: { k: [4, 4] }, r: { k: 1 } },
        { ty: "sr", sy: 1, pt: { k: 5 } },
        { ty: "sh", ks: { k: { c: true, v: [], i: [], o: [] } } },
        fill,
        { ty: "st", c: { k: [0, 0, 0, 1] }, w: { k: 2 }, lc: 2, lj: 1, ml: 4 },
      ]),
      { ty: 3, ind: 2, ip: 0, op: 60, ks: {} },
      { ty: 1, ind: 3, ip: 0, op: 60, ks: {}, sw: 64, sh: 64, sc: "#ffffff" },
    ]);
    expect(scan(json)).toMatchObject({ violations: [], core: [] });
    expect(fileTier(scan(json))).toBe("Core-0");
  });

  it("accepts every Core feature, naming its path", () => {
    const cases: [Json, [string, FeatureId]][] = [
      [
        lottie([shapeLayer({ ty: 0, refId: "comp", w: 10, h: 10 })], {
          assets: [{ id: "comp", layers: [] }],
        }),
        ["layers[0].ty", "precomps"],
      ],
      [
        lottie([shapeLayer({ ty: 0, refId: "c", tm: k(0) })]),
        ["layers[0].tm", "time-remap"],
      ],
      [
        lottie([shapeLayer({ ty: 0, refId: "c", sr: 2 })]),
        ["layers[0].sr", "time-stretch"],
      ],
      [lottie([shapeLayer({ ao: 1 })]), ["layers[0].ao", "auto-orient"]],
      [
        lottie([
          shapeLayer({
            ks: { r: { a: 1, k: [], x: "$bm_rt = loopOut('cycle')" } },
          }),
        ]),
        ["layers[0].ks.r.x", "loop-expressions"],
      ],
      [
        lottie([shapeLayer({ masksProperties: [{ mode: "a", o: k(100) }] })]),
        ["layers[0].masksProperties", "masks"],
      ],
      [lottie([shapeLayer({ tt: 1 })]), ["layers[0].tt", "mattes"]],
      [lottie([shapeLayer({ tt: 2 })]), ["layers[0].tt", "mattes"]],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "gf", t: 1, g: { p: 2 } }])]),
        ["layers[0].shapes[0].it[1]", "gradients"],
      ],
      [
        lottie([
          shapeLayer({}, [ellipse, { ty: "gs", t: 2, h: k(0), g: { p: 2 } }]),
        ]),
        ["layers[0].shapes[0].it[1]", "gradients"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "tm" }, fill])]),
        ["layers[0].shapes[0].it[1]", "trim"],
      ],
      [
        lottie([
          shapeLayer({}, [ellipse, { ty: "st", d: [{ n: "d", v: { k: 2 } }] }]),
        ]),
        ["layers[0].shapes[0].it[1].d", "dashes"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, fill, { ty: "rp" }])]),
        ["layers[0].shapes[0].it[2]", "repeaters"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "rd" }, fill])]),
        ["layers[0].shapes[0].it[1]", "round-corners"],
      ],
      [
        lottie([
          shapeLayer({}, [
            ellipse,
            { ...fill, c: { k: [0, 0, 0, 1], sid: "secondary" } },
          ]),
        ]),
        ["layers[0].shapes[0].it[1].c.sid", "color-slots"],
      ],
    ];
    for (const [json, expected] of cases) {
      expect(rejected(json)).toEqual([]);
      expect(accepted(json)).toContainEqual(expected);
      expect(fileTier(scan(json))).toBe("Core");
    }
  });

  it("rejects one feature per tier-raising construct, naming its path", () => {
    const cases: [Json, [string, FeatureId]][] = [
      [lottie([shapeLayer({ ty: 2 })]), ["layers[0].ty", "images"]],
      [lottie([shapeLayer({ ty: 5 })]), ["layers[0].ty", "text"]],
      [lottie([shapeLayer({ ty: 6 })]), ["layers[0].ty", "other-layers"]],
      [lottie([shapeLayer({ ddd: 1 })]), ["layers[0].ddd", "3d"]],
      [
        lottie([shapeLayer({ masksProperties: [{ mode: "a", o: k(60) }] })]),
        ["layers[0].masksProperties[0].o", "mask-opacity"],
      ],
      [
        lottie([
          shapeLayer({
            masksProperties: [
              {
                mode: "s",
                o: {
                  a: 1,
                  k: [
                    { t: 0, s: [100] },
                    { t: 9, s: [100] },
                  ],
                },
              },
            ],
          }),
        ]),
        ["layers[0].masksProperties[0].o", "mask-opacity"],
      ],
      [
        lottie([
          shapeLayer({ masksProperties: [{ mode: "a", o: k(100), x: k(-2) }] }),
        ]),
        ["layers[0].masksProperties[0].x", "mask-contraction"],
      ],
      [lottie([shapeLayer({ tt: 3 })]), ["layers[0].tt", "luma-mattes"]],
      [
        lottie([
          shapeLayer({
            ks: { r: { a: 0, k: 0, x: "time * 90" } },
          }),
        ]),
        ["layers[0].ks.r.x", "expressions"],
      ],
      // A loop on a path is an expression: lottie-web has no loops there.
      [
        lottie([
          shapeLayer({}, [
            { ty: "sh", ks: { a: 1, k: [], x: "$bm_rt = loopOut('cycle')" } },
            fill,
          ]),
        ]),
        ["layers[0].shapes[0].it[0].ks.x", "expressions"],
      ],
      [
        lottie([
          shapeLayer({
            masksProperties: [
              {
                mode: "a",
                o: k(100),
                pt: { a: 1, k: [], x: "$bm_rt = loopOut()" },
              },
            ],
          }),
        ]),
        ["layers[0].masksProperties[0].pt.x", "expressions"],
      ],
      [
        lottie([
          shapeLayer({ ks: { r: { a: 1, k: [], x: "loopOut('cycle')" } } }),
        ]),
        ["layers[0].ks.r.x", "expressions"],
      ],
      [
        lottie([shapeLayer({ ef: [{ ty: 29 }] })]),
        ["layers[0].ef[0]", "effects"],
      ],
      [
        lottie([shapeLayer({ sy: [{ ty: 1 }] })]),
        ["layers[0].sy", "layer-styles"],
      ],
      [lottie([shapeLayer({ bm: 3 })]), ["layers[0].bm", "blend-modes"]],
      // lottie-web's SVG renderer blends styles and groups too.
      [
        lottie([shapeLayer({}, [ellipse, { ...fill, bm: 3 }])]),
        ["layers[0].shapes[0].it[1].bm", "blend-modes"],
      ],
      [
        lottie([
          {
            ...shapeLayer(),
            shapes: [{ ty: "gr", bm: 1, it: [ellipse, fill, { ty: "tr" }] }],
          },
        ]),
        ["layers[0].shapes[0].bm", "blend-modes"],
      ],
      [
        lottie([
          shapeLayer({}, [ellipse, { ty: "gf", t: 2, h: k(20), g: { p: 2 } }]),
        ]),
        ["layers[0].shapes[0].it[1].h", "gradient-highlights"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "mm", mm: 3 }, fill])]),
        ["layers[0].shapes[0].it[1]", "merge-paths"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "zz" }, fill])]),
        ["layers[0].shapes[0].it[1]", "path-modifiers"],
      ],
      [
        lottie([shapeLayer({}, [ellipse, { ty: "xx" }, fill])]),
        ["layers[0].shapes[0].it[1].ty", "unknown-shapes"],
      ],
      // Slots on anything but a fill or stroke color's primary or secondary.
      [
        lottie([
          shapeLayer({}, [
            ellipse,
            { ...fill, c: { k: [0, 0, 0, 1], sid: "accent" } },
          ]),
        ]),
        ["layers[0].shapes[0].it[1].c.sid", "slots"],
      ],
      [
        lottie([
          shapeLayer({ ks: { p: { a: 0, k: [0, 0, 0], sid: "primary" } } }),
        ]),
        ["layers[0].ks.p.sid", "slots"],
      ],
      [
        lottie([
          shapeLayer({}, [
            ellipse,
            { ...fill, o: { a: 0, k: 100, sid: "primary" } },
          ]),
        ]),
        ["layers[0].shapes[0].it[1].o.sid", "slots"],
      ],
      // A split position's `x` is the X property, not an expression.
      [
        lottie([
          shapeLayer({
            ks: {
              p: {
                s: true,
                x: { a: 0, k: 0, x: "wiggle(1, 1)" },
                y: { a: 0, k: 0 },
              },
            },
          }),
        ]),
        ["layers[0].ks.p.x.x", "expressions"],
      ],
      // Slot values replace properties, so their expressions count too.
      [
        lottie([shapeLayer()], {
          slots: {
            primary: { p: { a: 0, k: [1, 0, 0, 1], x: "wiggle(1, 1)" } },
          },
        }),
        ["slots.primary.p.x", "expressions"],
      ],
      [lottie([shapeLayer()], { w: 1024 }), ["w", "canvas-size"]],
      // Precompositions are scanned under their asset's path.
      [
        lottie([shapeLayer({ ty: 0, refId: "inner" })], {
          assets: [{ id: "inner", layers: [shapeLayer({ bm: 1 })] }],
        }),
        ["assets[0].layers[0].bm", "blend-modes"],
      ],
    ];
    for (const [json, expected] of cases) {
      expect(rejected(json)).toContainEqual(expected);
    }
    // Every feature outside the Core tier but those found while baking
    // has a case above.
    const covered = new Set(cases.map(([, [, feature]]) => feature));
    expect(
      Object.keys(FEATURES).filter(
        (id) => !isCore(id as FeatureId) && !covered.has(id as FeatureId),
      ),
    ).toEqual([
      "matte-sources",
      "precomp-clip",
      "gradient-stops",
      "opacity-isolation",
    ]);
  });

  it("reads blend modes only where lottie-web's SVG renderer applies them", () => {
    // bodymovin writes bm 0 on most items, and shapes never blend.
    expect(
      rejected(
        lottie([
          shapeLayer({}, [
            { ...ellipse, bm: 3 },
            { ty: "st", c: k([0, 0, 0, 1]), o: k(100), w: k(2), bm: 0 },
            { ...fill, bm: 0 },
          ]),
        ]),
      ),
    ).toEqual([]);
    expect(
      rejected(
        lottie([
          shapeLayer({}, [
            ellipse,
            { ty: "st", c: k([0, 0, 0, 1]), o: k(100), w: k(2), bm: 1 },
          ]),
        ]),
      ),
    ).toEqual([["layers[0].shapes[0].it[1].bm", "blend-modes"]]);
  });

  it("sorts files into tiers by the highest tier they need", () => {
    expect(fileTier(scan(lottie([shapeLayer({ tt: 3 })])))).toBe("Later");
    expect(
      fileTier(
        scan(
          lottie([shapeLayer({ masksProperties: [{ mode: "a", o: k(50) }] })]),
        ),
      ),
    ).toBe("Composite");
    expect(fileTier(scan(lottie([shapeLayer({ ty: 5, tt: 3 })])))).toBe(
      "never",
    );
  });

  it("skips hidden layers and items but still reads hidden parents' transforms", () => {
    const json = lottie([
      shapeLayer({
        hd: true,
        hasMask: true,
        ks: { r: { k: 0, x: "wiggle(1, 2)" } },
      }),
      shapeLayer({}, [
        ellipse,
        { ty: "zz", hd: true },
        { ...fill, hd: true, o: { a: 0, k: 100, sid: "alpha" } },
        fill,
      ]),
      shapeLayer({ hd: true, ks: { p: { a: 0, k: [0, 0, 0], sid: "spot" } } }),
    ]);
    expect(rejected(json)).toEqual([
      ["layers[0].ks.r.x", "expressions"],
      ["layers[2].ks.p.sid", "slots"],
    ]);
  });

  it("notes inert data", () => {
    const json = lottie(
      [
        shapeLayer({ ef: [{ ty: 5 }] }, [ellipse, { ty: "mm", mm: 1 }, fill]),
        shapeLayer({ tm: k(0), sr: 2 }),
      ],
      { markers: [{ cm: "hover", tm: 0, dr: 10 }] },
    );
    expect(scan(json)).toEqual({
      violations: [],
      core: [],
      inert: [
        'markers (an entry\'s "markers" field bakes them as extra entries)',
        "layers[0].ef[0]: expression controls",
        "layers[0].shapes[0].it[1]: merge paths mode 1 (lottie-web draws the paths unmerged)",
        "layers[1].tm: time remap on a layer that is not a precomposition",
        "layers[1].sr: time stretch on a layer that is not a precomposition",
      ],
    });
  });
});

describe("checkProfile", () => {
  const blended = lottie([shapeLayer(), shapeLayer({ bm: 2 })]);
  const masked = lottie([
    shapeLayer({ masksProperties: [{ mode: "a", o: k(100) }] }),
  ]);

  it("throws naming the path, the feature and the tier that adds it", () => {
    expect(
      describeViolation({
        path: "layers[3].masksProperties[0].o",
        feature: "mask-opacity",
      }),
    ).toBe(
      'layers[3].masksProperties[0].o: translucent or animated-opacity masks need profile tier Composite (M3) (ignore id "mask-opacity")',
    );
    expect(
      describeViolation({ path: "layers[0].ks.r.x", feature: "expressions" }),
    ).toBe(
      'layers[0].ks.r.x: expressions are outside every profile tier; use After Effects "Convert Expression to Keyframes" (ignore id "expressions")',
    );
    expect(() => checkProfile("blended.json", blended)).toThrow(ProfileError);
    expect(() => checkProfile("blended.json", blended)).toThrow(
      /blended\.json uses features outside profile tier Core \(M1\):\n {2}layers\[1\]\.bm: blend modes need profile tier Later/,
    );
  });

  it("bakes Core features and reports them", () => {
    expect(checkProfile("masked.json", masked)).toEqual({
      ignored: [],
      core: [{ path: "layers[0].masksProperties", feature: "masks" }],
      inert: [],
    });
  });

  it("drops features the entry ignores and reports them, Core ones too", () => {
    expect(checkProfile("blended.json", blended, ["blend-modes"])).toEqual({
      ignored: [{ path: "layers[1].bm", feature: "blend-modes" }],
      core: [],
      inert: [],
    });
    expect(checkProfile("masked.json", masked, ["masks"])).toEqual({
      ignored: [{ path: "layers[0].masksProperties", feature: "masks" }],
      core: [],
      inert: [],
    });
  });

  it("rejects unknown ignore ids", () => {
    expect(() => checkProfile("a.json", masked, ["mask"])).toThrow(
      /unknown ignore id "mask"/,
    );
  });
});
