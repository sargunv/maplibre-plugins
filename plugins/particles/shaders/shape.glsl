// Shared fragment function of the particle plugin: the procedural sprite
// shapes and the emitter-screen-tint vignette. The same source compiles as
// GLSL ES 3.00, GLSL 450 and MSL under the dialect rules in particle.glsl;
// each wrapper defines float2, float3 and float4 before it (MSL has them
// natively), and the GL wrappers declare `precision highp float` first. In
// MSL it shares one unit with particle.glsl, so its names never repeat one
// from there; on GL it is compiled alone, so it needs none of that file's
// definitions.
//
// uv     quad coordinates: (along / h, across / h, stretched length / h, aa);
//        a sprite spans [-1, 1] on both axes, a stretched one runs from the
//        tail (x = 0) to the head (x = length / h) with h of margin around;
//        aa is 2 / diameter in physical px, one pixel in uv units
// color  premultiplied color, already faded, twinkled and blended toward
//        additive (alpha 0 adds light under premultiplied-over blending)
// look   (shape, vignette, seed, 0); shape 100 is the full-screen tint quad,
//        where uv.xy is the NDC position
//
// Shapes by index (particle-shape): 0 circle, 1 glow, 2 star, 3 spark,
// 4 streak, 5 flake, 6 ring, 7 ripple, 8 smoke, 9 square. Stretched circle,
// glow, ring and smoke use the distance to the tail-head segment; star, flake
// and square fall back to a capsule.
//
// Returns premultiplied color. Anti-aliasing comes from aa, except that a
// ripple lies on the ground, so under pitch its pixel size comes from
// fwidth(r), taken before any branch so it runs in uniform control flow.
// js/src/model.test.ts compiles this file for the CPU and rasterizes sprites
// with it.

// S(x) = x^2 (3 - 2x) on clamp(x, 0, 1).
float particleShapeSmooth(float x) {
    float c = clamp(x, 0.0, 1.0);
    return c * c * (3.0 - 2.0 * c);
}

// Coverage of a signed distance d (negative inside) with a one-pixel edge.
float particleShapeEdge(float d, float aa) {
    return clamp(0.5 - d / aa, 0.0, 1.0);
}

