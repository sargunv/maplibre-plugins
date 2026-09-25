// Shared vertex placement for animated icons: spreads an anchor's quad over
// its animation's anchor box the way MapLibre places point-symbol icons
// (symbol_icon.vertex.glsl with the label plane and coordinate matrices of
// symbol_projection.cpp), and picks the frame the icon shows. The same
// source compiles as GLSL (OpenGL, Vulkan, WebGL2) and MSL.
//
// A host defines, before this file:
//   float2, float4      GLSL: vec2 and vec4 (MSL has them natively)
//   PROJECT(p)          the clip position of p (a float2 in tile units):
//                       `matrix * float4(p, 0.0, 1.0)` natively, and
//                       `projectTile(p)` in maplibre-gl-js, so globe works
//   ICON_PLACE_PARAM    a trailing parameter declaration, with its leading
//                       comma, for whatever PROJECT, ICON_CLOCK and
//                       ICON_ENTRY read (MSL: `, constant IconDrawableUBO& u,
//                       constant IconCatalogUBO& catalog`); empty in GLSL
//   ICON_PLACE_ARG      the matching argument (MSL: `, u, catalog`); empty in
//                       GLSL
//   ICON_CLOCK          the animation clock, seconds in [0, 4096), from the
//                       IconCatalogUBO block (`catalog.clock.x`)
//   ICON_ENTRY(i)       texel i of the block's header table
//                       (`catalog.entries[i]`): entry e, icon-animation's
//                       enum index, is the anchor box (x0, y0, x1, y1) in
//                       canvas pixels at 2e and (display_px, loop_rate,
//                       frame_count, frame_texel) at 2e + 1
//                       (../catalog/FORMAT.md, "Header block")
//   ICON_ENTRY_COUNT    the number of entries, "none" included
//
// It provides:
//   struct IconVertex { float4 position; float2 uv; float frame; };
//   IconVertex iconPlace(float2 pos, float4 icon, float4 align, float2 offset,
//                        float4 timing, float4 camera, float2 view ICON_PLACE_PARAM)
//     pos     the a_pos attribute: anchor * 2 + corner, anchor in tile units
//             and corner 0 or 1 on each axis (see the layout code)
//     icon    (icon-animation enum index, icon-size, icon-rotate in degrees,
//             icon-opacity)
//     align   (icon-anchor, icon-rotation-alignment, icon-pitch-alignment)
//             enum indices, in spec.json's value order; w unused
//     offset  icon-offset, logical pixels right and down
//     timing  (icon-animation-speed, icon-animation-offset,
//             icon-animation-mode enum index); w unused
//     camera  (pixels_to_gl_units.x, pixels_to_gl_units.y,
//             pixels_to_tile_units, camera_to_center_distance)
//     view    (pixel_ratio, bearing): the bearing in radians as MapLibre
//             Native's transform keeps it, the camera bearing negated
//   The result is the vertex's clip position, its position in canvas pixels
//   for iconShade(), and the texel of the frame record to draw. A quad whose
//   animation is none or unknown, whose size or opacity is not positive, or
//   whose anchor is behind the camera collapses outside the clip volume.
//
// Frame choice (FORMAT.md, "Timing"): the playhead is
// clock * clamp(speed, -4, 4) + offset seconds, which the entry's loop rate
// turns into loops; loop takes its fraction, alternate folds every other
// loop back, and once clamps it to [0, 1]. The frame index ends in an
// integer clamp to the entry's frames, so a NaN or infinite playhead (which
// expressions can produce, and which fast math may not preserve) still
// reads one of the entry's frame records.
//
// Placement, in logical pixels: the anchor box scales so its longer side is
// display_px * icon-size; the icon-anchor point of the box sits on the
// anchor, then icon-offset * icon-size moves it; icon-rotate turns the whole
// icon clockwise about the anchor, offset included; and the perspective
// ratio of symbol icons scales it. Then, as for point symbols:
//   pitch viewport, rotation viewport: the offset is in screen pixels.
//   pitch viewport, rotation map: the offset turns with the projected east
//     direction at the anchor, like u_rotate_symbol.
//   pitch map, rotation map: the offset is in map pixels, x east, y south.
//   pitch map, rotation viewport: the offset is in map pixels turned by the
//     bearing, which is what MapLibre's tile skew matrix reduces to without
//     camera roll.
// Rotation alignment auto is viewport, and pitch alignment auto follows the
// rotation alignment. The quad covers the box grown by one device pixel on
// the screen, so the edge anti-aliasing of shapes touching the box survives.

struct IconVertex {
    float4 position;
    float2 uv;
    float frame;
};

