// The particle-features vertex shader, GLSL ES 3.00. It is generated the way
// native/src/shaders.zig generates the native features wrapper: the same
// binding table (properties.zig's feature_bindings), the same
// MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM macro scheme, the same value fetch
// (a uniform, or the feature's min/max attributes mixed by the binding's
// interpolation factor, enums selected), the same spec-default constants and
// the same ParticleParams lanes from the emitter's lane map.
//
// Differences from native: there is no GL location ladder, because each
// program variant defines the macros itself and binds every attribute at its
// declared location; the values arrive in a uniform struct `u` whose members
// carry the native block's names, less the tile matrix; and the frame is read
// off maplibre's projectTileWithElevation at the particle's anchor, as the JS
// emitter does, so it follows the globe too.

import { emitterLanes, Lane, type LaneUse } from "./record.ts";
import {
  mapColumns,
  vertexCore,
  vertexOutput,
  vertexVaryings,
} from "./shader-common.ts";
import {
  featuresDataDriven,
  type FeaturesPaintName,
  featuresPaintNames,
  type PaintName,
  paintNames,
  paintSpec,
} from "./spec.ts";

/** One property binding of particle-features, as native properties.feature_bindings declares it. */
export interface FeatureBinding {
  readonly name: FeaturesPaintName;
  /** The uniform member, and the attribute stem `a_particle_<field>`. */
  readonly field: string;
  /** Location of the value's attribute; a color's maximum takes the next one. */
  readonly attribute: number;
}

/**
 * Binding k is the type's k-th property; its interpolation factor is
 * u.interpolation<k / 4>.<xyzw[k % 4]>. The data-driven four take locations
 * 1-5.
 */
export const featureBindings: readonly FeatureBinding[] = [
  { name: "particle-density", field: "density", attribute: 4 },
  { name: "particle-lifetime", field: "lifetime", attribute: 6 },
  { name: "particle-speed", field: "speed", attribute: 7 },
  { name: "particle-direction", field: "direction", attribute: 8 },
  { name: "particle-spread", field: "spread", attribute: 9 },
  { name: "particle-gravity", field: "gravity", attribute: 14 },
  { name: "particle-wander", field: "wander", attribute: 10 },
  { name: "particle-shape", field: "shape", attribute: 5 },
  { name: "particle-size", field: "size", attribute: 3 },
  { name: "particle-stretch", field: "stretch", attribute: 15 },
  { name: "particle-color", field: "color", attribute: 1 },
  { name: "particle-fade", field: "fade", attribute: 11 },
  { name: "particle-additive", field: "additive", attribute: 12 },
  { name: "particle-twinkle", field: "twinkle", attribute: 13 },
];

/** Data-driven properties of particle-features, by their bit in a program variant's mask. */
export type DataDrivenName = (typeof featuresDataDriven)[number];

/** Floats of a property's value: 1 for floats and enum indices, 2 for pairs, 4 for colors. */
export function valueWidth(name: PaintName): number {
  const type = paintSpec[name].type;
  if (type === "color") return 4;
  return type === "float2" || type === "double2" ? 2 : 1;
}

/** Where a data-driven property's per-vertex (min, max) attribute goes. */
export interface DataDrivenAttribute {
  readonly name: DataDrivenName;
  /** The mask bit of a program variant that takes it from attributes. */
  readonly bit: number;
  /** Binding index k, whose interpolation factor mixes min and max. */
  readonly binding: number;
  /** First location; a color's max takes the next one. */
  readonly location: number;
  /** Floats per endpoint. */
  readonly width: number;
}

export const dataDrivenAttributes: readonly DataDrivenAttribute[] =
  featuresDataDriven.map((name, bit) => {
    const binding = featureBindings.findIndex((b) => b.name === name);
    return {
      name,
      bit,
      binding,
      location: featureBindings[binding]!.attribute,
      width: valueWidth(name),
    };
  });

/**
 * The members of the uniform struct `u`: native's ParticleFeatureUBO without
 * the tile matrix (maplibre's projection replaces it) and the padding.
 * camera = (pixels to tile units, pixel ratio, time, camera-to-center
 * distance); screen = (pixels to GL units x, y, viewport width, height).
 */
export const featureMembers = [
  ["float4", "camera"],
  ["float4", "screen"],
  ["float4", "color"],
  ["float2", "size"],
  ["float2", "lifetime"],
  ["float2", "speed"],
  ["float2", "direction"],
  ["float2", "spread"],
  ["float2", "wander"],
  ["float2", "fade"],
  ["float2", "additive"],
  ["float2", "twinkle"],
  ["float", "density"],
  ["float", "shape"],
  ["float", "gravity"],
  ["float", "stretch"],
  ["float4", "interpolation0"],
  ["float4", "interpolation1"],
  ["float4", "interpolation2"],
  ["float4", "interpolation3"],
] as const;

