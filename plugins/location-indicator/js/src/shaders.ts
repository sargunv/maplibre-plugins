// GLSL ES 3.00 sources around the shared shade() function. The vertex shader
// projects tile-local positions through MapLibre's projectTile prelude, so the
// layer follows the map's projection, including globe.

import shade from "./generated/puck.glsl.ts";

export const ATTRIBUTES = [
  "a_pos",
  "a_point",
  "a_style",
  "a_fill",
  "a_border",
] as const;

export function vertexSource(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_point;
layout(location=2) in vec4 a_style;
layout(location=3) in vec4 a_fill;
layout(location=4) in vec4 a_border;
out vec2 v_point;
out vec4 v_style;
out vec4 v_fill;
out vec4 v_border;
void main() {
    v_point = a_point;
    v_style = a_style;
    v_fill = a_fill;
    v_border = a_border;
    gl_Position = projectTile(a_pos);
}
`;
}

export const fragmentSource = `#version 300 es
precision highp float;
#define float2 vec2
#define float4 vec4
#define DX dFdx
#define DY dFdy
#define ATAN atan
in vec2 v_point;
in vec4 v_style;
in vec4 v_fill;
in vec4 v_border;
out vec4 fragColor;
${shade}
void main() {
    fragColor = shade(v_point, v_style, v_fill, v_border);
}
`;

/** Projection uniforms the prelude declares; absent ones resolve to null and are skipped. */
export const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;
