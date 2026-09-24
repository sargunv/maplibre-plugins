// Shared fragment function for the animated shoreline. The same source
// compiles as GLSL (OpenGL, Vulkan, WebGL) and MSL; each host defines float2
// and float4 before including it (MSL has them natively).
//
// The band mesh (see the layout code) runs from the shoreline (dist 0) into
// the water (dist 1, `wave.x` logical pixels away). Everything is drawn
// analytically from that distance and the tile-local position:
//   - a shallow-water tint that fades out across the band;
//   - `wave.y` breaking crests travelling toward the shore, each a crisp front
//     with foam trailing behind it, wobbled and broken up by value noise;
//   - a bubbling wash at the shoreline, from cellular noise.
//
// Noise lattices repeat exactly `extent` tile units apart, so neighbouring
// tiles at one zoom share a seamless pattern.
//
// pos       tile-local position after extrusion (tile units)
// owner     the shoreline point this fragment was extruded from; a fragment
//           belongs to the tile that holds its shoreline point, so bands
//           reaching across a tile edge are drawn once and without gaps
// dist      0 at the shoreline, 1 at the inner edge of the band
// shore     premultiplied shallow-water tint
// foam      premultiplied crest and wash color
// wave      (band width in logical pixels, crest count, crests per second, wobble 0..1)
// params    (foam length 0..1, wash strength 0..1, opacity, tile extent)
// time      seconds; only advances the picture through wave.z

float shoreHash(float2 cell) {
    return fract(sin(dot(cell, float2(127.1, 311.7))) * 43758.5453123);
}

// Wraps a lattice cell so the noise tiles with `period` cells.
float2 shoreWrap(float2 cell, float period) {
    return cell - floor(cell / period) * period;
}

// Periodic value noise with a quintic fade; `period` cells per tile.
float shoreNoise(float2 p, float period) {
    float2 i = floor(p);
    float2 f = p - i;
    float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = shoreHash(shoreWrap(i, period));
    float b = shoreHash(shoreWrap(i + float2(1.0, 0.0), period));
    float c = shoreHash(shoreWrap(i + float2(0.0, 1.0), period));
    float d = shoreHash(shoreWrap(i + float2(1.0, 1.0), period));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Periodic cellular noise: distance to the nearest of one drifting feature
// point per cell. Returns 0 at the points and up to about 1 between them.
float shoreCells(float2 p, float period, float t) {
    float2 i = floor(p);
    float2 f = p - i;
    float best = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            float2 g = float2(float(x), float(y));
            float2 cell = shoreWrap(i + g, period);
            float h = shoreHash(cell);
            float k = shoreHash(cell + float2(17.0, 43.0));
            float2 o = float2(0.5, 0.5) + 0.35 * float2(sin(t + 6.2831853 * h), cos(t + 6.2831853 * k));
            float2 r = g + o - f;
            best = min(best, dot(r, r));
        }
    }
    return sqrt(best);
}

float4 shoreShade(float2 pos, float2 owner, float dist, float4 shore, float4 foam, float4 wave, float4 params, float time) {
    float extent = params.w;
    // Half-open tile ownership of the shoreline point, so the buffered
    // copies in neighbouring tiles never double up.
    float inside = step(0.0, owner.x) * step(0.0, owner.y) * step(owner.x, extent - 0.001) * step(owner.y, extent - 0.001);
    float t = time * wave.z;
    float wobble = wave.w;
    // Lattices: 16, 32 and 96 cells per tile, all exact divisors of the tile.
    float2 q = pos / extent;
    float n1 = shoreNoise(q * 16.0 + float2(0.0, t * 0.12), 16.0) * 2.0 - 1.0;
    float n2 = shoreNoise(q * 32.0 + float2(t * 0.08, 0.0), 32.0);

    // Crests: spacing tightens toward the shore (shoaling), and the wobble
    // shifts each crest along the band by up to a third of the spacing.
    float shoaled = dist * (0.7 + 0.3 * dist);
    float phase = shoaled * wave.y + t + wobble * 0.35 * n1;
    float c = fract(phase);
    float aa = max(fwidth(phase), 0.0001);
    // Each crest is a crisp ridge about two pixels wide with foam trailing
    // behind it (toward open water) over params.x of the crest spacing.
    float ridge = smoothstep(0.0, aa, c) * (1.0 - smoothstep(1.5 * aa, 3.5 * aa, c));
    float trailLength = max(params.x * (1.4 - 0.8 * dist), 3.0 * aa);
    float trail = smoothstep(0.0, aa, c) * pow(1.0 - smoothstep(0.0, trailLength, c), 2.0);
    float crest = max(ridge, 0.55 * trail);
    // Wobble also breaks the lines into patches along the shore.
    crest *= mix(1.0, smoothstep(0.25, 0.65, n2), wobble);
    // Crests are strongest near the shore and fade out toward open water.
    crest *= pow(max(1.0 - dist, 0.0), 1.2);
    if (wave.y <= 0.0) crest = 0.0;

    // Wash: a bright, bubbling strip hugging the shoreline.
    float px = dist * wave.x;
    float reach = max(0.16 * wave.x, 3.0) * (1.0 + 0.25 * n1);
    float cells = shoreCells(q * 96.0 + float2(t * 0.3, -t * 0.2), 96.0, t * 2.0);
    float bubbles = smoothstep(0.15, 0.55, cells);
    float wash = params.y * exp(-px / reach) * (0.55 + 0.45 * bubbles) * (0.85 + 0.15 * sin(6.2831853 * (t * 0.5 + 0.3 * n1)));

    float4 tint = shore * pow(max(1.0 - dist, 0.0), 2.2) * (0.9 + 0.1 * n2);
    float coverage = clamp(crest + wash, 0.0, 1.0);
    float4 color = foam * coverage + tint * (1.0 - coverage * foam.a);
    float edge = 1.0 - smoothstep(0.9, 1.0, dist);
    return color * (params.z * inside * edge);
}
