// Shared vertex-stage core of the building layer: where a vertex of the
// layout (../README.md, "Vertex contract") goes and how it is lit. Lighting
// is core fill-extrusion's, computed per vertex as core does, plus roofs.
// The same source compiles as GLSL ES 3.00 (OpenGL, WebGL 2), GLSL 450
// (Vulkan) and MSL (Metal, fast-math). Each wrapper defines before it:
//   float2, float3, float4, float4x4   GLSL: vec2, vec3, vec4, mat4 (MSL native)
// and then, from its vertex main, fills a BuildingPaint (properties.glsl and
// vertex.glsl do that) and calls buildingVertex. The wrapper projects the
// returned position with its own tile matrix, so the core does not depend on
// a projection.
//
// Dialect rules, so every backend compiles the same text:
//   - no `mod`, `round`, `inversesqrt`, `radians`, `pow`, out/inout
//     parameters, global `const`, or implicit int-to-float conversion;
//   - no host prelude names (`PI`, `glMod`, `interpolationFactor`), and no
//     GLSL reserved words (`active`, `sample`, `input`, `output`, `filter`);
//   - structs are declared as `T x;` and filled member by member, and passed
//     by value; vector constructors are fine;
//   - every division and normalize is guarded (Metal compiles with
//     fast-math).
//
// Kinds (a_roof.y): 0 wall bottom, 1 wall top, 2 roof, 3 roof underside.
// They are compared against x.5 thresholds, never with ==.

#define BUILDING_DEG_TO_RAD 0.017453292519943295
// building-roof-angle's spec maximum. The host does not clamp data-driven
// values, so the shader does.
#define BUILDING_MAX_ROOF_ANGLE 89.0

// The paint values for one vertex, after the host's binding: a uniform, or the
// feature's attribute mixed by its interpolation factor. Colors are
// premultiplied, as the host and the JS paint package evaluate them.
struct BuildingPaint {
    float height;
    float base;
    float roof_height;
    float roof_angle;
    float4 color;
    float4 roof_color;
    float opacity;
    float vertical_gradient;
};

// What buildingVertex returns: the position in tile units (x, y) and meters
// (z), for the wrapper's tile matrix, and the lit premultiplied color.
struct BuildingVertex {
    float3 position;
    float4 color;
};

// The height of the roof from the eaves to the ridge, in meters: roof-angle
// over the vertex's run when it is above 0, else roof-height, clamped to fit
// between base and height. run is in tile units (a_pos.z), and
// meters_per_tile_unit converts it (../README.md, "Tile units and meters").
float buildingRoofHeight(BuildingPaint P, float height, float base, float run, float meters_per_tile_unit) {
    float roof_height = P.roof_height;
    float angle = clamp(P.roof_angle, 0.0, BUILDING_MAX_ROOF_ANGLE);
    if (angle > 0.0) {
        roof_height = tan(angle * BUILDING_DEG_TO_RAD) * run * meters_per_tile_unit;
    }
    return clamp(roof_height, 0.0, max(height - base, 0.0));
}

// Core fill-extrusion's lighting (MapLibre Native's fill_extrusion.vertex.glsl)
// for one vertex, before opacity.
//   color           premultiplied surface color; its alpha is ignored, as in core
//   normal          unit outward normal in tile coordinates (x right, y down,
//                   z up)
//   wall            whether the vertex is on a wall, which takes the vertical
//                   gradient (core: normal.z == 0)
//   t               0 at a wall bottom, 1 at a wall top
//   base, height    building-base and building-height, clamped at 0
//   light_color     rgb light color, a = intensity
//   light_position  core's u_lightpos: the style light's Cartesian position,
//                   rotated by the bearing for a viewport anchor
// Core lights its walls with an inward normal against u_lightpos and its roofs
// with (0, 0, 1). Dotting the true outward normal with u_lightpos mirrored in
// x and y is the same thing for both, and extends to sloped roofs.
float4 buildingLight(float4 color, float3 normal, bool wall, float t, float base, float height,
                     float4 light_color, float4 light_position, float vertical_gradient) {
    float intensity = light_color.w;
    float3 to_light = float3(-light_position.x, -light_position.y, light_position.z);
    // Relative luminance, then core's ambient term.
    float luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    float3 surface = color.rgb + float3(0.03, 0.03, 0.03);
    float directional = clamp(dot(normal, to_light), 0.0, 1.0);
    directional = mix(1.0 - intensity, max(1.0 - luminance + intensity, 1.0), directional);
    if (wall) {
        // Core writes pow(height / 150.0, 0.5); sqrt is the same and safe
        // under fast-math at 0.
        float low = mix(0.7, 0.98, 1.0 - intensity);
        float factor = clamp((t + base) * sqrt(height / 150.0), low, 1.0);
        directional *= (1.0 - vertical_gradient) + vertical_gradient * factor;
    }
    float3 minimum = mix(float3(0.0, 0.0, 0.0), float3(0.3, 0.3, 0.3), float3(1.0, 1.0, 1.0) - light_color.rgb);
    return float4(clamp(surface * directional * light_color.rgb, minimum, float3(1.0, 1.0, 1.0)), 1.0);
}

// One vertex of the building layout.
//   pos   a_pos = (x, y, run): tile units
//   roof  a_roof = (n, kind, gx, gy)
// Heights: height and base clamp at 0 (core). wallTop = max(base, height -
// roofHeight), and z = base at a wall bottom, else wallTop + n x roofHeight.
// Walls take building-color and the outward normal (gx, gy, 0). Roofs take
// building-roof-color and the normal of z over the tile plane, with z in tile
// units: normalize(-rise gx, -rise gy, 1), rise = roofHeight / meters per
// tile unit; undersides take its opposite. Flat roofs (gx = gy = 0) get
// (0, 0, 1), as core's do.
BuildingVertex buildingVertex(float3 pos, float4 roof, BuildingPaint P, float4 light_color, float4 light_position,
                              float meters_per_tile_unit) {
    float height = max(P.height, 0.0);
    float base = max(P.base, 0.0);
    float roof_height = buildingRoofHeight(P, height, base, pos.z, meters_per_tile_unit);
    float wall_top = max(base, height - roof_height);
    float n = roof.x;
    float kind = roof.y;
    bool wall = kind < 1.5;
    float z = kind < 0.5 ? base : wall_top + n * roof_height;
    float3 normal = float3(roof.z, roof.w, 0.0);
    float4 color = P.color;
    if (!wall) {
        float rise = meters_per_tile_unit > 0.0 ? roof_height / meters_per_tile_unit : 0.0;
        // The z component is 1, so the length is at least 1.
        normal = normalize(float3(-rise * roof.z, -rise * roof.w, 1.0));
        if (kind > 2.5) normal = -normal;
        color = P.roof_color;
    }
    float t = kind < 0.5 ? 0.0 : 1.0;
    BuildingVertex o;
    o.position = float3(pos.x, pos.y, z);
    o.color = buildingLight(color, normal, wall, t, base, height, light_color, light_position, P.vertical_gradient) *
              P.opacity;
    return o;
}
