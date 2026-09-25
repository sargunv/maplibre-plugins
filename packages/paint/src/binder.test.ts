// The data-driven binder against expectations MapLibre Native generated
// itself (fixtures/binder/expected.json, written by fixtures/binder/probe.cpp
// from cases.json), plus the attribute layout and fill.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  attributeLayout,
  type CompiledValue,
  compileValue,
  type Current,
  DEFAULT_TRANSITION,
  type EvaluationFeature,
  type FeatureSource,
  type FeatureState,
  fillAttributes,
  isFeatureValue,
  type PaintPropertySpec,
  PaintState,
  PaintValue,
  type Vector,
} from "./index.ts";

// --- Host fixtures ------------------------------------------------------------

/** A host number; non-finite ones are the strings NaN, Infinity and -Infinity. */
type HostNumber = number | string;
/** A host plugin value: a number, an array of numbers, or an enum string. */
type HostValue = HostNumber | HostNumber[];

interface Evaluation {
  readonly zoom: number;
  readonly feature?: EvaluationFeature;
  readonly state?: FeatureState;
}

interface TransitionStep {
  readonly now: number;
  readonly set?: unknown;
  readonly duration?: number;
  readonly delay?: number;
  readonly zoom?: number;
}

interface Case {
  readonly name: string;
  readonly property: PaintPropertySpec & { readonly name: string };
  readonly value: unknown;
  readonly evaluations: readonly Evaluation[];
  readonly factors: readonly { bucketZoom: number; zoom: number }[];
  readonly transitions?: readonly {
    initial: unknown;
    steps: readonly TransitionStep[];
  }[];
}

interface Expected {
  readonly name: string;
  readonly parse: { ok: true } | { error: string };
  readonly dataDriven?: boolean;
  readonly zoomConstant?: boolean;
  readonly usesFeatureState?: boolean;
  readonly evaluations?: readonly {
    without: HostValue;
    uniform?: HostNumber[];
    value?: HostValue;
    encoded?: HostNumber[];
  }[];
  readonly factors?: readonly HostNumber[];
  readonly transitions?: readonly (readonly (
    | { kind: "uniform"; value: HostValue }
    | { kind: "feature"; which: number }
  )[])[];
}

const fixtures = new URL("../fixtures/binder/", import.meta.url);
const cases = (
  JSON.parse(readFileSync(new URL("cases.json", fixtures), "utf8")) as {
    cases: Case[];
  }
).cases;
const expected = JSON.parse(
  readFileSync(new URL("expected.json", fixtures), "utf8"),
) as { source: string; cases: Expected[] };

// The host's own messages for the checks the plugin property layer adds
// (plugin_property.cpp validateConstant and convertPluginPropertyValue). The
// binder must throw these texts; for other parse errors the style spec's
// wording differs from the host's, so only the rejection itself must match.
const hostMessages = [
  "value is not allowed for plugin property",
  "value is outside the allowed range for plugin property",
  "expression dependencies are not supported for plugin property",
];

function hostNumber(value: HostNumber): number {
  return typeof value === "number" ? value : Number(value);
}

/** The host's plugin value as this package's vector: enums become indices. */
function hostVector(spec: PaintPropertySpec, value: HostValue): Vector {
  if (spec.type === "enum") {
    const index = spec.values.indexOf(value as string);
    return [index < 0 ? spec.values.indexOf(spec.default) : index];
  }
  return Array.isArray(value) ? value.map(hostNumber) : [hostNumber(value)];
}

/**
 * Cases whose expression interpolates between stops with a curve: the host
 * computes the curve factor in f32 and the style spec in double, so a value
 * between stops may differ in the last f32 place. The binder's own work
 * (endpoints, factors, fallbacks, wraps) stays exact.
 */
const curveRounding = new Set(["composite-cubic-bezier"]);

/**
 * Exact agreement once written into a Float32Array (a double2 value stays a
 * double), with NaN equal to NaN and -0 equal to 0; `ulps` allows that many
 * f32 steps.
 */
