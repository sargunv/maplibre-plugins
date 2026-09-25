import { describe, expect, it } from "vite-plus/test";

import {
  compile,
  DEFAULT_TRANSITION,
  ease,
  isFeatureValue,
  type PaintPropertySpec,
  PaintState,
  supportsTransitions,
} from "./index.ts";

const spec = {
  width: { type: "float", default: 4, minimum: 0 },
  color: { type: "color", default: [1, 1, 1, 1] },
  heading: { type: "rotation", default: 0 },
} as const;
const names = ["width", "color", "heading"] as const;

const iconSpec = {
  anchor: {
    type: "enum",
    values: ["center", "left", "right"],
    default: "left",
  },
  offset: { type: "float2", default: [0, 0] },
} as const satisfies Record<string, PaintPropertySpec>;
const iconNames = ["anchor", "offset"] as const;

describe("compile", () => {
  it("accepts literal numbers and camera expressions", () => {
    expect(compile(spec.width, "width", 12)(0)).toEqual([12]);
    const zoomed = compile(spec.width, "width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      4,
      10,
      14,
    ]);
    expect(zoomed(5)[0]).toBeCloseTo(9);
  });

  it("premultiplies colors from CSS strings and float arrays", () => {
    expect(compile(spec.color, "color", "rgba(255, 0, 0, 0.5)")(0)).toEqual([
      0.5, 0, 0, 0.5,
    ]);
    expect(compile(spec.color, "color", [1, 0.5, 0, 0.5])(0)).toEqual([
      0.5, 0.25, 0, 0.5,
    ]);
  });

  it("rejects invalid values", () => {
    expect(() => compile(spec.color, "color", "not a color")).toThrow();
    expect(() => compile(spec.width, "width", "twelve")).toThrow();
  });

  it("rejects constants outside the bounds, like MapLibre Native", () => {
    const opacity = {
      type: "float",
      default: 1,
      minimum: 0,
      maximum: 1,
    } as const;
    expect(compile(opacity, "opacity", 0)(0)).toEqual([0]);
    expect(compile(opacity, "opacity", 1)(0)).toEqual([1]);
    expect(() => compile(opacity, "opacity", 1.5)).toThrow(/outside 0\.\.1/);
    expect(() => compile(opacity, "opacity", -1)).toThrow(/outside 0\.\.1/);
    expect(() => compile(spec.width, "width", -1)).toThrow(/outside 0\.\.inf/);
    // An expression without zoom folds to a constant.
    expect(() => compile(opacity, "opacity", ["+", 1, 0.5])).toThrow(/outside/);
    // The host compares the f32 value.
    expect(compile(opacity, "opacity", 1.00000001)(0)).toEqual([1.00000001]);
    // Zoom expressions are neither checked nor clamped.
    const zoomed = compile(opacity, "opacity", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      10,
      2,
    ]);
    expect(zoomed(10)).toEqual([2]);
    const state = new PaintState(
      { opacity },
      ["opacity"],
      DEFAULT_TRANSITION,
      {},
    );
    expect(() => state.set("opacity", 2, 0)).toThrow(/outside/);
    expect(state.get("opacity")).toBe(1);
    expect(
      () =>
        new PaintState({ opacity }, ["opacity"], DEFAULT_TRANSITION, {
          opacity: 1.5,
        }),
    ).toThrow(/outside/);
  });
});

describe("ease", () => {
  it("matches cubic-bezier(0, 0, 0.25, 1)", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
  });
});

describe("PaintState", () => {
  it("starts from defaults, sets values with transitions, and serializes", () => {
    const state = new PaintState(spec, names, DEFAULT_TRANSITION, {
      width: 10,
      "color-transition": { duration: 50 },
    });
    expect(state.get("width")).toBe(10);
    expect(state.evaluate(0, 0)).toEqual({
      width: [10],
      color: [1, 1, 1, 1],
      heading: [0],
    });
    state.set("width", 20, 1000);
    expect(state.evaluate(0, 1000).width).toEqual([10]);
    expect(state.evaluate(0, 1150).width[0]).toBeCloseTo(10 + 10 * ease(0.5));
    expect(state.active(1200)).toBe(true);
    expect(state.evaluate(0, 1300).width).toEqual([20]);
    expect(state.active(1300)).toBe(false);
    // Per-property transitions override the default duration.
    state.set("color", [0, 0, 0, 1], 2000);
    expect(state.evaluate(0, 2050).color).toEqual([0, 0, 0, 1]);
    // Rotations take the shortest arc.
    state.set("heading", 350, 3000);
    state.set("heading", 10, 3300);
    // Rotations take the shortest arc, so 350 -> 10 passes through 360.
    expect(state.evaluate(0, 3450).heading[0]).toBeCloseTo(
      350 + 20 * ease(0.5),
    );
    expect(state.toJson()).toEqual({
      width: 20,
      color: [0, 0, 0, 1],
      heading: 10,
      "color-transition": { duration: 50 },
    });
    expect(() => state.set("nope", 1, 0)).toThrow();
    expect(() => state.set("width", "wide", 0)).toThrow();
    expect(state.get("width")).toBe(20);
  });
});