// The fraction of the anchor box that icon-anchor puts on the anchor, by
// enum index: center, left, right, top, bottom, top-left, top-right,
// bottom-left, bottom-right.
float2 iconAnchorFraction(float anchor) {
    int i = int(anchor + 0.5);
    float x = (i == 1 || i == 5 || i == 7) ? 0.0 : ((i == 2 || i == 6 || i == 8) ? 1.0 : 0.5);
    float y = (i == 3 || i == 5 || i == 6) ? 0.0 : ((i == 4 || i == 7 || i == 8) ? 1.0 : 0.5);
    return float2(x, y);
}

// Turns v by the angle whose cosine and sine are cs.x and cs.y, clockwise
// on a y-down plane.
float2 iconTurn(float2 v, float2 cs) {
    return float2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

IconVertex iconPlace(float2 pos, float4 icon, float4 align, float2 offset, float4 timing, float4 camera, float2 view ICON_PLACE_PARAM) {
    IconVertex result;
    result.position = float4(-2.0, -2.0, -2.0, 1.0);
    result.uv = float2(0.0);
    result.frame = 0.0;
    float2 anchor = floor(pos * 0.5);
    float2 corner = pos - anchor * 2.0;
    int index = int(icon.x + 0.5);
    float size = icon.y;
    float4 projected = PROJECT(anchor);
    if (index <= 0 || index >= ICON_ENTRY_COUNT || !(size > 0.0) || !(icon.w > 0.0) || !(projected.w > 0.0)) return result;
    float4 box = ICON_ENTRY(2 * index);
    // (display_px, loop_rate, frame_count, frame_texel)
    float4 info = ICON_ENTRY(2 * index + 1);
    // Logical pixels per canvas pixel.
    float scale = info.x * size / max(box.z - box.x, box.w - box.y);

    int rotation = int(align.y + 0.5);
    int pitch = int(align.z + 0.5);
    bool rotateWithMap = rotation == 1;
    bool pitchWithMap = pitch == 1 || (pitch == 0 && rotateWithMap);
    float cameraToCenter = camera.w;
    // Symbol icons shrink with distance less than the map does when facing
    // the camera, and grow on the ground to partly offset the foreshortening.
    float distanceRatio = pitchWithMap ? projected.w / cameraToCenter : cameraToCenter / projected.w;
    float perspective = clamp(0.5 + 0.5 * distanceRatio, 0.0, 4.0);

    // Screen pixels per logical pixel of offset, along the most compressed
    // direction, for the one-device-pixel margin.
    float onScreen = perspective;
    float4 east = PROJECT(anchor + float2(1.0, 0.0));
    if (pitchWithMap) {
        // On the ground, perspective shrinks the icon by the distance and
        // foreshortens it by the cosine of the pitch; the depth gradient
        // along the ground gives the sine.
        float4 south = PROJECT(anchor + float2(0.0, 1.0));
        float sinPitch = min(length(float2(east.w - projected.w, south.w - projected.w)) * camera.z, 1.0);
        onScreen *= cameraToCenter / projected.w * max(sqrt(1.0 - sinPitch * sinPitch), 0.05);
    }
    float pad = 1.0 / max(view.x * scale * onScreen, 1e-6);
    float2 uv = mix(box.xy - pad, box.zw + pad, corner);

    float2 o = (uv - mix(box.xy, box.zw, iconAnchorFraction(align.x))) * scale + offset * size;
    float angle = icon.z * 0.017453292519943295;
    o = iconTurn(o, float2(cos(angle), sin(angle))) * perspective;

    if (pitchWithMap) {
        if (!rotateWithMap) o = iconTurn(o, float2(cos(-view.y), sin(-view.y)));
        result.position = PROJECT(anchor + o * camera.z);
    } else {
        if (rotateWithMap) {
            // East at the anchor, in screen pixels (y down).
            float2 d = (east.xy / east.w - projected.xy / projected.w) / camera.xy;
            float len = length(d);
            if (len > 0.0) o = iconTurn(o, d / len);
        }
        result.position = projected;
        result.position.xy += o * camera.xy * projected.w;
    }
    result.uv = uv;

    // The frame, in f32 as the CPU twins compute it (frameAt in catalog.zig
    // and catalog.ts).
    float s = ICON_CLOCK * clamp(timing.x, -4.0, 4.0) + timing.y;
    float loops = s * info.y;
    int mode = int(timing.z + 0.5);
    float p = mode == 1 ? 1.0 - abs(1.0 - 2.0 * fract(loops * 0.5)) : (mode == 2 ? clamp(loops, 0.0, 1.0) : fract(loops));
    int count = int(info.z + 0.5);
    int f = clamp(int(floor(p * info.z)), 0, count - 1);
    result.frame = float(int(info.w + 0.5) + f);
    return result;
}