function expectVector(
  actual: Vector,
  wanted: Vector,
  spec: PaintPropertySpec,
  label: string,
  ulps = 0,
): void {
  const round = spec.type === "double2" ? (v: number) => v : Math.fround;
  expect(actual.length, label).toBe(wanted.length);
  wanted.forEach((value, i) => {
    const got = round(actual[i]!);
    if (Number.isNaN(value)) {
      expect(got, label).toBeNaN();
      return;
    }
    const step = 2 ** (Math.floor(Math.log2(Math.abs(value) || 1)) - 23);
    expect(
      got === value || Math.abs(got - value) <= ulps * step,
      `${label}: ${got} vs ${value}`,
    ).toBe(true);
  });
}

/**
 * Transitions interpolate with this package's ease and formula, which differ
 * from the host's in the last digits (the host solves the ease curve to
 * 0.001), and rotations are compared on the circle.
 */
function expectTransitioned(
  actual: Vector,
  wanted: Vector,
  spec: PaintPropertySpec,
  label: string,
): void {
  expect(actual.length, label).toBe(wanted.length);
  wanted.forEach((value, i) => {
    let got = actual[i]!;
    if (spec.type === "rotation") got = ((got % 360) + 360) % 360;
    expect(Math.abs(got - value), label).toBeLessThanOrEqual(
      1e-3 * Math.max(1, Math.abs(value)),
    );
  });
}

function runTransitions(testCase: Case, wanted: Expected): void {
  const spec = testCase.property;
  testCase.transitions?.forEach((script, s) => {
    const sets: CompiledValue[] = [
      compileValue(spec, spec.name, script.initial),
    ];
    const value = new PaintValue(spec.name, spec.type, sets[0]!);
    let sample = 0;
    for (const step of script.steps) {
      if ("set" in step) {
        const next = compileValue(spec, spec.name, step.set);
        sets.push(next);
        value.retarget(next, step.now, {
          duration: step.duration ?? 0,
          delay: step.delay ?? 0,
        });
        continue;
      }
      const result = wanted.transitions![s]![sample++]!;
      const label = `script ${s} at ${step.now} ms`;
      const current = value.current(step.zoom!, step.now);
      if (result.kind === "feature") {
        expect(current, label).toBe(sets[result.which]);
      } else {
        expect(isFeatureValue(current), label).toBe(false);
        expectTransitioned(
          current as Vector,
          hostVector(spec, result.value),
          spec,
          label,
        );
      }
    }
  });
}

function runCase(testCase: Case, wanted: Expected): void {
  const spec = testCase.property;
  const name = spec.name;
  const ulps = curveRounding.has(testCase.name) ? 2 : 0;
  if ("error" in wanted.parse) {
    const message = wanted.parse.error;
    const compiling = () => compileValue(spec, name, testCase.value);
    if (hostMessages.some((host) => message.startsWith(host)))
      expect(compiling).toThrow(message);
    else expect(compiling).toThrow();
    return;
  }
  const compiled = compileValue(spec, name, testCase.value);
  expect(compiled.kind === "feature", "dataDriven").toBe(wanted.dataDriven);
  if (compiled.kind === "feature") {
    expect(compiled.zoomDependent, "zoomConstant").toBe(!wanted.zoomConstant);
    expect(compiled.stateDependent, "usesFeatureState").toBe(
      wanted.usesFeatureState,
    );
  } else {
    expect(wanted.usesFeatureState).toBe(false);
  }

  testCase.evaluations.forEach((evaluation, i) => {
    const result = wanted.evaluations![i]!;
    const { zoom, feature, state } = evaluation;
    const label = `evaluation ${i} at z${zoom}`;
    expectVector(
      compiled.kind === "feature"
        ? compiled.withoutFeature(zoom)
        : compiled.at(zoom),
      hostVector(spec, result.without),
      spec,
      `${label} without a feature`,
    );
    if (result.uniform) {
      expect(compiled.kind).toBe("uniform");
      expectVector(
        compiled.kind === "uniform" ? compiled.at(zoom) : [],
        result.uniform.map(hostNumber),
        spec,
        `${label} uniform`,
      );
    }
    if (!feature || compiled.kind !== "feature") return;
    expectVector(
      compiled.at(zoom, feature, state),
      hostVector(spec, result.value!),
      spec,
      `${label} with the feature`,
      ulps,
    );
    if (result.encoded) {
      const out = new Float32Array(2 * compiled.components);
      compiled.encode(zoom, feature, state, out, 0);
      expectVector(
        [...out],
        result.encoded.map(hostNumber),
        spec,
        `${label} encoded`,
        ulps,
      );
    }
  });

  testCase.factors.forEach(({ bucketZoom, zoom }, i) => {
    const factor =
      compiled.kind === "feature" ? compiled.factor(bucketZoom, zoom) : 0;
    expect(Math.fround(factor), `factor ${bucketZoom} → ${zoom}`).toBe(
      hostNumber(wanted.factors![i]!),
    );
  });

  runTransitions(testCase, wanted);
}