describe("enum", () => {
  const anchor = iconSpec.anchor;

  it("evaluates a listed literal to its index", () => {
    expect(compile(anchor, "anchor", "center")(0)).toEqual([0]);
    expect(compile(anchor, "anchor", "right")(0)).toEqual([2]);
  });

  it("rejects a literal outside the list", () => {
    expect(() => compile(anchor, "anchor", "top")).toThrow(/not one of/);
    expect(() => compile(anchor, "anchor", 1)).toThrow();
    expect(() => compile(anchor, "anchor", ["get", "anchor"])).toThrow();
  });

  it("checks an expression without zoom like the literal it folds to", () => {
    expect(compile(anchor, "anchor", ["literal", "right"])(0)).toEqual([2]);
    expect(compile(anchor, "anchor", ["concat", "ri", "ght"])(0)).toEqual([2]);
    expect(() => compile(anchor, "anchor", ["literal", "top"])).toThrow(
      /not one of/,
    );
  });

  it("falls back to the default's index when a zoom expression leaves the list", () => {
    const stepped = compile(anchor, "anchor", [
      "step",
      ["zoom"],
      "center",
      10,
      "top",
      14,
      "right",
    ]);
    expect(stepped(5)).toEqual([0]);
    expect(stepped(12)).toEqual([1]);
    expect(stepped(15)).toEqual([2]);
    expect(() =>
      compile(anchor, "anchor", ["interpolate", ["linear"], ["zoom"], 0, 0]),
    ).toThrow();
  });

  it("holds the prior value until a transition ends, then snaps", () => {
    const state = new PaintState(iconSpec, iconNames, DEFAULT_TRANSITION, {});
    expect(state.evaluate(0, 0).anchor).toEqual([1]);
    state.set("anchor", "right", 1000);
    expect(state.evaluate(0, 1000).anchor).toEqual([1]);
    expect(state.evaluate(0, 1299).anchor).toEqual([1]);
    expect(state.active(1299)).toBe(true);
    expect(state.evaluate(0, 1300).anchor).toEqual([2]);
    expect(state.active(1300)).toBe(false);
    state.set("anchor", "center", 2000, { duration: 0 });
    expect(state.evaluate(0, 2000).anchor).toEqual([0]);
    expect(state.get("anchor")).toBe("center");
  });

  it("takes no per-property transition", () => {
    expect(supportsTransitions(anchor)).toBe(false);
    expect(supportsTransitions(iconSpec.offset)).toBe(true);
    // MapLibre Native rejects the key whatever its value.
    for (const transition of [{ duration: 50 }, null]) {
      expect(
        () =>
          new PaintState(iconSpec, iconNames, DEFAULT_TRANSITION, {
            "anchor-transition": transition,
          }),
      ).toThrow(/takes no transition/);
    }
    const state = new PaintState(iconSpec, iconNames, DEFAULT_TRANSITION, {
      "offset-transition": { duration: 50 },
    });
    expect(state.toJson()).toEqual({
      anchor: "left",
      offset: [0, 0],
      "offset-transition": { duration: 50 },
    });
    expect(() => state.set("anchor-transition", { duration: 50 }, 0)).toThrow(
      /takes no transition/,
    );
    expect(() => state.set("anchor", "top", 0)).toThrow();
    expect(state.get("anchor")).toBe("left");
  });
});

describe("float2", () => {
  const offset = iconSpec.offset;

  it("accepts pairs and zoom expressions", () => {
    expect(compile(offset, "offset", [3, -4])(0)).toEqual([3, -4]);
    const zoomed = compile(offset, "offset", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      ["literal", [0, 0]],
      10,
      ["literal", [10, -20]],
    ]);
    expect(zoomed(5)).toEqual([5, -10]);
    expect(() => compile(offset, "offset", [1])).toThrow();
    expect(() => compile(offset, "offset", [1, Number.NaN])).toThrow();
    expect(() => compile(offset, "offset", "far")).toThrow();
  });

  it("transitions each component along the eased curve", () => {
    const state = new PaintState(iconSpec, iconNames, DEFAULT_TRANSITION, {
      offset: [0, 10],
    });
    state.set("offset", [20, -10], 1000);
    const [x, y] = state.evaluate(0, 1150).offset;
    expect(x).toBeCloseTo(20 * ease(0.5));
    expect(y).toBeCloseTo(10 - 20 * ease(0.5));
    expect(state.evaluate(0, 1300).offset).toEqual([20, -10]);
    expect(state.toJson()).toEqual({ anchor: "left", offset: [20, -10] });
  });
});

