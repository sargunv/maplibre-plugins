import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type FeatureValue, isFeatureValue } from "@maplibre-plugins/paint";
import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "./catalog.ts";
import demoCatalog from "./generated/catalog.ts";
import {
  createPaintState,
  DEFAULT_TRANSITION,
  shouldAnimate,
  uniformNumber,
} from "./paint.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalog = Catalog.fromBase64(demoCatalog);
const example = JSON.parse(
  readFileSync(join(pluginRoot, "examples", "layer.json"), "utf8"),
) as { paint: Record<string, unknown> };
const names = catalog.enumValues();

function feature(value: unknown): FeatureValue {
  if (!isFeatureValue(value)) throw new Error("expected a data-driven value");
  return value;
}

describe("createPaintState", () => {
  it("evaluates the example layer's paint per feature", () => {
    const state = createPaintState(catalog, DEFAULT_TRANSITION, example.paint);
    const current = state.current(16, 0);
    const animation = feature(current["icon-animation"]);
    const stop = { type: 1, id: 100, properties: { class: "bus" } } as const;
    const school = { type: 1, properties: { class: "school" } } as const;
    expect(animation.at(16, stop)).toEqual([names.indexOf("pulse")]);
    expect(animation.at(16, school)).toEqual([names.indexOf("pin")]);
    const anchor = feature(current["icon-anchor"]);
    expect(anchor.at(16, stop)).toEqual([0]);
    expect(anchor.at(16, school)).toEqual([4]);
    // ["id"] desynchronizes the icons; a feature without an id reads 0.
    const offset = feature(current["icon-animation-offset"]);
    expect(offset.at(16, stop)[0]).toBeCloseTo(3 * 0.137, 12);
    expect(offset.at(16, school)).toEqual([0]);
    // A camera expression stays a vector at the render zoom.
    expect(current["icon-size"]).toEqual([1]);
    expect(current["icon-offset"]).toEqual([0, 0]);
    expect(current["icon-color"]).toEqual([0, 0, 0, 0]);
    expect(current["icon-rotation-alignment"]).toEqual([0]);
    expect(current["icon-animation-speed"]).toEqual([1]);
    expect(current["icon-animation-mode"]).toEqual([0]);
  });

  it("accepts only none and the catalog's animation names", () => {
    const state = createPaintState(catalog, DEFAULT_TRANSITION, {});
    expect(state.evaluate(0, 0)["icon-animation"]).toEqual([0]);
    for (const [index, animation] of catalog.animations.entries()) {
      state.set("icon-animation", animation.name, 0, { duration: 0 });
      expect(state.evaluate(0, 0)["icon-animation"]).toEqual([index + 1]);
    }
    expect(() => state.set("icon-animation", "nope", 0)).toThrow();
    expect(() => state.set("icon-animation-transition", {}, 0)).toThrow();
  });

  it("takes the M1 playback properties with the native bounds and transitions", () => {
    const state = createPaintState(catalog, DEFAULT_TRANSITION, {});
    state.set("icon-animation-speed", -4, 0);
    expect(() => state.set("icon-animation-speed", 4.5, 0)).toThrow(/outside/);
    state.set("icon-animation-speed-transition", { duration: 0 }, 0);
    state.set("icon-animation-offset", -8192, 0);
    state.set("icon-animation-mode", "alternate", 0);
    // An enum holds through the default transition, then switches.
    expect(state.evaluate(0, 1)["icon-animation-mode"]).toEqual([0]);
    expect(state.evaluate(0, 300)["icon-animation-mode"]).toEqual([1]);
    expect(() => state.set("icon-animation-mode", "bounce", 0)).toThrow();
    expect(() => state.set("icon-animation-mode-transition", {}, 0)).toThrow(
      /takes no transition/,
    );
    // The alignments stay camera-only, with the host's error.
    expect(() =>
      state.set("icon-pitch-alignment", ["get", "pitch"], 0),
    ).toThrow(
      "expression dependencies are not supported for plugin property 'icon-pitch-alignment'",
    );
    // Every other property takes feature-state too.
    state.set(
      "icon-animation-offset",
      ["-", 0, ["number", ["feature-state", "start"], 8192]],
      0,
    );
    const offset = feature(state.current(0, 0)["icon-animation-offset"]);
    expect(offset.stateDependent).toBe(true);
    expect(offset.at(0, { type: 1, properties: {} }, { start: 12 })).toEqual([
      -12,
    ]);
  });
});

describe("shouldAnimate", () => {
  it("plays unless a value the same for every feature rules it out", () => {
    const state = createPaintState(catalog, DEFAULT_TRANSITION, {
      "icon-animation": "pulse",
    });
    const set = (name: string, value: unknown) =>
      state.set(name, value, 0, { duration: 0 });
    const animates = () => shouldAnimate(state.current(0, 0));
    expect(animates()).toBe(true);
    set("icon-opacity", 0);
    expect(animates()).toBe(false);
    set("icon-opacity", 1);
    set("icon-size", 0);
    expect(animates()).toBe(false);
    set("icon-size", 1);
    set("icon-animation-speed", 0);
    expect(animates()).toBe(false);
    set("icon-animation-speed", -1);
    expect(animates()).toBe(true);
    set("icon-animation", "none");
    expect(animates()).toBe(false);
  });

  it("never stops for a data-driven value", () => {
    const state = createPaintState(catalog, DEFAULT_TRANSITION, {
      "icon-animation": ["get", "icon"],
      "icon-size": ["get", "size"],
      "icon-opacity": [
        "case",
        ["boolean", ["feature-state", "on"], false],
        1,
        0,
      ],
      "icon-animation-speed": ["get", "speed"],
    });
    const current = state.current(0, 0);
    expect(uniformNumber(current, "icon-animation")).toBeNull();
    // Without a feature each of them would read its default or 0.
    expect(shouldAnimate(current)).toBe(true);
  });
});