describe("host fixtures", () => {
  it("has an expectation for every case, generated by the host", () => {
    expect(expected.source).toBe("probe");
    expect(expected.cases.map((c) => c.name)).toEqual(cases.map((c) => c.name));
  });

  for (const [i, testCase] of cases.entries()) {
    it(testCase.name, () => runCase(testCase, expected.cases[i]!));
  }
});

// --- Attribute layout and fill --------------------------------------------------

describe("attributeLayout", () => {
  const spec = {
    animation: {
      type: "enum",
      values: ["none", "pulse"],
      default: "none",
      expressions: "data-driven",
    },
    size: { type: "float", default: 1, expressions: "data-driven" },
    color: { type: "color", default: [0, 0, 0, 0], expressions: "data-driven" },
    offset: { type: "float2", default: [0, 0], expressions: "data-driven" },
  } as const satisfies Record<string, PaintPropertySpec>;
  const names = ["animation", "size", "color", "offset"] as const;

  it("packs the data-driven properties in name order, two endpoints each", () => {
    const state = new PaintState(spec, names, DEFAULT_TRANSITION, {
      size: ["get", "size"],
      color: ["get", "color"],
    });
    const layout = attributeLayout(names, state.current(0, 0));
    expect(layout.key).toBe("1001");
    expect(layout.bound).toEqual(["size", "color"]);
    expect(layout.offsets).toEqual({ size: 0, color: 2 });
    expect(layout.stride).toBe(2 + 8);
  });

  it("gives an all-uniform key and no stride without data-driven values", () => {
    const state = new PaintState(spec, names, DEFAULT_TRANSITION, {});
    const layout = attributeLayout(names, state.current(0, 0));
    expect(layout).toEqual({ bound: [], offsets: {}, stride: 0, key: "1111" });
  });
});