describe("data-driven values in PaintState", () => {
  const ddSpec = {
    size: { type: "float", default: 1, minimum: 0, expressions: "data-driven" },
    mode: {
      type: "enum",
      values: ["loop", "once"],
      default: "loop",
      expressions: "data-driven",
    },
    tilt: { type: "float", default: 0 },
  } as const satisfies Record<string, PaintPropertySpec>;
  const ddNames = ["size", "mode", "tilt"] as const;
  const get = ["get", "size"];

  it("returns FeatureValues from current() and evaluates them without a feature in evaluate()", () => {
    const state = new PaintState(ddSpec, ddNames, DEFAULT_TRANSITION, {
      size: ["coalesce", ["feature-state", "size"], 3],
      mode: ["get", "mode"],
    });
    const current = state.current(0, 0);
    expect(isFeatureValue(current.size)).toBe(true);
    expect(isFeatureValue(current.mode)).toBe(true);
    expect(current.tilt).toEqual([0]);
    // The host's should_animate evaluation: feature-state reads null, a
    // feature accessor fails and gives the default.
    expect(state.evaluate(0, 0)).toEqual({ size: [3], mode: [0], tilt: [0] });
  });

  it("rejects a data expression on a camera property with the host's text", () => {
    const state = new PaintState(ddSpec, ddNames, DEFAULT_TRANSITION, {});
    expect(() => state.set("tilt", ["get", "tilt"], 0)).toThrow(
      "expression dependencies are not supported for plugin property 'tilt'",
    );
    expect(state.get("tilt")).toBe(0);
  });

  // style/properties.hpp Transitioning::evaluate and
  // possibly_evaluated_property_value.hpp Interpolator.
  it("follows the host's transition matrix", () => {
    const state = new PaintState(ddSpec, ddNames, DEFAULT_TRANSITION, {
      size: 2,
    });
    // Uniform to uniform interpolates.
    state.set("size", 4, 0);
    expect(state.evaluate(0, 150).size[0]).toBeCloseTo(2 + 2 * ease(0.5));
    expect(state.active(150)).toBe(true);
    // A data-driven target snaps and drops the prior.
    state.set("size", get, 1000);
    const bound = state.current(0, 1000).size;
    expect(isFeatureValue(bound)).toBe(true);
    expect(state.active(1000)).toBe(false);
    // A uniform target holds a data-driven prior until the transition ends...
    state.set("size", 5, 2000);
    expect(state.current(0, 2000).size).toBe(bound);
    expect(state.current(0, 2299).size).toBe(bound);
    expect(state.active(2299)).toBe(true);
    // ...then switches.
    expect(state.current(0, 2300).size).toEqual([5]);
    expect(state.active(2300)).toBe(false);
    // A delayed data-driven target still snaps.
    state.set("size", get, 3000, { duration: 300, delay: 100 });
    expect(isFeatureValue(state.current(0, 3000).size)).toBe(true);
    // A data-driven target over a data-driven prior snaps too.
    const first = state.current(0, 3000).size;
    state.set("size", ["*", 2, ["get", "size"]], 3100);
    const second = state.current(0, 3100).size;
    expect(isFeatureValue(second)).toBe(true);
    expect(second).not.toBe(first);
  });

  it("holds an enum's data-driven prior until the transition ends", () => {
    const state = new PaintState(ddSpec, ddNames, DEFAULT_TRANSITION, {
      mode: ["get", "mode"],
    });
    const bound = state.current(0, 0).mode;
    state.set("mode", "once", 100);
    expect(state.current(0, 399).mode).toBe(bound);
    expect(state.current(0, 400).mode).toEqual([1]);
  });

  it("bumps generation whenever a property becomes, changes or stops being data-driven", () => {
    const state = new PaintState(ddSpec, ddNames, DEFAULT_TRANSITION, {});
    state.current(0, 0);
    const start = state.generation;
    // Uniform changes never bump it: they go to the uniform block.
    state.set("size", 3, 0);
    state.current(0, 100);
    state.current(0, 400);
    expect(state.generation).toBe(start);
    // A snap to a data-driven value bumps it once, at set().
    state.set("size", get, 1000);
    expect(state.generation).toBe(start + 1);
    state.current(0, 1000);
    state.evaluate(0, 1001);
    expect(state.generation).toBe(start + 1);
    // Another data-driven value is another generation.
    state.set("size", get, 1100);
    expect(state.generation).toBe(start + 2);
    // The switch back to uniform happens when the transition ends.
    state.set("size", 1, 2000);
    state.current(0, 2100);
    expect(state.generation).toBe(start + 2);
    state.current(0, 2300);
    expect(state.generation).toBe(start + 3);
  });

  it("takes a -transition key when the spec says so, enums included", () => {
    const spec = {
      speed: { type: "float", default: 1, transition: true },
      frozen: { type: "float", default: 1, transition: false },
      mode: {
        type: "enum",
        values: ["a", "b"],
        default: "a",
        transition: true,
      },
    } as const satisfies Record<string, PaintPropertySpec>;
    const names = ["speed", "frozen", "mode"] as const;
    const state = new PaintState(spec, names, DEFAULT_TRANSITION, {
      "speed-transition": { duration: 0 },
      "mode-transition": { duration: 0 },
    });
    state.set("speed", 3, 0);
    expect(state.current(0, 0).speed).toEqual([3]);
    expect(
      () =>
        new PaintState(spec, names, DEFAULT_TRANSITION, {
          "frozen-transition": { duration: 0 },
        }),
    ).toThrow(/takes no transition/);
  });
});
