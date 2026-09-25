// Shared emitter frame of the particle plugin: where one particle-emitter
// table row's particles lie in clip space. The native emitter wrappers
// (native/src/shaders.zig) and the WebGL emitter layer
// (js/src/shaders-emitter.ts) both put it after particle.glsl, whose
// ParticleFrame it fills. Everything arrives by value, so the same text
// compiles as GLSL ES 3.00, GLSL 450 and MSL under the dialect rules in
// particle.glsl.

// The clip-space frame of an emitter row: a particle at (east, north, up) in
// its space's units lies at C + east X + north Y + up Z. p0-p3 are four
// projection columns that map world pixels east and south of an origin (y
// down), and meters up, to clip space; the row's placement and the header's
// eye are measured from that origin. Native passes P_rel, whose origin is
// the frame center; WebGL passes maplibre's projection at the anchor (the
// emitter, or the ground below the eye for weather).
ParticleFrame particleEmitterFrame(float4 p0, float4 p1, float4 p2, float4 p3, float4 screen, float4 view, float4 eye, float4 placement, float space, float kind) {
    float scale = max(placement.w, 0.0);
    ParticleFrame F;
    F.screen = screen;
    F.view = float4(view.x, view.y, scale, 1.0);
    F.X = p0 * scale;
    F.Y = -p1 * scale;
    if (kind > 1.5) {
        // Weather: pixels around the eye; up converts through the
        // camera's pixels per meter.
        F.C = p0 * eye.x + p1 * eye.y + p2 * eye.z + p3;
        F.Z = p2 * (scale / max(view.z, 1e-6));
        return F;
    }
    F.C = p0 * placement.x + p1 * placement.y + p3;
    if (space > 1.5) {
        // World: meters, scaling with the map.
        float pixelsPerMeter = placement.z * scale;
        F.X = p0 * pixelsPerMeter;
        F.Y = -p1 * pixelsPerMeter;
        F.Z = p2 * scale;
        F.view.z = pixelsPerMeter;
    } else if (space > 0.5) {
        // Ground: map-plane pixels; up is up the screen, sized at the
        // center's depth.
        F.Z = float4(0.0, -screen.y * view.x * scale, 0.0, 0.0);
    } else {
        // Screen: constant pixels in the screen plane; north is depth.
        F.X = float4(screen.x * F.C.w * scale, 0.0, 0.0, 0.0);
        F.Y = float4(0.0, 0.0, 0.0, 0.0);
        F.Z = float4(0.0, -screen.y * F.C.w * scale, 0.0, 0.0);
        F.view.w = 0.0;
    }
    return F;
}