/** Uniforms the features program sets besides the projection's, by member of `u`. */
export const FEATURE_UNIFORMS = featureMembers.map(
  ([, member]) => `u.${member}` as const,
);

export type FeatureUniform = (typeof FEATURE_UNIFORMS)[number];

/** A GLSL float literal as native writes them: 1.0, 0.5, -10000.0. */
function float(x: number): string {
  const text = String(x);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

function upperSnake(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The macro the host defines to 1 when a bound property arrives uniform and 0 when in attributes. */
export function propertyMacro(name: PaintName): string {
  return `MLN_PLUGIN_PROPERTY_${upperSnake(name)}_IS_UNIFORM`;
}

function defaultMacro(name: PaintName): string {
  return `PARTICLE_DEFAULT_${upperSnake(name)}`;
}

/** A property's spec default as a shader value: colors premultiplied, enums as their index. */
function defaultLiteral(name: PaintName): string {
  const property = paintSpec[name];
  const value = property.default;
  if (property.type === "enum")
    return float(
      (property.values as readonly string[]).indexOf(value as string),
    );
  if (typeof value === "number") return float(value);
  const v = value as readonly number[];
  if (property.type === "color") {
    const a = v[3]!;
    return `float4(${float(v[0]! * a)}, ${float(v[1]! * a)}, ${float(v[2]! * a)}, ${float(a)})`;
  }
  return `float2(${float(v[0]!)}, ${float(v[1]!)})`;
}

const isFeaturesName = (name: PaintName) =>
  (featuresPaintNames as readonly string[]).includes(name);

/** #defines for every property the features type does not list. */
export const featureDefaults = `// Spec defaults of the properties particle-features does not list.
${paintNames
  .filter((name) => !isFeaturesName(name))
  .map((name) => `#define ${defaultMacro(name)} ${defaultLiteral(name)}\n`)
  .join("")}`;

function attributeName(binding: FeatureBinding, slot: number): string {
  const stem = `a_particle_${binding.field}`;
  if (valueWidth(binding.name) !== 4) return stem;
  return slot === 0 ? `${stem}_min` : `${stem}_max`;
}

const slots = (binding: FeatureBinding) =>
  paintSpec[binding.name].type === "color" ? 2 : 1;

/**
 * a_emit plus each binding's attributes at their declared locations, only
 * while the variant takes that property from attributes. Scalars and enums
 * pack (min, max) into a vec2, pairs into a vec4; a color takes a vec4 per end.
 */
export const featureAttributes = `layout(location=0) in vec4 a_emit;
${[...featureBindings]
  .sort((a, b) => a.attribute - b.attribute)
  .map((binding) => {
    const type = valueWidth(binding.name) === 1 ? "vec2" : "vec4";
    let text = `#if !${propertyMacro(binding.name)}\n`;
    for (let slot = 0; slot < slots(binding); slot++)
      text += `layout(location=${binding.attribute + slot}) in ${type} ${attributeName(binding, slot)};\n`;
    return `${text}#endif\n`;
  })
  .join("")}`;

const localName = (binding: FeatureBinding) => `p_${binding.field}`;

function interpolation(k: number): string {
  return `u.interpolation${Math.floor(k / 4)}.${"xyzw"[k % 4]}`;
}

/** Each value from `u`, or from its attributes: floats and colors interpolate by the binding's factor, enums select. */
export const featureFetch = featureBindings
  .map((binding, k) => {
    const a = attributeName(binding, 0);
    const t = interpolation(k);
    const type = paintSpec[binding.name].type;
    let local: string;
    let mixed: string;
    if (type === "enum") {
      local = "float";
      mixed = `(${t} < 0.5 ? ${a}.x : ${a}.y)`;
    } else if (type === "float") {
      local = "float";
      mixed = `mix(${a}.x, ${a}.y, ${t})`;
    } else if (type === "float2") {
      local = "float2";
      mixed = `mix(${a}.xy, ${a}.zw, ${t})`;
    } else {
      local = "float4";
      mixed = `mix(${a}, ${attributeName(binding, 1)}, ${t})`;
    }
    const name = localName(binding);
    return `    ${local} ${name} = u.${binding.field};
#if !${propertyMacro(binding.name)}
    ${name} = ${mixed};
#endif
`;
  })
  .join("");

/** A property's value in the features shader: the fetched local, or its default. */
function featureValue(name: PaintName): string {
  const binding = featureBindings.find((b) => b.name === name);
  return binding ? localName(binding) : defaultMacro(name);
}

const lanes = Object.entries(emitterLanes) as [PaintName, LaneUse][];

/** Emitter kind 3 marks a feature particle in the packed identity (native identity.feature_kind). */
const FEATURE_KIND = paintSpec["emitter-kind"].values.length;

/**
 * The packed identity: features are kind 3 with the shape they fetch (or its
 * default) and every other identity part at its default.
 */
export const featureIdentity = `    float packedIdentity = ${lanes
  .filter(([, use]) => use.use === "identity")
  .map(([name, use]) => {
    const property = paintSpec[name];
    let value: string;
    if (name === "emitter-kind") value = float(FEATURE_KIND);
    else if (property.type === "enum" && isFeaturesName(name))
      value = `clamp(floor(${featureValue(name)} + 0.5), 0.0, ${float((property.values as readonly string[]).length - 1)})`;
    else value = featureValue(name);
    return use.weight === 1 ? value : `${float(use.weight!)} * ${value}`;
  })
  .join(" + ")};
`;

/** ParticleParams member names, by lane. */
const laneMembers = Object.fromEntries(
  Object.entries(Lane).map(([member, lane]) => [lane, member]),
) as Record<number, string>;

/**
 * ParticleParams from the lane map, so the features shader fills every lane
 * exactly as the emitter's row does. The color-end lane takes particle-color
 * (a transparent end over it is the color), and opacity's default of 1
 * leaves both unchanged.
 */
export const featureParams = (() => {
  let text = "    ParticleParams P;\n";
  for (let lane = Lane.color; lane <= Lane.area; lane++) {
    const pieces: string[] = [];
    let width = 0;
    for (let component = 0; component < 4; component++) {
      for (const [name, use] of lanes) {
        if (use.lane !== lane || use.component !== component) continue;
        if (use.use === "raw" || use.use === "clamped") {
          pieces.push(featureValue(name));
          width += valueWidth(name);
        } else if (use.use === "color") {
          pieces.push(featureValue("particle-color"));
          width += 4;
        } else if (use.use === "identity" && use.weight === 1) {
          pieces.push("packedIdentity");
          width += 1;
        }
      }
    }
    if (width !== 4)
      throw new Error(`lane ${laneMembers[lane]} is not fully covered`);
    const value =
      pieces.length === 1 ? pieces[0]! : `float4(${pieces.join(", ")})`;
    text += `    P.${laneMembers[lane]} = ${value};\n`;
  }
  return `${text}    P = particleClampParams(P);\n`;
})();

/**
 * The frame, the seed and the model. The ground frame of native's features
 * wrapper (C + east X + north Y, up the screen for up), with C, X and Y read
 * off maplibre's projection at the anchor per pixel of the current zoom.
 */
const featureBody = `    float ptu = u.camera.x;
    ParticleMapColumns m = particleMapColumns(emit.xy, ptu, 1.0);
    ParticleFrame F;
    F.C = m.C;
    F.X = m.X;
    F.Y = -m.Y;
    F.Z = float4(0.0, -u.screen.y * u.camera.w, 0.0, 0.0);
    F.screen = u.screen;
    F.view = float4(u.camera.w, u.camera.y, 1.0, 1.0);
    ParticleWeather W;
    W.eye = float4(0.0, 0.0, 0.0, 0.0);
    W.pool0 = W.eye;
    W.pool1 = W.eye;
    W.weights = W.eye;
    ParticleSeed S = particleFeatureSeed(emit, ${featureValue("particle-density")}, ptu);
    ParticleVertex o = particleVertex(P, F, W, S, u.camera.z);
#ifdef GLOBE
    // A particle whose anchor lies behind the globe is hidden with it.
    if (m.C.z > m.C.w) {
        o = particleCollapsed();
    }
#endif
`;

/** The mask bit of each data-driven property a variant takes from attributes. */
export function variantMask(dataDriven: Iterable<DataDrivenName>): number {
  let mask = 0;
  for (const name of dataDriven)
    mask |= 1 << (featuresDataDriven as readonly string[]).indexOf(name);
  return mask;
}

/** The IS_UNIFORM macros of one variant: 0 for the properties in `mask`, 1 for every other. */
export function variantDefines(mask: number): string {
  return featureBindings
    .map((binding) => {
      const bit = (featuresDataDriven as readonly string[]).indexOf(
        binding.name,
      );
      const attributes = bit >= 0 && (mask & (1 << bit)) !== 0;
      return `#define ${propertyMacro(binding.name)} ${attributes ? 0 : 1}\n`;
    })
    .join("");
}

/**
 * The vertex shader for one projection variant (maplibre's prelude and
 * defines first) and one data-driven mask.
 */
export function featuresVertexSource(
  prelude: string,
  define: string,
  mask: number,
): string {
  return `#version 300 es
${prelude}
${define}
${variantDefines(mask)}${vertexCore}
${mapColumns}
${featureDefaults}${featureAttributes}struct ParticleFeatureUniforms {
${featureMembers.map(([type, name]) => `    ${type} ${name};\n`).join("")}};
uniform ParticleFeatureUniforms u;
${vertexVaryings}void main() {
    float4 emit = a_emit;
${featureFetch}${featureIdentity}${featureParams}${featureBody}${vertexOutput}}
`;
}