describe("fillAttributes", () => {
  const spec = {
    size: { type: "float", default: 1, expressions: "data-driven" },
    hover: { type: "float", default: 0, expressions: "data-driven" },
    offset: { type: "float2", default: [0, 0], expressions: "data-driven" },
  } as const satisfies Record<string, PaintPropertySpec>;
  const names = ["size", "hover", "offset"] as const;
  const state = new PaintState(spec, names, DEFAULT_TRANSITION, {
    size: [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["get", "a"],
      11,
      ["get", "b"],
    ],
    hover: ["case", ["boolean", ["feature-state", "hover"], false], 1, 0],
    offset: ["get", "xy"],
  });
  const current: Readonly<Record<(typeof names)[number], Current>> =
    state.current(10, 0);
  const layout = attributeLayout(names, current);
  // Features 0 and 1 have ids; feature 2 has none. Feature 1 draws two
  // ranges, as a feature can in several segments.
  const features: EvaluationFeature[] = [
    { type: 1, id: 7, properties: { a: 1, b: 2, xy: [1, -1] } },
    { type: 1, id: "x", properties: { a: 3, b: 4, xy: [2, -2] } },
    { type: 1, properties: { a: 5, b: 6, xy: [3, -3] } },
  ];
  const states = new Map<string, FeatureState>();
  const source: FeatureSource = {
    feature: (index) => features[index],
    stateKey: (index) =>
      features[index]?.id === undefined
        ? undefined
        : String(features[index].id),
    state: (key) => states.get(key),
  };
  const ranges = [
    { featureIndex: 0, firstVertex: 0, vertexCount: 4 },
    { featureIndex: 1, firstVertex: 4, vertexCount: 4 },
    { featureIndex: 2, firstVertex: 8, vertexCount: 4 },
    { featureIndex: 1, firstVertex: 12, vertexCount: 2 },
  ];
  const vertex = (out: Float32Array, v: number) => [
    ...out.subarray(v * layout.stride, (v + 1) * layout.stride),
  ];

  it("fills every range's vertices with its feature's [min, max] per property", () => {
    expect(layout.key).toBe("000");
    expect(layout.stride).toBe(2 + 2 + 4);
    const out = new Float32Array(14 * layout.stride);
    expect(fillAttributes(out, layout, current, ranges, source, 10)).toEqual({
      first: 0,
      end: 14,
    });
    // size: min at z10 = a, max at z11 = b; hover: 0 without state;
    // offset: min = max.
    expect(vertex(out, 0)).toEqual([1, 2, 0, 0, 1, -1, 1, -1]);
    expect(vertex(out, 3)).toEqual([1, 2, 0, 0, 1, -1, 1, -1]);
    expect(vertex(out, 5)).toEqual([3, 4, 0, 0, 2, -2, 2, -2]);
    expect(vertex(out, 9)).toEqual([5, 6, 0, 0, 3, -3, 3, -3]);
    expect(vertex(out, 13)).toEqual([3, 4, 0, 0, 2, -2, 2, -2]);
  });

  it("refills only the stated keys' ranges, and only state-dependent properties with stateOnly", () => {
    const out = new Float32Array(14 * layout.stride);
    fillAttributes(out, layout, current, ranges, source, 10);
    states.set("x", { hover: true });
    out[4 * layout.stride] = 99; // A size value a stateOnly fill must keep.
    const dirty = fillAttributes(out, layout, current, ranges, source, 10, {
      keys: new Set(["x"]),
      stateOnly: true,
    });
    states.clear();
    expect(dirty).toEqual({ first: 4, end: 14 });
    expect(vertex(out, 4)).toEqual([99, 4, 1, 1, 2, -2, 2, -2]);
    expect(vertex(out, 13)).toEqual([3, 4, 1, 1, 2, -2, 2, -2]);
    // Feature 7 was not in the set.
    expect(vertex(out, 0)).toEqual([1, 2, 0, 0, 1, -1, 1, -1]);
    // A feature without an id has no state key, so a keyed fill skips it.
    expect(
      fillAttributes(out, layout, current, [ranges[2]!], source, 10, {
        keys: new Set(["x", "7"]),
      }),
    ).toBeNull();
  });

  it("returns null when nothing is bound or state-dependent, and skips ranges that do not fit", () => {
    const out = new Float32Array(10 * layout.stride);
    expect(
      fillAttributes(out, layout, current, ranges, source, 10, {
        keys: new Set(["nobody"]),
      }),
    ).toBeNull();
    // The last two ranges end past vertex 10.
    expect(fillAttributes(out, layout, current, ranges, source, 10)).toEqual({
      first: 0,
      end: 8,
    });
    const uniformState = new PaintState(spec, names, DEFAULT_TRANSITION, {});
    const uniformCurrent = uniformState.current(10, 0);
    expect(
      fillAttributes(
        out,
        attributeLayout(names, uniformCurrent),
        uniformCurrent,
        ranges,
        source,
        10,
      ),
    ).toBeNull();
    const sizeOnly = new PaintState(spec, names, DEFAULT_TRANSITION, {
      size: ["get", "a"],
    });
    const sizeCurrent = sizeOnly.current(10, 0);
    expect(
      fillAttributes(
        out,
        attributeLayout(names, sizeCurrent),
        sizeCurrent,
        ranges,
        source,
        10,
        { stateOnly: true },
      ),
    ).toBeNull();
  });

  it("rejects a layout that no longer matches the current values", () => {
    const out = new Float32Array(14 * layout.stride);
    const uniformCurrent = new PaintState(
      spec,
      names,
      DEFAULT_TRANSITION,
      {},
    ).current(10, 0);
    expect(() =>
      fillAttributes(out, layout, uniformCurrent, ranges, source, 10),
    ).toThrow(/recompute the attribute layout/);
  });
});