// Hash without sine (Hoskins): a float in [0, 1) from a lattice point. Float
// only, so it stays exact at the GL fragment stage's precision.
float particleShapeHash(float2 p) {
    float3 q = fract(float3(p.x, p.y, p.x) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

// Value noise in [0, 1) with a smooth fade.
float particleShapeNoise(float2 p) {
    float2 i = floor(p);
    float2 f = p - i;
    float2 w = f * f * (3.0 - 2.0 * f);
    float a = particleShapeHash(i);
    float b = particleShapeHash(i + float2(1.0, 0.0));
    float c = particleShapeHash(i + float2(0.0, 1.0));
    float d = particleShapeHash(i + float2(1.0, 1.0));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

float4 particleFragment(float4 uv, float4 color, float4 look) {
    float shape = floor(look.x + 0.5);
    float2 p = uv.xy;
    float aa = max(uv.w, 0.0001);
    float span = max(uv.z, 0.0);
    bool stretched = span > 0.0;
    // Position along the tail-head segment (0 tail, 1 head) and the distance
    // to it; for a sprite (span 0) that is just the radius.
    float t = stretched ? clamp(p.x / span, 0.0, 1.0) : 1.0;
    float r = length(float2(p.x - clamp(p.x, 0.0, span), p.y));
    // One pixel of r, measured on screen.
    float rPixel = fwidth(r);
    if (shape > 99.5) {
        // Screen tint: even, or only toward the edges as vignette grows.
        float edge = particleShapeSmooth((length(p) - 0.35) * (1.0 / 0.9));
        return color * (1.0 - clamp(look.y, 0.0, 1.0) * (1.0 - edge));
    }
    float capsule = particleShapeEdge(r - 0.8, aa);
    float coverage = capsule;
    if (shape < 0.5) {
        // circle: the capsule
    } else if (shape < 1.5) {
        // glow
        coverage = exp(-3.0 * r * r) * (1.0 - particleShapeSmooth((r - 0.7) * (1.0 / 0.3)));
    } else if (shape < 2.5) {
        // star: a soft core and four thin rays
        if (!stretched) {
            float width = max(0.07, 0.5 * aa);
            float rayX = exp(-(p.y * p.y) / (width * width)) * (1.0 - min(abs(p.x), 1.0)) * (1.0 - min(abs(p.x), 1.0));
            float rayY = exp(-(p.x * p.x) / (width * width)) * (1.0 - min(abs(p.y), 1.0)) * (1.0 - min(abs(p.y), 1.0));
            coverage = max(exp(-10.0 * r * r), max(rayX, rayY));
        }
    } else if (shape < 3.5) {
        // spark: a capsule tapering toward the tail, brightest at the head,
        // with a small cross glint on the head
        float body = particleShapeEdge(r - mix(0.3, 0.8, t), aa) * mix(0.35, 1.0, t);
        float2 g = p - float2(span, 0.0);
        float glint = exp(-60.0 * g.y * g.y) * max(1.0 - abs(g.x), 0.0) + exp(-60.0 * g.x * g.x) * max(1.0 - abs(g.y), 0.0);
        coverage = max(body, 0.9 * glint);
    } else if (shape < 4.5) {
        // streak: a capsule whose alpha ramps up from the tail to the head
        coverage = capsule * mix(0.15, 1.0, t);
    } else if (shape < 5.5) {
        // flake: three arms at 0, 60 and 120 degrees and a soft core
        if (!stretched) {
            float2 d1 = float2(0.5, 0.8660254);
            float2 d2 = float2(-0.5, 0.8660254);
            float a0 = length(p - float2(clamp(p.x, -0.85, 0.85), 0.0));
            float a1 = length(p - d1 * clamp(dot(p, d1), -0.85, 0.85));
            float a2 = length(p - d2 * clamp(dot(p, d2), -0.85, 0.85));
            coverage = max(particleShapeEdge(min(min(a0, a1), a2) - 0.08, aa), exp(-14.0 * r * r));
        }
    } else if (shape < 6.5) {
        // ring: a bubble with a faint film and a highlight
        float ring = particleShapeEdge(abs(r - 0.7) - 0.12, aa);
        float film = 0.12 * (1.0 - particleShapeSmooth((r - 0.55) * 5.0));
        float2 h = p - float2(-0.3, -0.3);
        float highlight = stretched ? 0.0 : 0.8 * exp(-40.0 * dot(h, h));
        coverage = max(ring, highlight) + film;
    } else if (shape < 7.5) {
        // ripple: a thin ring with a fainter inner echo. aa is one pixel
        // along the quad's major axis; across a pitched view the ground
        // foreshortens a pixel to more of the radius. A band thinner than a
        // pixel widens to a one-pixel tent of the same area, which pixel
        // centers sample evenly wherever the band falls between them.
        float ra = max(aa, rPixel);
        float w0 = max(0.05, 0.5 * ra);
        float w1 = max(0.04, 0.5 * ra);
        coverage = particleShapeEdge(abs(r - 0.8) - w0, ra) * (0.05 / w0) + 0.5 * particleShapeEdge(abs(r - 0.5) - w1, ra) * (0.04 / w1);
    } else if (shape < 8.5) {
        // smoke: a soft blob whose edge wobbles with two octaves of noise
        float seed = look.z * 61.7;
        float n = 0.65 * particleShapeNoise(p * 2.3 + float2(seed, 0.73 * seed)) + 0.35 * particleShapeNoise(p * 4.9 + float2(1.31 * seed, 0.29 * seed + 7.0));
        coverage = particleShapeSmooth((0.5 + 0.4 * n - r) * (1.0 / 0.35)) * (0.55 + 0.45 * n);
    } else {
        // square, turned by the sprite's spin
        if (!stretched) {
            coverage = particleShapeEdge(max(abs(p.x), abs(p.y)) - 0.75, aa);
        }
    }
    return color * clamp(coverage, 0.0, 1.0);
}
