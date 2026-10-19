// The body of the vertex main every wrapper shares, after building.glsl and
// properties.glsl: it fills the paint, runs buildingVertex and leaves
// BuildingVertex o. The wrapper then writes, in its own dialect:
//   position  u.tile_matrix * float4(o.position, 1.0) (the WebGL 2 twin may
//             project o.position its own way, e.g. maplibre's
//             projectTileWithElevation(o.position.xy, o.position.z))
//   v_color   o.color, a smooth varying (per-vertex lighting, as core)
// and, on Vulkan, applySurfaceTransform(). The depth-only pass runs this body
// unchanged: never compile it out under MLN_PLUGIN_COLOR_WRITE, or the two
// passes can round positions differently and z-fight (see #4685's Metal
// shader). Only the fragment stage may read MLN_PLUGIN_COLOR_WRITE.

    BuildingPaint P;
    P.height = BUILDING_HEIGHT;
    P.base = BUILDING_BASE;
    P.roof_height = BUILDING_ROOF_HEIGHT;
    P.roof_angle = BUILDING_ROOF_ANGLE;
    P.color = BUILDING_COLOR;
    P.roof_color = BUILDING_ROOF_COLOR;
    P.opacity = BUILDING_OPACITY;
    P.vertical_gradient = BUILDING_VERTICAL_GRADIENT;
    BuildingVertex o = buildingVertex(BUILDING_ATTR(a_pos), BUILDING_ATTR(a_roof), P, u.light_color,
                                      u.light_position, u.meters_per_tile_unit);
