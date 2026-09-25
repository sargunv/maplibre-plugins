import { describe, expect, it } from "vite-plus/test";

import {
  ease,
  isAnimated,
  type Loop,
  type LoopExpression,
  parseLoop,
  type Property,
  scalarAt,
  shapeAt,
  valueAt,
} from "./keyframes.ts";

const linear = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };

describe("ease", () => {
  it("is the identity for a linear curve and pins the ends", () => {
    expect(ease(0.3, 0.3, 0.7, 0.7, 0.42)).toBe(0.42);
    expect(ease(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(ease(0.42, 0, 0.58, 1, 1)).toBe(1);
  });

  it("solves cubic-bezier timing functions", () => {
    // CSS `ease` is cubic-bezier(0.25, 0.1, 0.25, 1); its value at 0.5 is
    // 0.8024033877399112 to double precision.
    expect(ease(0.25, 0.1, 0.25, 1, 0.5)).toBeCloseTo(0.8024033877, 9);
    // A symmetric ease-in-out passes through the middle.
    expect(ease(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 12);
    // (1/3, 2/3, 2/3, 1) is exactly the quadratic ease-out 2x - x^2.
    for (const x of [0.1, 0.37, 0.8]) {
      expect(ease(1 / 3, 2 / 3, 2 / 3, 1, x)).toBeCloseTo(2 * x - x * x, 10);
    }
  });
});

describe("valueAt", () => {
  it("reads static numbers and arrays", () => {
    expect(valueAt({ a: 0, k: 5 }, 10, [0])).toEqual([5]);
    expect(valueAt({ a: 0, k: [1, 2, 3] }, 10, [0, 0])).toEqual([1, 2, 3]);
    expect(valueAt(undefined, 10, [7, 8])).toEqual([7, 8]);
    expect(isAnimated({ a: 0, k: [1, 2] })).toBe(false);
  });

  const ramp = {
    a: 1,
    k: [
      { t: 10, s: [0, 100], ...linear },
      { t: 20, s: [10, 200], ...linear },
      { t: 30, s: [40, 200] },
    ],
  };

  it("interpolates between keyframes and clamps outside them", () => {
    expect(isAnimated(ramp)).toBe(true);
    expect(valueAt(ramp, 0, [0, 0])).toEqual([0, 100]);
    expect(valueAt(ramp, 15, [0, 0])).toEqual([5, 150]);
    expect(valueAt(ramp, 25, [0, 0])).toEqual([25, 200]);
    expect(valueAt(ramp, 30, [0, 0])).toEqual([40, 200]);
    expect(valueAt(ramp, 99, [0, 0])).toEqual([40, 200]);
  });

  it("holds a hold keyframe until the next one", () => {
    const hold = {
      a: 1,
      k: [
        { t: 0, s: [1], h: 1 },
        { t: 10, s: [2], h: 1 },
        { t: 20, s: [3] },
      ],
    };
    expect(scalarAt(hold, 0, 0)).toBe(1);
    expect(scalarAt(hold, 9.99, 0)).toBe(1);
    expect(scalarAt(hold, 10, 0)).toBe(2);
    expect(scalarAt(hold, 19, 0)).toBe(2);
    expect(scalarAt(hold, 20, 0)).toBe(3);
  });

  it("reads legacy end values when the next keyframe has none", () => {
    const legacy = {
      a: 1,
      k: [{ t: 0, s: [0], e: [10], ...linear }, { t: 10 }],
    };
    expect(scalarAt(legacy, 5, 0)).toBe(5);
    expect(scalarAt(legacy, 10, 0)).toBe(10);
  });

  it("eases each dimension with its own curve", () => {
    const perAxis = {
      a: 1,
      k: [
        {
          t: 0,
          s: [0, 0],
          o: { x: [0, 1 / 3], y: [0, 2 / 3] },
          i: { x: [1, 2 / 3], y: [1, 1] },
        },
        { t: 10, s: [10, 10] },
      ],
    };
    const [x = 0, y = 0] = valueAt(perAxis, 5, [0, 0]);
    expect(x).toBeCloseTo(5, 12);
    expect(y).toBeCloseTo(10 * (2 * 0.5 - 0.25), 10);
  });

  it("follows spatial tangents along the path's arc length", () => {
    // A symmetric arch from (0,0) to (100,0) bulging to y = 37.5 at its middle.
    const arch = {
      a: 1,
      k: [
        {
          t: 0,
          s: [0, 0],
          to: [0, 50],
          ti: [0, 50],
          o: { x: 0, y: 0 },
          i: { x: 1, y: 1 },
        },
        { t: 10, s: [100, 0] },
      ],
    };
    const [x = 0, y = 0] = valueAt(arch, 5, [0, 0]);
    expect(x).toBeCloseTo(50, 6);
    expect(y).toBeCloseTo(37.5, 1);
    // A quarter of the way in time is a quarter of the arc length, which is
    // past a quarter of the parameter on this arch.
    const [qx = 0] = valueAt(arch, 2.5, [0, 0]);
    expect(qx).toBeGreaterThan(0);
    expect(qx).toBeLessThan(50);
    expect(valueAt(arch, 10, [0, 0])).toEqual([100, 0]);
  });

  it("drops spatial tangents that lie on the straight path, as lottie-web does", () => {
    const straight = {
      a: 1,
      k: [
        {
          t: 0,
          s: [0, 0],
          to: [10, 0],
          ti: [-10, 0],
          o: { x: 0.5, y: 0 },
          i: { x: 0.5, y: 1 },
        },
        { t: 10, s: [60, 0] },
      ],
    };
    // With the tangents dropped the eased value is used directly.
    expect(valueAt(straight, 5, [0, 0])[0]).toBeCloseTo(
      60 * ease(0.5, 0, 0.5, 1, 0.5),
      9,
    );
  });
});

describe("shapeAt", () => {
  const square = (size: number): unknown => [
    {
      c: true,
      v: [
        [0, 0],
        [size, 0],
        [size, size],
      ],
      i: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      o: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    },
  ];

  it("morphs every vertex with the keyframe's easing", () => {
    const morph = {
      a: 1,
      k: [
        { t: 0, s: square(10), ...linear },
        { t: 10, s: square(20) },
      ],
    };
    expect(shapeAt(morph, 5)?.v).toEqual([
      [0, 0],
      [15, 0],
      [15, 15],
    ]);
    expect(shapeAt(morph, 50)?.v[1]).toEqual([20, 0]);
  });

  it("holds and rejects vertex count changes", () => {
    const hold = {
      a: 1,
      k: [
        { t: 0, s: square(10), h: 1 },
        { t: 10, s: square(20) },
      ],
    };
    expect(shapeAt(hold, 9)?.v[1]).toEqual([10, 0]);
    const changing = {
      a: 1,
      k: [
        { t: 0, s: square(10), ...linear },
        { t: 10, s: [{ c: true, v: [[0, 0]], i: [[0, 0]], o: [[0, 0]] }] },
      ],
    };
    expect(() => shapeAt(changing, 5)).toThrow(/same count/);
  });
});

describe("parseLoop", () => {
  it("accepts a whole loopIn or loopOut call with literal arguments", () => {
    const out = (
      type: LoopExpression["type"],
      duration = 0,
      durationFlag = false,
    ): LoopExpression => ({ direction: "out", type, duration, durationFlag });
    expect(parseLoop("$bm_rt = loopOut()")).toEqual(out("cycle"));
    expect(parseLoop('$bm_rt = loopOut("pingpong")')).toEqual(out("pingpong"));
    expect(parseLoop("$bm_rt = loopOut('cycle', 2)")).toEqual(out("cycle", 2));
    expect(parseLoop("var $bm_rt;\n$bm_rt = loopOut('Cycle');")).toEqual(
      out("cycle"),
    );
    expect(parseLoop("$bm_rt = loop_out('continue')")).toEqual(out("continue"));
    expect(parseLoop("$bm_rt = loopOutDuration('offset', 1.5);")).toEqual(
      out("offset", 1.5, true),
    );
    expect(parseLoop("$bm_rt = loopIn('offset', 0)")).toEqual({
      direction: "in",
      type: "offset",
      duration: 0,
      durationFlag: false,
    });
  });

  it("rejects anything more", () => {
    for (const expression of [
      // lottie-web takes the value from $bm_rt: a bare call draws nothing.
      "loopOut('cycle')",
      "$bm_rt = loopOut('cycle') + 1",
      "wiggle(1, 2)",
      "$bm_rt = loopOut(type)",
      "$bm_rt = loopOut('bounce')",
      "var x = 2; $bm_rt = loopOut()",
      "$bm_rt = loopOut('cycle', n)",
    ]) {
      expect(parseLoop(expression)).toBeUndefined();
    }
  });
});

describe("loop expressions", () => {
  const ramp = (loop: Omit<Loop, "fr" | "ip" | "op">, fr = 60): Property => ({
    a: 1,
    k: [
      { t: 10, s: [0], ...linear },
      { t: 20, s: [10] },
    ],
    loop: { ...loop, fr, ip: 0, op: 100 },
  });
  const out = (type: LoopExpression["type"]) =>
    ramp({ direction: "out", type, duration: 0, durationFlag: false });
  const into = (type: LoopExpression["type"]) =>
    ramp({ direction: "in", type, duration: 0, durationFlag: false });

  it("plays the keyframes as they are inside them", () => {
    for (const type of ["cycle", "pingpong", "offset", "continue"] as const) {
      expect(scalarAt(out(type), 15, 0)).toBe(5);
      expect(scalarAt(into(type), 15, 0)).toBe(5);
    }
  });

  it("repeats after the last keyframe in the four loopOut types", () => {
    expect(scalarAt(out("cycle"), 23, 0)).toBeCloseTo(3, 9);
    // Odd rounds play backwards.
    expect(scalarAt(out("pingpong"), 23, 0)).toBeCloseTo(7, 9);
    expect(scalarAt(out("pingpong"), 33, 0)).toBeCloseTo(3, 9);
    // Each round adds the loop's change.
    expect(scalarAt(out("offset"), 23, 0)).toBeCloseTo(13, 9);
    expect(scalarAt(out("offset"), 33, 0)).toBeCloseTo(23, 9);
    // Continues at the last keyframe's speed.
    expect(scalarAt(out("continue"), 23, 0)).toBeCloseTo(13, 6);
  });

  it("repeats before the first keyframe in the four loopIn types", () => {
    expect(scalarAt(into("pingpong"), 7, 0)).toBeCloseTo(3, 9);
    expect(scalarAt(into("offset"), 7, 0)).toBeCloseTo(-3, 9);
    expect(scalarAt(into("continue"), 7, 0)).toBeCloseTo(-3, 6);
    // lottie-web's loopIn cycle measures from frame 0, not from the first
    // keyframe (ExpressionPropertyDecorator.js:148): here it samples frame
    // -13, before the keyframes, and holds.
    expect(scalarAt(into("cycle"), 7, 0)).toBe(0);
  });

  it("loops the last n keyframes, or n seconds with loopOutDuration", () => {
    const three: Property = {
      a: 1,
      k: [
        { t: 0, s: [100], ...linear },
        { t: 10, s: [0], ...linear },
        { t: 20, s: [10] },
      ],
      loop: {
        direction: "out",
        type: "cycle",
        duration: 1,
        durationFlag: false,
        fr: 60,
        ip: 0,
        op: 100,
      },
    };
    // The last keyframe pair only.
    expect(scalarAt(three, 25, 0)).toBeCloseTo(5, 9);
    // 1/6 s at 60 fps is 10 frames back from the last keyframe.
    const seconds: Property = {
      ...three,
      loop: { ...(three.loop as Loop), duration: 1 / 6, durationFlag: true },
    };
    expect(scalarAt(seconds, 25, 0)).toBeCloseTo(5, 9);
  });

  it("keeps lottie-web's slope for multidimensional continue", () => {
    const moving: Property = {
      a: 1,
      k: [
        { t: 10, s: [0, 0], ...linear },
        { t: 20, s: [10, 20] },
      ],
      loop: {
        direction: "out",
        type: "continue",
        duration: 0,
        durationFlag: false,
        fr: 60,
        ip: 0,
        op: 100,
      },
    };
    // (value - value 0.001 frames earlier) * (frames / fr) / 0.0005.
    const [x = 0, y = 0] = valueAt(moving, 26, [0, 0]);
    expect(x).toBeCloseTo(10 + (0.001 * (6 / 60)) / 0.0005, 5);
    expect(y).toBeCloseTo(20 + (0.002 * (6 / 60)) / 0.0005, 5);
  });
});
