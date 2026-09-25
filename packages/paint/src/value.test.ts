// Each rule of compileValue with the MapLibre Native code it mirrors. The
// host fixtures (binder.test.ts) check the same rules against values the
// host produced; these tests pin them down one at a time.

import { describe, expect, it } from "vite-plus/test";

import {
  compile,
  compileValue,
  componentCount,
  type EvaluationFeature,
  type FeatureValue,
  isFeatureValue,
  type PaintPropertySpec,
  supportsTransitions,
  type UniformValue,
  wrapRotation,
} from "./index.ts";

const size = {
  type: "float",
  default: 1,
  minimum: 0,
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const speed = {
  type: "float",
  default: 1,
  minimum: -4,
  maximum: 4,
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const rotate = {
  type: "rotation",
  default: 0,
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const color = {
  type: "color",
  default: [1, 0.5, 0, 0.5],
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const offset = {
  type: "float2",
  default: [1, -2],
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const animation = {
  type: "enum",
  values: ["none", "pulse", "61", "true"],
  default: "none",
  expressions: "data-driven",
} as const satisfies PaintPropertySpec;
const alignment = {
  type: "enum",
  values: ["auto", "map", "viewport"],
  default: "auto",
} as const satisfies PaintPropertySpec;
const cameraSize = { type: "float", default: 5 } as const;

const point = (
  properties: Record<string, unknown>,
  id?: number | string,
): EvaluationFeature => ({
  type: 1,
  properties,
  ...(id === undefined ? {} : { id }),
});

function uniform(value: ReturnType<typeof compileValue>): UniformValue {
  if (value.kind !== "uniform") throw new Error("expected a uniform value");
  return value;
}

function feature(value: ReturnType<typeof compileValue>): FeatureValue {
  if (!isFeatureValue(value)) throw new Error("expected a feature value");
  return value;
}

describe("spec helpers", () => {
  it("counts components per endpoint like the host's encodings (plugin_bucket.cpp componentCount)", () => {
    expect(componentCount(size)).toBe(1);
    expect(componentCount(rotate)).toBe(1);
    expect(componentCount(animation)).toBe(1);
    expect(componentCount(offset)).toBe(2);
    expect(componentCount({ type: "double2", default: [0, 0] })).toBe(2);
    expect(componentCount(color)).toBe(4);
  });

  it("takes a -transition key for numbers and not enums unless the spec says", () => {
    expect(supportsTransitions(size)).toBe(true);
    expect(supportsTransitions(animation)).toBe(false);
    expect(supportsTransitions({ ...size, transition: false })).toBe(false);
  });
});

describe("parsing (rule 1: every property parses as data-driven, plugin_property.cpp convertTyped)", () => {
  it("classifies constants, camera, source and composite values", () => {
    expect(compileValue(size, "s", 2).kind).toBe("uniform");
    expect(compileValue(size, "s", ["+", 1, 2]).kind).toBe("uniform");
    expect(
      compileValue(size, "s", [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        1,
        10,
        2,
      ]).kind,
    ).toBe("uniform");
    const source = feature(compileValue(size, "s", ["get", "a"]));
    expect(source.zoomDependent).toBe(false);
    expect(source.stateDependent).toBe(false);
    const composite = feature(
      compileValue(size, "s", [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        ["get", "a"],
        10,
        ["feature-state", "b"],
      ]),
    );
    expect(composite.zoomDependent).toBe(true);
    expect(composite.stateDependent).toBe(true);
    expect(composite.components).toBe(1);
  });

  it("coerces enum outputs to strings at the top level (parsing_context.cpp parseLayerPropertyExpression)", () => {
    const value = feature(compileValue(animation, "a", ["get", "k"]));
    expect(value.at(10, point({ k: 61 }))).toEqual([2]);
    expect(value.at(10, point({ k: true }))).toEqual([3]);
    expect(value.at(10, point({ k: "pulse" }))).toEqual([1]);
    // An enum literal must be a string, as the host's Converter<std::string>.
    expect(() => compileValue(animation, "a", 61)).toThrow();
    expect(() => compileValue(animation, "a", true)).toThrow();
    expect(() => compileValue(animation, "a", ["literal", 61])).toThrow();
  });

  it("compiles null and undefined as the default (the host's Undefined)", () => {
    expect(uniform(compileValue(size, "s", null)).at(0)).toEqual([1]);
    expect(uniform(compileValue(animation, "a", undefined)).at(0)).toEqual([0]);
  });
});

describe("capabilities (rule 2, plugin_property.cpp convertPluginPropertyValue)", () => {
  const rejected =
    "expression dependencies are not supported for plugin property 'p'";

  it("rejects feature, composite and feature-state expressions on a camera property with the host's text", () => {
    for (const value of [
      ["get", "a"],
      ["id"],
      ["number", ["feature-state", "s"], 1],
      ["interpolate", ["linear"], ["zoom"], 0, ["get", "a"], 10, 1],
    ]) {
      expect(() => compileValue(cameraSize, "p", value)).toThrow(rejected);
      expect(() => compile(cameraSize, "p", value)).toThrow(rejected);
    }
    expect(() => compileValue(alignment, "p", ["get", "a"])).toThrow(rejected);
  });

  it("accepts constants and zoom expressions on a camera property", () => {
    const zoomed = uniform(
      compileValue(cameraSize, "p", [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        0,
        10,
        100,
      ]),
    );
    expect(zoomed.at(2.5)).toEqual([25]);
  });

  it("keeps compile() camera-only even for a data-driven property", () => {
    expect(() => compile(size, "p", ["get", "a"])).toThrow(rejected);
    expect(compile(size, "p", 3)(0)).toEqual([3]);
  });
});

describe("constants (rule 3, plugin_property.cpp validateConstant)", () => {
  const outside = "value is outside the allowed range for plugin property 's'";
  const unlisted = "value is not allowed for plugin property 'a'";

  it("checks a float constant as the f32 the host stores against f32 bounds", () => {
    // Converter<float> stores 4.0000001 as 4.0f, which is in range; the next
    // f32 above 4 is not.
    expect(uniform(compileValue(speed, "s", 4.0000001)).at(0)).toEqual([
      4.0000001,
    ]);
    expect(() => compileValue(speed, "s", 4.0000003)).toThrow(outside);
    expect(() => compileValue(speed, "s", -4.0000003)).toThrow(outside);
    expect(() => compileValue(speed, "s", 5)).toThrow(outside);
    // The bound is an f32 too: 0.1 is within a maximum of 0.1.
    const tenth = { type: "float", default: 0, maximum: 0.1 } as const;
    expect(uniform(compileValue(tenth, "s", 0.1)).at(0)).toEqual([0.1]);
  });

  it("checks a folded constant like a literal, NaN failing any bound (property_value.cpp)", () => {
    expect(() => compileValue(speed, "s", ["+", 4, 1])).toThrow(outside);
    expect(uniform(compileValue(speed, "s", ["+", 4, 1e-7])).at(0)).toEqual([
      4.0000001,
    ]);
    expect(() => compileValue(size, "s", ["/", 0, 0])).toThrow(outside);
    expect(
      uniform(compileValue({ type: "float", default: 0 }, "s", ["/", 0, 0])).at(
        0,
      )[0],
    ).toBeNaN();
    expect(uniform(compileValue(size, "s", ["/", 1, 0])).at(0)).toEqual([
      Infinity,
    ]);
  });

  it("never range-checks expression outputs", () => {
    const zoomed = uniform(
      compileValue(speed, "s", [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        0,
        10,
        9,
      ]),
    );
    expect(zoomed.at(10)).toEqual([9]);
    expect(
      feature(compileValue(speed, "s", ["get", "a"])).at(0, point({ a: 9 })),
    ).toEqual([9]);
  });

  it("rejects an unlisted enum constant, literal or folded, with the host's text", () => {
    expect(uniform(compileValue(animation, "a", "pulse")).at(0)).toEqual([1]);
    expect(
      uniform(compileValue(animation, "a", ["concat", "6", "1"])).at(0),
    ).toEqual([2]);
    expect(() => compileValue(animation, "a", "rain")).toThrow(unlisted);
    expect(() => compileValue(animation, "a", ["concat", "ra", "in"])).toThrow(
      unlisted,
    );
  });

  it("wraps a rotation constant before checking it (rotation.hpp)", () => {
    expect(uniform(compileValue(rotate, "r", 720)).at(0)).toEqual([0]);
    expect(uniform(compileValue(rotate, "r", -90)).at(0)).toEqual([270]);
    const bounded = {
      type: "rotation",
      default: 0,
      minimum: 0,
      maximum: 180,
    } as const;
    expect(() => compileValue(bounded, "s", -90)).toThrow(outside);
    expect(uniform(compileValue(bounded, "s", 540)).at(0)).toEqual([180]);
  });
});

describe("evaluation (rule 4, property_expression.hpp evaluate, value.cpp)", () => {
  it("falls back to the plugin default on a throw, null or a wrong type", () => {
    const value = feature(compileValue(size, "s", ["get", "a"]));
    expect(value.at(0, point({ a: 3 }))).toEqual([3]);
    expect(value.at(0, point({}))).toEqual([1]);
    expect(value.at(0, point({ a: "3" }))).toEqual([1]);
    expect(value.at(0, point({ a: true }))).toEqual([1]);
    const pair = feature(compileValue(offset, "o", ["get", "xy"]));
    expect(pair.at(0, point({ xy: [3, 4] }))).toEqual([3, 4]);
    expect(pair.at(0, point({ xy: [3] }))).toEqual([1, -2]);
  });

  it("passes NaN and ±Infinity through (value.cpp ValueConverter<float>)", () => {
    const value = feature(
      compileValue(size, "s", ["/", ["get", "a"], ["get", "b"]]),
    );
    expect(value.at(0, point({ a: 1, b: 0 }))).toEqual([Infinity]);
    expect(value.at(0, point({ a: -1, b: 0 }))).toEqual([-Infinity]);
    expect(value.at(0, point({ a: 0, b: 0 }))[0]).toBeNaN();
    const out = new Float32Array(2);
    value.encode(0, point({ a: 0, b: 0 }), undefined, out, 0);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(
      uniform(
        compileValue(size, "s", [
          "interpolate",
          ["linear"],
          ["zoom"],
          0,
          ["sqrt", -1],
          10,
          1,
        ]),
      ).at(5)[0],
    ).toBeNaN();
  });

  it("maps an enum output outside the list to the default's index (plugin_bucket.cpp encodedValue)", () => {
    const value = feature(compileValue(animation, "a", ["get", "k"]));
    expect(value.at(0, point({ k: "rain" }))).toEqual([0]);
    const camera = uniform(
      compileValue(animation, "a", ["step", ["zoom"], "pulse", 5, "rain"]),
    );
    expect(camera.at(0)).toEqual([1]);
    expect(camera.at(6)).toEqual([0]);
  });

  it("wraps rotation outputs after rounding them to f32 (ValueConverter<Rotation>)", () => {
    const value = feature(compileValue(rotate, "r", ["get", "r"]));
    expect(value.at(0, point({ r: 720 }))).toEqual([0]);
    expect(value.at(0, point({ r: -90 }))).toEqual([270]);
    expect(value.at(0, point({ r: 1e9 }))).toEqual([280]);
    // f32(359.99999999) is 360, which wraps to 0.
    expect(value.at(0, point({ r: 359.99999999 }))).toEqual([0]);
    // The host's wrap sends -360 to 360.
    expect(wrapRotation(-360)).toBe(360);
    expect(wrapRotation(Infinity)).toBeNaN();
  });

  it("premultiplies colors and the color default", () => {
    expect(
      uniform(compileValue(color, "c", "rgba(0, 0, 255, 0.25)")).at(0),
    ).toEqual([0, 0, 0.25, 0.25]);
    expect(uniform(compileValue(color, "c", [1, 0.5, 0, 0.5])).at(0)).toEqual([
      0.5, 0.25, 0, 0.5,
    ]);
    const value = feature(compileValue(color, "c", ["get", "c"]));
    expect(value.at(0, point({ c: "rgba(255, 0, 0, 0.5)" }))).toEqual([
      0.5, 0, 0, 0.5,
    ]);
    expect(value.at(0, point({ c: "nonsense" }))).toEqual([0.5, 0.25, 0, 0.5]);
  });
});

describe("features (rule 5)", () => {
  it("reads nothing but feature-state without a feature (compound_expression.cpp)", () => {
    // Feature accessors fail, so these give the default...
    for (const value of [
      ["get", "a"],
      ["coalesce", ["get", "a"], 7],
      ["case", ["has", "a"], 2, 3],
      ["id"],
      ["get", "a", ["properties"]],
    ]) {
      expect(
        feature(compileValue(size, "s", value)).withoutFeature(10),
      ).toEqual([1]);
    }
    // ...while feature-state reads null, which takes the fallback branch.
    expect(
      feature(
        compileValue(size, "s", ["number", ["feature-state", "s"], 0.25]),
      ).withoutFeature(10),
    ).toEqual([0.25]);
    expect(
      feature(compileValue(size, "s", ["feature-state", "s"])).withoutFeature(
        10,
      ),
    ).toEqual([1]);
  });

  it("evaluates feature-state from the state passed in", () => {
    const value = feature(
      compileValue(size, "s", ["number", ["feature-state", "s"], 0.25]),
    );
    expect(value.stateDependent).toBe(true);
    expect(value.at(0, point({}, 1), { s: 0.75 })).toEqual([0.75]);
    expect(value.at(0, point({}, 1))).toEqual([0.25]);
  });

  it("reads the feature id and geometry type", () => {
    const id = feature(compileValue(size, "s", ["id"]));
    expect(id.at(0, point({}, 5))).toEqual([5]);
    expect(id.at(0, point({}))).toEqual([1]);
    const geometry = feature(
      compileValue(
        {
          type: "enum",
          values: ["Unknown", "Point", "LineString", "Polygon"],
          default: "Unknown",
          expressions: "data-driven",
        },
        "g",
        ["geometry-type"],
      ),
    );
    expect(geometry.at(0, { type: 3, properties: {} })).toEqual([3]);
    expect(geometry.withoutFeature(0)).toEqual([0]);
  });
});

describe("encode and factor (plugin_bucket.cpp fillRange, plugin_property.cpp interpolationFactor)", () => {
  const composite = feature(
    compileValue(size, "s", [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["get", "a"],
      11,
      ["get", "b"],
    ]),
  );

  it("writes min at the bucket zoom and max at the next zoom", () => {
    const out = new Float32Array(4).fill(-1);
    composite.encode(10, point({ a: 1, b: 3 }), undefined, out, 1);
    expect([...out]).toEqual([-1, 1, 3, -1]);
    composite.encode(10.5, point({ a: 1, b: 3 }), undefined, out, 0);
    expect([...out.subarray(0, 2)]).toEqual([2, 3]);
  });

  it("copies min to max for a zoom-constant value", () => {
    const out = new Float32Array(4);
    feature(compileValue(offset, "o", ["get", "xy"])).encode(
      3,
      point({ xy: [5, 6] }),
      undefined,
      out,
      0,
    );
    expect([...out]).toEqual([5, 6, 5, 6]);
  });

  it("mixes with the curve factor over [bucketZoom, bucketZoom + 1] in f32, clamped", () => {
    expect(composite.factor(10, 10.5)).toBe(0.5);
    expect(composite.factor(10, 9.5)).toBe(0);
    expect(composite.factor(10, 11.5)).toBe(1);
    expect(composite.factor(9, 9.3)).toBe(Math.fround(Math.fround(9.3) - 9));
    const exponential = feature(
      compileValue(size, "s", [
        "interpolate",
        ["exponential", 2],
        ["zoom"],
        0,
        ["get", "a"],
        20,
        ["get", "b"],
      ]),
    );
    expect(exponential.factor(5, 5.5)).toBe(Math.fround(Math.SQRT2 - 1));
  });

  it("gives 0 for step curves and zoom-constant values", () => {
    expect(
      feature(
        compileValue(size, "s", [
          "step",
          ["zoom"],
          ["get", "a"],
          10,
          ["get", "b"],
        ]),
      ).factor(10, 10.5),
    ).toBe(0);
    expect(
      feature(compileValue(size, "s", ["get", "a"])).factor(10, 10.5),
    ).toBe(0);
  });
});
