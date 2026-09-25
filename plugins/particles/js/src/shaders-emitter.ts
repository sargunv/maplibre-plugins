// The particle-emitter vertex shader, GLSL ES 3.00. It mirrors the native
// emitter wrapper in native/src/shaders.zig: a_particle carries (vertex
// index, row), vertices 0-3 are the screen-tint quad and every other four
// are one particle's corners. The header and the one row arrive as uniform
// arrays laid out like the native frame table (record.ts). Both build the
// frame with shaders/emitter.glsl, but where native passes it P_rel from the
// header, this shader passes maplibre's projection columns at the anchor (the
// emitter, or the ground below the eye for weather), so it follows the map's
// projection, globe included.

import emitterFrame from "./generated/emitter.glsl.ts";
import { Header, HEADER_VEC4S, Lane, ROW_VEC4S } from "./record.ts";
import {
  mapColumns,
  vertexCore,
  vertexOutput,
  vertexVaryings,
} from "./shader-common.ts";

const params = [
  ["color", Lane.color],
  ["colorEnd", Lane.colorEnd],
  ["size", Lane.size],
  ["sizeSpin", Lane.sizeSpin],
  ["fadeAdd", Lane.fadeAdd],
  ["sparkle", Lane.sparkle],
  ["timing", Lane.timing],
  ["emission", Lane.emission],
  ["launch", Lane.launch],
  ["cone", Lane.cone],
  ["air", Lane.air],
  ["area", Lane.area],
] as const;

const paramsFromRow = params
  .map(([member, lane]) => `            P.${member} = u_row[${lane}];\n`)
  .join("");

/** Uniforms the emitter program sets besides the projection's. */
export const EMITTER_UNIFORMS = ["u_header", "u_row", "u_anchor"] as const;

/**
 * The vertex shader for one projection variant: maplibre's prelude and
 * defines first. u_anchor holds the anchor in the projection's tile (x, y in
 * tile units) and the tile units per world pixel.
 */
export function emitterVertexSource(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
${vertexCore}
${mapColumns}
${emitterFrame}
layout(location=0) in vec2 a_particle;
uniform vec4 u_header[${HEADER_VEC4S}];
uniform vec4 u_row[${ROW_VEC4S}];
uniform vec4 u_anchor;
${vertexVaryings}
void main() {
    ParticleVertex o = particleCollapsed();
    uint v = uint(a_particle.x + 0.5);
    uint r = uint(a_particle.y + 0.5);
    float4 clock = u_header[${Header.clock}];
    if (float(r) < clock.z) {
        if (v < 4u) {
            o = particleTint(u_row[${Lane.tint}], u_row[${Lane.extra}].x, float(v));
        } else {
            ParticleParams P;
${paramsFromRow}            P = particleClampParams(P);
            float4 identity = particleIdentity(P.emission.w);
            float4 view = u_header[${Header.view}];
            ParticleMapColumns m = particleMapColumns(u_anchor.xy, u_anchor.z, 1.0 / max(view.z, 1e-6));
            ParticleFrame F = particleEmitterFrame(m.X, m.Y, m.Z, m.C, u_header[${Header.screen}], view, u_header[${Header.eye}], u_row[${Lane.placement}], identity.z, identity.w);
            ParticleWeather W;
            W.eye = float4(0.0, 0.0, 0.0, 0.0);
            W.pool0 = W.eye;
            W.pool1 = W.eye;
            W.weights = W.eye;
            if (identity.w > 1.5) {
                W.eye = u_header[${Header.eye}];
                W.pool0 = u_header[${Header.pool0}];
                W.pool1 = u_header[${Header.pool1}];
                W.weights = u_header[${Header.weights}];
            }
            ParticleSeed S = particleEmitterSeed(P, float((v - 4u) >> 2u), float(v & 3u));
            o = particleVertex(P, F, W, S, clock.x);
#ifdef GLOBE
            // A point or circle emitter behind the globe is hidden with it.
            if (identity.w < 1.5 && m.C.z > m.C.w) {
                o = particleCollapsed();
            }
#endif
        }
    }
${vertexOutput}}
`;
}
