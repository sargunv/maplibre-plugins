// GLSL ES 3.00 pieces both particle layers build their programs from: the
// shared model core (shaders/particle.glsl) and sprite shapes
// (shaders/shape.glsl), mirrored into generated/, behind the same type macros
// the native GL wrappers define; the varyings and fragment stage; and a
// helper that reads a particle frame's clip-space columns off maplibre's own
// projection. Vertex shaders put maplibre's prelude first, so the core can
// call projectTileWithElevation and follows the map's projection, globe
// included.

import type { CustomRenderMethodInput } from "maplibre-gl";

import particleCore from "./generated/particle.glsl.ts";
import shapes from "./generated/shape.glsl.ts";

/** The macros the shared GLSL is written against, as native/src/shaders.zig defines them. */
const types = `#define float2 vec2
#define float3 vec3
#define float4 vec4
#define float4x4 mat4
#define uint3 uvec3
#define PARTICLE_ATAN2(y, x) atan(y, x)
`;

/** The vertex-stage core: type macros, WebGL's near plane, then particle.glsl. */
export const vertexCore = `${types}#define PARTICLE_Z_NEAR (-1.0)
${particleCore}
`;

/**
 * The varyings, declared as the native wrappers do: quad coordinates
 * interpolate, while color and look are the same at every corner.
 */
export const vertexVaryings = `out vec4 v_uv;
flat out vec4 v_color;
flat out vec4 v_look;
`;

/** Writes a ParticleVertex `o` to the stage outputs. */
export const vertexOutput = `    gl_Position = o.position;
    v_uv = o.uv;
    v_color = o.color;
    v_look = o.look;
`;

/**
 * The clip-space columns of maplibre's projection at a point of the tile its
 * projection uniforms describe: a point `east` and `south` world pixels and
 * `up` meters from it projects to C + east X + south Y + up Z, the column
 * layout of the native table's P_rel. projectTileWithElevation is linear on
 * Mercator, so there the central differences are exact; on the globe they
 * span the tangent plane at the point.
 */
export const mapColumns = `// Clip-space columns of the map projection at a tile point (tile units):
// clip = C + east px * X + south px * Y + up m * Z.
struct ParticleMapColumns {
    vec4 C;
    vec4 X;
    vec4 Y;
    vec4 Z;
};

// unitsPerPixel converts world pixels to tile units; metersPerPixel sizes
// the vertical step. The steps span 64 world pixels: long enough for f32
// clip coordinates, short enough to follow the globe's curvature.
ParticleMapColumns particleMapColumns(vec2 point, float unitsPerPixel, float metersPerPixel) {
    vec2 dx = vec2(64.0 * unitsPerPixel, 0.0);
    vec2 dy = vec2(0.0, 64.0 * unitsPerPixel);
    float up = 64.0 * metersPerPixel;
    ParticleMapColumns m;
    m.C = projectTileWithElevation(point, 0.0);
    m.X = (projectTileWithElevation(point + dx, 0.0) - projectTileWithElevation(point - dx, 0.0)) * (1.0 / 128.0);
    m.Y = (projectTileWithElevation(point + dy, 0.0) - projectTileWithElevation(point - dy, 0.0)) * (1.0 / 128.0);
    m.Z = (projectTileWithElevation(point, up) - m.C) / up;
    return m;
}
`;

/** The fragment stage both layers share: shape.glsl's sprites and tint, premultiplied. */
export const fragmentSource = `#version 300 es
precision highp float;
${types}${shapes}
in vec4 v_uv;
flat in vec4 v_color;
flat in vec4 v_look;
out vec4 fragColor;
void main() {
    fragColor = particleFragment(v_uv, v_color, v_look);
}
`;

/** Projection uniforms maplibre's prelude declares; absent ones resolve to null and are skipped. */
export const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;

export type ProjectionUniform = (typeof PROJECTION_UNIFORMS)[number];

export type ProjectionData = ReturnType<
  CustomRenderMethodInput["getProjectionData"]
>;

/** Sets the projection uniforms of one tile's projection data. */
export function setProjectionUniforms(
  gl: WebGL2RenderingContext,
  uniforms: Partial<Record<ProjectionUniform, WebGLUniformLocation | null>>,
  projection: ProjectionData,
): void {
  const u = uniforms;
  if (u.u_projection_matrix)
    gl.uniformMatrix4fv(u.u_projection_matrix, false, projection.mainMatrix);
  if (u.u_projection_fallback_matrix) {
    gl.uniformMatrix4fv(
      u.u_projection_fallback_matrix,
      false,
      projection.fallbackMatrix,
    );
  }
  if (u.u_projection_tile_mercator_coords) {
    gl.uniform4fv(
      u.u_projection_tile_mercator_coords,
      projection.tileMercatorCoords,
    );
  }
  if (u.u_projection_clipping_plane)
    gl.uniform4fv(u.u_projection_clipping_plane, projection.clippingPlane);
  if (u.u_projection_transition)
    gl.uniform1f(u.u_projection_transition, projection.projectionTransition);
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`${label}: cannot create shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`${label} shader compile failed: ${log}`);
  }
  return shader;
}

/** Compiles and links a program. Throws with the driver's log on failure; `label` names the layer type. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragment: string,
  label: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, label);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragment, label);
  } catch (error) {
    gl.deleteShader(vertex);
    throw error;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`${label} program link failed: ${log}`);
  }
  return program;
}
