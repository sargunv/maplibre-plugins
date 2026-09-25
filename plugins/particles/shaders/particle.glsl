// Shared vertex-stage core of the particle plugin: one stateless particle
// model for both layer types (particle-emitter and particle-features) and both
// implementations. The same source compiles as GLSL ES 3.00 (OpenGL, WebGL 2),
// GLSL 450 (Vulkan) and MSL (Metal, fast-math). Each wrapper defines before it:
//   float2, float3, float4, uint3   GLSL: vec2, vec3, vec4, uvec3 (MSL native)
//   PARTICLE_ATAN2(y, x)            GLSL: atan(y, x); MSL: atan2(y, x)
//   PARTICLE_Z_NEAR                 near-plane clip z: -1.0 on OpenGL and WebGL,
//                                   0.0 on Vulkan and Metal
// and then, from its own main, builds the particle's identity with
// particleEmitterSeed or particleFeatureSeed and calls particleVertex (or
// particleTint for the emitter's screen-tint quad). In MSL this file comes
// before the vertex function, in the same unit as shape.glsl, so every name
// here starts with `particle`/`Particle` and none is shared with shape.glsl.
//
// Dialect rules, so every backend compiles the same text:
//   - no `mod`, `round`, `inversesqrt`, `isnan`, out/inout parameters, global
//     `const`, implicit int-to-float conversion, or signed `%`/`>>`;
//   - no `PI`, `radians`, `glMod`, `interpolationFactor` or `SDF_PX` (host
//     prelude names), and no GLSL reserved words such as `active` or `sample`;
//   - structs are declared as `T x;` and filled member by member (no
//     constructors or aggregate initializers), and passed by value;
//   - loops have constant bounds; hashing is uint-only;
//   - large offsets arrive precomputed in f64 on the CPU, and every division,
//     sqrt and normalize is guarded (Metal compiles with fast-math).
//
// Time is the plugin clock modulo PARTICLE_W seconds. Every position is a
// closed-form function of (identity, cycle, age), so nothing is stored per
// particle. js/src/model.ts is a line-by-line TypeScript port of this file,
// and fixtures/model.json holds its outputs; js/src/model.test.ts compiles
// this file for the CPU (the dialect above, nothing more) and checks it
// against them in f64 and f32. Change both together.

#define PARTICLE_TAU 6.283185307179586
#define PARTICLE_W 4096.0
// The smallest sprite diameter and capsule width a quad is drawn at, in
// physical px (see the sizing in particleVertex).
#define PARTICLE_SPRITE_FLOOR 4.0
#define PARTICLE_STRETCHED_FLOOR 2.0

// Shader-side clamps, the single source of truth for the literals in
// particleClampParams (`-` means unbounded). One pair per float, two pairs
// per float2 in component order. The JS spec test checks them against
// spec.json's float bounds and float2 component clamps.
// @clamp particle-count 0 16384
// @clamp particle-density 0 100
// @clamp emitter-radius 0 -
// @clamp particle-scale 0 -
// @clamp emitter-height -10000 10000 -10000 10000
// @clamp particle-lifetime 0.05 600 0.05 600
// @clamp particle-explosiveness 0 1
// @clamp particle-burst-interval 0 600 0 1
// @clamp particle-burst-groups 1 16
// @clamp particle-seed 0 65535
// @clamp particle-speed 0 100000 0 100000
// @clamp particle-direction - - -90 90
// @clamp particle-spread 0 180 0 1
// @clamp particle-drag 0 50
// @clamp particle-wander 0 100000 0 30
// @clamp particle-spin -3600 3600 -3600 3600
// @clamp particle-size 0 10000 0 10000
// @clamp particle-growth 0 16
// @clamp particle-size-clamp 0 4096 0 4096
// @clamp particle-stretch 0 2
// @clamp particle-color-variation 0 180 0 180
// @clamp particle-fade 0 1 0 1
// @clamp particle-additive 0 1 0 1
// @clamp particle-twinkle 0 1 0 60
// @clamp emitter-center-thinning 0 1

// The paint parameters of one effect: lanes 1-12 of an emitter row, raw spec
// units. Colors are premultiplied, with particle-opacity folded in.
struct ParticleParams {
    float4 color;     // premultiplied particle-color
    float4 colorEnd;  // premultiplied end color, already painted over color
    float4 size;      // size.min, size.max, growth, stretch
    float4 sizeSpin;  // size-clamp.min, size-clamp.max, spin.min, spin.max
    float4 fadeAdd;   // fade.in, fade.out, additive.start, additive.end
    float4 sparkle;   // twinkle.amount, twinkle.hz, color-variation.particle, color-variation.burst
    float4 timing;    // lifetime.min, lifetime.max, burst-interval.seconds, burst-interval.jitter
    float4 emission;  // count, explosiveness, burst-groups, identity
    float4 launch;    // speed.min, speed.max, direction.azimuth, direction.elevation
    float4 cone;      // spread.angle, spread.flatness, gravity, drag
    float4 air;       // wind.east, wind.north, wander.amplitude, wander.hz
    float4 area;      // emitter-radius, emitter-height.min, emitter-height.max, emitter-center-thinning
};

// Clip-space frame of one effect: head = C + east * X + north * Y + up * Z.
struct ParticleFrame {
    float4 C;
    float4 X;
    float4 Y;
    float4 Z;
    float4 screen;  // pixels_to_gl_units.xy, viewport width, height
    float4 view;    // camera-to-center distance, pixel ratio, size unit, perspective (0 or 1)
};

// The camera's weather volume: two octave pools. Zero unless the emitter is
// weather.
struct ParticleWeather {
    float4 eye;      // eye x, y (world px from the frame center), eye z (m), box size (px)
    float4 pool0;    // phase east, north, up in [0, 1), scale
    float4 pool1;    // phase east, north, up in [0, 1), scale
    float4 weights;  // pool 0 weight, pool 1 weight, eye altitude (px), 0
};

// One particle vertex's identity, supplied by the wrapper.
struct ParticleSeed {
    uint key;
    uint group;
    float index;   // emitter pool index i; feature slot rank
    float corner;  // 0..3
    float kind;    // 0 point, 1 circle, 2 weather, 3 feature point, 4 feature line, 5 feature polygon
    float keep;    // wrapper cull weight (features keep); 1 on the emitter (the core applies the count prefix)
    float4 extent; // line: (halfLen px, tangent azimuth rad, 0, 0); polygon: (halfCell px, 0, 0, 0)
};

// Vertex stage output: clip position and the three varyings.
struct ParticleVertex {
    float4 position;
    float4 uv;     // quad coordinates for shape.glsl
    float4 color;  // premultiplied
    float4 look;   // shape (100 for the tint quad), vignette, seed, 0
};

// pcg3d (Jarzynski and Olano, JCGT 2020): three well-mixed uints from three.
uint3 particleHash(uint3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> 16u);
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

// The top 24 bits of a hash as a float in [0, 1), exact.
float particleUnit(uint h) {
    return float(h >> 8u) * (1.0 / 16777216.0);
}

// The k-th term of the golden-ratio Weyl sequence in [0, 1), exact integer
// arithmetic.
float particleWeyl(uint k) {
    return particleUnit(k * 0x9E3779B9u);
}

// Clamps every lane to the @clamp literals above. Expressions can evaluate
// outside spec bounds and float2 values are never validated by the host, so
// the model only ever sees in-range values. particle-scale and
// particle-density live outside ParticleParams and are clamped where they are
// read.
ParticleParams particleClampParams(ParticleParams p) {
    p.size = clamp(p.size, float4(0.0, 0.0, 0.0, 0.0), float4(10000.0, 10000.0, 16.0, 2.0));
    p.sizeSpin = clamp(p.sizeSpin, float4(0.0, 0.0, -3600.0, -3600.0), float4(4096.0, 4096.0, 3600.0, 3600.0));
    p.fadeAdd = clamp(p.fadeAdd, float4(0.0, 0.0, 0.0, 0.0), float4(1.0, 1.0, 1.0, 1.0));
    p.sparkle = clamp(p.sparkle, float4(0.0, 0.0, 0.0, 0.0), float4(1.0, 60.0, 180.0, 180.0));
    p.timing = clamp(p.timing, float4(0.05, 0.05, 0.0, 0.0), float4(600.0, 600.0, 600.0, 1.0));
    p.emission.xyz = clamp(p.emission.xyz, float3(0.0, 0.0, 1.0), float3(16384.0, 1.0, 16.0));
    // The identity packs seed + 65536 * (shape + 16 * space + 64 * kind); the
    // seed part is an integer in [0, 65535] even while the host eases it.
    float particleClass = floor(p.emission.w * (1.0 / 65536.0));
    p.emission.w = 65536.0 * particleClass + clamp(floor(p.emission.w - 65536.0 * particleClass), 0.0, 65535.0);
    p.launch.xy = clamp(p.launch.xy, float2(0.0, 0.0), float2(100000.0, 100000.0));
    p.launch.w = clamp(p.launch.w, -90.0, 90.0);
    p.cone.xy = clamp(p.cone.xy, float2(0.0, 0.0), float2(180.0, 1.0));
    p.cone.w = clamp(p.cone.w, 0.0, 50.0);
    p.air.zw = clamp(p.air.zw, float2(0.0, 0.0), float2(100000.0, 30.0));
    p.area.x = max(p.area.x, 0.0);
    p.area.yzw = clamp(p.area.yzw, float3(-10000.0, -10000.0, 0.0), float3(10000.0, 10000.0, 1.0));
    return p;
}

// S(x) = x^2 (3 - 2x) on clamp(x, 0, 1): smoothstep without the undefined
// equal-edge case.
float particleSmooth(float x) {
    float c = clamp(x, 0.0, 1.0);
    return c * c * (3.0 - 2.0 * c);
}

// Unpacks the identity lane into (seed, shape, space, kind), each clamped to
// its range (an expression can still yield an out-of-range enum index). kind
// is the row's: 0 point, 1 circle, 2 weather, 3 features.
float4 particleIdentity(float identity) {
    float upper = floor(identity * (1.0 / 65536.0));
    float seed = identity - 65536.0 * upper;
    float kind = floor(upper * (1.0 / 64.0));
    float rest = upper - 64.0 * kind;
    float space = floor(rest * (1.0 / 16.0));
    float shape = rest - 16.0 * space;
    return float4(clamp(floor(seed), 0.0, 65535.0), clamp(shape, 0.0, 9.0), clamp(space, 0.0, 2.0), clamp(kind, 0.0, 3.0));
}

// How much of the particle at `rank` shows when `target` of `count` should
// (the count prefix). A linear ramp count/8 ranks wide centered on target, so
// count changes and the weather octave crossfade fade particles instead of
// popping them; past half a ramp the shares add up to target. The gate takes
// the ramp to 0 with the target: at count <= 8 the prefix is
// clamp(target - rank, 0, 1) * clamp(2 target, 0, 1). The ramp reaches rank
// target - 0.5 + max(0.5, count/16), past the target, so a pool draws every
// particle that shows only with ceil(count - 0.5 + max(0.5, count/16)) ranks
// (prefixRanks in js/src/record.ts and native/src/record.zig, which size the
// emitter pools from it).
float particlePrefix(float target, float rank, float count) {
    float ramp = max(1.0, 0.125 * count);
    return clamp((target - rank - 0.5) / ramp + 0.5, 0.0, 1.0) * clamp(2.0 * target / ramp, 0.0, 1.0);
}

// Share of a feature's particle slot that stays alive at this density and
// zoom (0..1): at most 16 per point, per 100 px of line, per 100 x 100 px of
// polygon. kind is the seed's (3 point, 4 line, 5 polygon; the a_emit kinds
// 0, 1, 2 work too). rank is the point slot. ptu is pixels-to-tile-units at
// the tile's canonical zoom, so s = 16 / ptu is the tile's scale on screen.
float particleFeatureKeep(float density, float kind, float rank, uint key, float ptu) {
    float d = clamp(density, 0.0, 100.0);
    float k = kind > 2.5 ? kind - 3.0 : kind;
    if (k < 0.5) {
        return clamp(d - rank, 0.0, 1.0);
    }
    float s = 16.0 / max(ptu, 0.000001);
    // Line slots are 32 tile units (2s px) apart, polygon cells 128 (8s px).
    float share = k < 1.5 ? d * s * (1.0 / 50.0) : d * s * s * (1.0 / 156.25);
    float threshold = particleUnit(particleHash(uint3(key, 0x4Bu, 0u)).x);
    return clamp((share - threshold) * 50.0, 0.0, 1.0);
}

// The identity of emitter particle `index` (pool index, kinds 0-2).
ParticleSeed particleEmitterSeed(ParticleParams P, float index, float corner) {
    P = particleClampParams(P);
    float4 id = particleIdentity(P.emission.w);
    uint seed = uint(id.x);
    uint i = uint(index);
    ParticleSeed S;
    S.key = particleHash(uint3(i, seed, 0x5EEDu)).x;
    // Burst group g = i mod G; weather particles are their own group.
    uint groups = uint(floor(P.emission.z));
    S.group = id.w > 1.5 ? S.key : particleHash(uint3(i % groups, seed, 0x6A09u)).x;
    S.index = index;
    S.corner = corner;
    S.kind = min(id.w, 2.0);
    S.keep = 1.0;
    S.extent = float4(0.0, 0.0, 0.0, 0.0);
    return S;
}

// The identity of a particle-features vertex from its a_emit attribute:
// (anchor x, y in tile units, multiples of 1/4; line direction * 8192 + half
// length in tile units; slot * 16 + corner * 4 + kind), with kind 0 point,
// 1 line, 2 polygon. density is the evaluated particle-density and ptu the
// tile's pixels-to-tile-units.
ParticleSeed particleFeatureSeed(float4 emit, float density, float ptu) {
    uint code = uint(max(emit.w, 0.0));
    uint kind = code & 3u;
    uint slot = code >> 4u;
    uint x = uint(max(emit.x * 4.0, 0.0));
    uint y = uint(max(emit.y * 4.0, 0.0));
    float pixels = 1.0 / max(ptu, 0.000001);
    ParticleSeed S;
    S.key = particleHash(uint3(x, y, slot * 4u + kind)).x;
    // The 16 slots of a point share a group, so their births interleave.
    S.group = kind == 0u ? particleHash(uint3(x, y, 0xB0Bu)).x : S.key;
    S.index = float(slot);
    S.corner = float((code >> 2u) & 3u);
    S.kind = 3.0 + float(kind);
    S.extent = float4(0.0, 0.0, 0.0, 0.0);
    if (kind == 1u) {
        float direction = floor(emit.z * (1.0 / 8192.0));
        S.extent = float4((emit.z - 8192.0 * direction) * pixels, direction * (PARTICLE_TAU / 1024.0), 0.0, 0.0);
    } else if (kind == 2u) {
        S.extent = float4(64.0 * pixels, 0.0, 0.0, 0.0);
    }
    S.keep = kind == 3u ? 0.0 : particleFeatureKeep(density, S.kind, S.index, S.key, ptu);
    return S;
}

// Three uniform randoms in [0, 1) for one life: stream n of (key, cycle).
float3 particleRandom(uint key, uint cycle, uint n) {
    uint3 h = particleHash(uint3(key, cycle, n));
    return float3(particleUnit(h.x), particleUnit(h.y), particleUnit(h.z));
}

// A uniformly random unit vector from two uniforms. The radius is written
// as 2 sqrt(u (1 - u)), not sqrt(1 - z^2), to avoid cancellation near the
// poles.
float3 particleDirection(float u, float v) {
    float z = 2.0 * u - 1.0;
    float r = 2.0 * sqrt(max(0.0, u * (1.0 - u)));
    return float3(r * cos(PARTICLE_TAU * v), r * sin(PARTICLE_TAU * v), z);
}

// Drag integrals (F1, F2) at age tau for drag k: velocity integrates to
// v0 * F1 and gravity to -g * F2. A series below k tau = 0.05 avoids the
// cancellation in (1 - e^-x) and (tau - F1), and k = 0 is ballistic.
float2 particleDrag(float k, float tau) {
    float x = k * tau;
    if (x < 0.05) {
        float f1 = tau * (1.0 + x * (-0.5 + x * (1.0 / 6.0 + x * (-1.0 / 24.0 + x * (1.0 / 120.0)))));
        float f2 = tau * tau * (0.5 + x * (-1.0 / 6.0 + x * (1.0 / 24.0 + x * (-1.0 / 120.0 + x * (1.0 / 720.0)))));
        return float2(f1, f2);
    }
    float f1 = (1.0 - exp(-x)) / k;
    return float2(f1, (tau - f1) / k);
}

// Position at age tau (ENU, space units): launch under drag, gravity, wind,
// and a three-octave wander along e0..e2 with phases rho that is zero at
// birth. Phases are reduced to cycles before sin, so long lives stay exact.
float3 particleMotion(ParticleParams P, float3 origin, float3 v0, float3 e0, float3 e1, float3 e2, float3 rho, float tau) {
    float2 drag = particleDrag(P.cone.w, tau);
    float3 p = origin + float3(P.air.x, P.air.y, 0.0) * tau + v0 * drag.x;
    p.z -= P.cone.z * drag.y;
    float f = P.air.w * tau;
    float3 wander = e0 * (sin(PARTICLE_TAU * fract(f + rho.x)) - sin(PARTICLE_TAU * rho.x));
    wander += e1 * (0.5 * (sin(PARTICLE_TAU * fract(2.17 * f + rho.y)) - sin(PARTICLE_TAU * rho.y)));
    wander += e2 * (0.25 * (sin(PARTICLE_TAU * fract(4.33 * f + rho.z)) - sin(PARTICLE_TAU * rho.z)));
    return p + wander * (P.air.z * (1.0 / 1.75));
}

// Rotates a (premultiplied) color about the gray axis by angle radians
// (Rodrigues); linear, so premultiplied colors stay consistent.
float3 particleHueRotate(float3 rgb, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    float3 k = float3(0.5773502691896258, 0.5773502691896258, 0.5773502691896258);
    return rgb * c + cross(k, rgb) * s + k * (dot(k, rgb) * (1.0 - c));
}

// A vertex outside the clip volume: the whole quad is culled.
ParticleVertex particleCollapsed() {
    ParticleVertex o;
    o.position = float4(2.0, 2.0, 2.0, 1.0);
    o.uv = float4(0.0, 0.0, 0.0, 0.0);
    o.color = float4(0.0, 0.0, 0.0, 0.0);
    o.look = float4(0.0, 0.0, 0.0, 0.0);
    return o;
}

// The model: timing, spawn, motion, look over life, projection and the quad
// corner for one vertex. Dead or culled particles collapse outside the clip
// volume. P is clamped here again, so the result never depends on the
// wrapper having done it.
ParticleVertex particleVertex(ParticleParams P, ParticleFrame F, ParticleWeather W, ParticleSeed S, float time) {
    P = particleClampParams(P);
    float4 id = particleIdentity(P.emission.w);
    float shape = id.y;
    bool weather = S.kind > 1.5 && S.kind < 2.5;
    bool screen = !weather && S.kind < 2.5 && id.z < 0.5;
    bool line = S.kind > 3.5 && S.kind < 4.5;
    bool polygon = S.kind > 4.5;
    uint i = uint(S.index);
    float explosiveness = P.emission.y;
    float count = P.emission.x;

    // Birth phase of this particle and of its burst group, and the count
    // prefix.
    float base = particleUnit(particleHash(uint3(uint(id.x), 0u, 7u)).x);
    float phase = 0.0;
    float groupPhase = 0.0;
    float prefix = 1.0;
    if (S.kind < 1.5) {
        uint groups = uint(floor(P.emission.z));
        groupPhase = fract(0.6180339887 * float(i % groups) + base);
        phase = fract(groupPhase + (1.0 - explosiveness) * particleWeyl(i / groups));
        prefix = particlePrefix(count, S.index, count);
    } else if (weather) {
        phase = fract(base + (1.0 - explosiveness) * particleWeyl(i >> 1u));
        groupPhase = phase;
        float weight = (i & 1u) == 0u ? W.weights.x : W.weights.y;
        prefix = particlePrefix(count * weight, float(i >> 1u), count);
    } else if (S.kind < 3.5) {
        groupPhase = particleUnit(S.group);
        phase = fract(groupPhase + particleWeyl(i));
    } else {
        groupPhase = particleUnit(S.key);
        phase = groupPhase;
    }
    float keep = S.keep * prefix;

    // Emission timing. The cycle period divides PARTICLE_W, so the cycle id
    // and age are continuous across the clock wrap: the interval snaps to the
    // nearest such period that still holds the longest life (lifetimes are at
    // most 600 s, so at least 6 cycles fit). The 1e-5 of slack keeps a
    // lifetime that divides PARTICLE_W, such as 1.6 s, from losing a cycle to
    // rounding; it shortens no life by more than that fraction.
    float lifeMax = max(P.timing.x, P.timing.y);
    float lifeMin = min(P.timing.x, P.timing.y);
    float interval = P.timing.z < lifeMax ? lifeMax : P.timing.z;
    float cycles = max(1.0, min(floor(PARTICLE_W / interval + 0.5), floor(PARTICLE_W * 1.00001 / lifeMax)));
    float period = PARTICLE_W / cycles;
    float u = time * cycles * (1.0 / PARTICLE_W) + 1.0 - phase;
    float cycle = floor(u);
    float cycleId = cycle - cycles * floor((cycle + 0.5) / cycles);
    // The group's cycle at this life's birth, so a burst keeps one jitter,
    // center and hue for the whole life.
    float groupCycle = cycle - (phase < groupPhase ? 1.0 : 0.0);
    float groupId = groupCycle - cycles * floor((groupCycle + 0.5) / cycles);
    uint3 burst = particleHash(uint3(S.group, uint(groupId), 0x71u));
    float jitter = P.timing.w * particleUnit(burst.x) * max(period - lifeMax, 0.0);
    float age = (u - cycle) * period - jitter;

    // Per-life randoms, one stream per use.
    uint lifeId = uint(cycleId);
    float3 rLife = particleRandom(S.key, lifeId, 0u);    // lifetime, look seed
    float3 rSpawn = particleRandom(S.key, lifeId, 1u);   // spawn, weather position
    float3 rLaunch = particleRandom(S.key, lifeId, 2u);  // cone, cone turn, speed
    float3 rWander0 = particleRandom(S.key, lifeId, 3u); // wander directions
    float3 rWander1 = particleRandom(S.key, lifeId, 4u);
    float3 rPhase = particleRandom(S.key, lifeId, 5u);   // wander phases
    float3 rSpin = particleRandom(S.key, lifeId, 6u);    // spin angle, spin rate, size
    float3 rColor = particleRandom(S.key, lifeId, 7u);   // hue, twinkle rate, twinkle phase
    float3 rGroup = particleRandom(S.group, uint(groupId), 0x9E37u);  // burst center

    float lifetime = min(mix(lifeMin, lifeMax, rLife.x), period);
    bool alive = age >= 0.0 && age < lifetime && keep > 0.0;
    float tau = max(age, 0.0);
    float l = clamp(tau / lifetime, 0.0, 1.0);

    // Spawn, mixed toward the burst center by explosiveness.
    float3 origin = float3(0.0, 0.0, 0.0);
    float lineAngle = 0.0;
    if (S.kind < 1.5) {
        float3 own = float3(0.0, 0.0, mix(P.area.y, P.area.z, rSpawn.x));
        float3 center = float3(0.0, 0.0, mix(P.area.y, P.area.z, rGroup.x));
        if (S.kind > 0.5) {
            float ownRadius = P.area.x * sqrt(rSpawn.x);
            float centerRadius = P.area.x * sqrt(rGroup.x);
            own = float3(ownRadius * sin(PARTICLE_TAU * rSpawn.y), ownRadius * cos(PARTICLE_TAU * rSpawn.y), mix(P.area.y, P.area.z, rSpawn.z));
            center = float3(centerRadius * sin(PARTICLE_TAU * rGroup.y), centerRadius * cos(PARTICLE_TAU * rGroup.y), mix(P.area.y, P.area.z, rGroup.z));
        }
        origin = mix(own, center, explosiveness);
        if (screen) {
            // The disc stands in the screen plane: its north goes up.
            origin = float3(origin.x, 0.0, origin.z + origin.y);
        }
    } else if (line) {
        lineAngle = S.extent.y;
        float along = (2.0 * rSpawn.x - 1.0) * S.extent.x;
        origin = float3(along * sin(lineAngle), along * cos(lineAngle), 0.0);
    } else if (polygon) {
        origin = float3((2.0 * rSpawn.x - 1.0) * S.extent.x, (2.0 * rSpawn.y - 1.0) * S.extent.x, 0.0);
    }

    // Launch: a direction uniform over the cone's cap, flattened. The
    // cap is sampled through h = 1 - cos(theta) = 2 r sin^2(spread / 2), so
    // narrow cones avoid the cancellation in 1 - cos (GPU cos near 0 is only
    // accurate to about 1e-6 absolute, and 1 - cos(1 degree) is 1.5e-4).
    float flatness = P.cone.y;
    float azimuth = P.launch.z * (PARTICLE_TAU / 360.0) + lineAngle;
    float elevation = P.launch.w * (PARTICLE_TAU / 360.0);
    float3 axis = float3(sin(azimuth) * cos(elevation), cos(azimuth) * cos(elevation), sin(elevation));
    float halfSpread = sin(P.cone.x * (PARTICLE_TAU / 720.0));
    float offAxis = 2.0 * rLaunch.x * halfSpread * halfSpread;
    float cosCone = 1.0 - offAxis;
    float sinCone = sqrt(max(0.0, offAxis * (2.0 - offAxis)));
    float3 t1 = normalize(cross(abs(axis.z) < 0.999 ? float3(0.0, 0.0, 1.0) : float3(1.0, 0.0, 0.0), axis));
    float3 t2 = cross(axis, t1);
    float coneTurn = PARTICLE_TAU * rLaunch.y;
    float3 launch = cosCone * axis + sinCone * (cos(coneTurn) * t1 + sin(coneTurn) * t2);
    launch.z *= 1.0 - flatness;
    float3 v0 = mix(P.launch.x, P.launch.y, rLaunch.z) * launch;
    float3 e0 = particleDirection(rWander0.x, rWander0.y);
    float3 e1 = particleDirection(rWander0.z, rWander1.x);
    float3 e2 = particleDirection(rWander1.y, rWander1.z);
    e0.z *= 1.0 - flatness;
    e1.z *= 1.0 - flatness;
    e2.z *= 1.0 - flatness;

    // Head now and tail `trail` seconds ago; spark and streak always trail.
    bool velocityShape = shape > 2.5 && shape < 4.5;
    bool ripple = shape > 6.5 && shape < 7.5 && !screen;
    float stretch = P.size.w;
    float trail = velocityShape ? max(stretch, 1.0 / 30.0) : stretch;
    bool stretched = (stretch > 0.0 || velocityShape) && !ripple;
    float3 head = particleMotion(P, origin, v0, e0, e1, e2, rPhase, tau);
    float3 tail = particleMotion(P, origin, v0, e0, e1, e2, rPhase, max(tau - trail, 0.0));
    float sizeUnits = mix(P.size.x, P.size.y, rSpin.z) * mix(1.0, P.size.z, l);

    float fade = 1.0;
    float altitude = head.z;
    float groundSize = sizeUnits;
    if (line) {
        // Line particles stay on their own segment and fade near its ends.
        float along = abs(dot(head.xy, float2(sin(lineAngle), cos(lineAngle)))) / max(S.extent.x, 0.000001);
        alive = alive && along <= 1.0;
        fade *= 1.0 - particleSmooth((along - 0.8) * 5.0);
    }
    if (weather) {
        // A world-fixed lattice of boxes, in frame units (the frame axes
        // carry particle-scale, the box does not). Each particle shows in the
        // copy that falls in a box-sized window 0.4 box ahead of the eye along
        // the view direction (the frame's w gradient), so the window fills
        // the view instead of straddling the eye plane. Only the choice of
        // copy moves with the camera, and the faces fade the wrap out.
        float unit = max(F.view.z, 0.000001);
        float4 pool = (i & 1u) == 0u ? W.pool0 : W.pool1;
        float box = max(pool.w * W.eye.w / unit, 0.000001);
        float3 forward = float3(F.X.w, F.Y.w, F.Z.w);
        float3 window = forward * (0.4 * box / max(length(forward), 0.000001));
        float3 rel = box * (fract(rSpawn - pool.xyz + 0.5 + (head - window) / box) - 0.5) + window;
        tail = rel - (head - tail);
        head = rel;
        altitude = W.weights.z + rel.z * unit;
        groundSize = sizeUnits * unit;
        float3 inWindow = abs(rel - window);
        float edge = max(max(inWindow.x, inWindow.y), inWindow.z) / (0.5 * box);
        fade *= 1.0 - particleSmooth((edge - 0.8) * 5.0);
        fade *= particleSmooth((length(rel) / box - 0.02) * (1.0 / 0.06));
    }
    if (!screen) {
        // Below the ground a particle fades out over one size, then dies.
        float ground = 1.0 + altitude / max(groundSize, 0.000001);
        alive = alive && ground > 0.0;
        fade *= particleSmooth(ground);
    }

    // Projection.
    float4 headClip = F.C + head.x * F.X + head.y * F.Y + head.z * F.Z;
    float4 tailClip = F.C + tail.x * F.X + tail.y * F.Y + tail.z * F.Z;
    if (!alive || headClip.w <= 0.000001 || (stretched && tailClip.w <= 0.000001)) {
        return particleCollapsed();
    }
    float2 ndcHead = headClip.xy / headClip.w;
    if (weather) {
        // Thin toward the vanishing point of the fall direction.
        float4 vanish = axis.x * F.X + axis.y * F.Y + axis.z * F.Z;
        if (vanish.w > 0.000001) {
            float2 offset = ndcHead - vanish.xy / vanish.w;
            offset.x *= F.screen.z / max(F.screen.w, 1.0);
            fade *= mix(1.0, particleSmooth((length(offset) - 0.05) * (1.0 / 0.55)), P.area.w);
        }
    }
    float rawPx = sizeUnits * F.view.z * (F.view.w > 0.5 ? F.view.x / headClip.w : 1.0);
    float sizePx = min(max(rawPx, P.sizeSpin.x), P.sizeSpin.y);
    float ratio = max(F.view.y, 0.000001);
    // Screen positions in logical px from the viewport center (y down), and
    // how far a stretched particle's head is from its tail.
    float2 pxHead = ndcHead / F.screen.xy;
    float2 pxTail = stretched ? (tailClip.xy / tailClip.w) / F.screen.xy : pxHead;
    float span = length(pxHead - pxTail);
    // A quad a few physical px wide covers so few pixel centers that its
    // brightness would change with where it sits between them, and a glow
    // one pixel wide vanishes at a pixel corner. Smaller particles are drawn
    // at a floor size with their missing area as alpha: sprites at
    // PARTICLE_SPRITE_FLOOR px (their shapes have thinner features), capsules
    // at PARTICLE_STRETCHED_FLOOR px across (their area goes as
    // size * (span + 0.2 pi size)).
    float floorPx = (stretched ? PARTICLE_STRETCHED_FLOOR : PARTICLE_SPRITE_FLOOR) / ratio;
    if (sizePx < floorPx) {
        float scale = sizePx / floorPx;
        fade *= stretched ? scale * (span + 0.6283185 * sizePx) / (span + 0.6283185 * floorPx) : scale * scale;
        sizePx = floorPx;
    }
    float halfPx = 0.5 * sizePx;
    float aa = 2.0 / (sizePx * ratio);

    // Look over life.
    float4 color = mix(P.color, P.colorEnd, l);
    float hue = ((2.0 * rColor.x - 1.0) * P.sparkle.z + (2.0 * particleUnit(burst.y) - 1.0) * P.sparkle.w) * (PARTICLE_TAU / 360.0);
    color.rgb = min(max(particleHueRotate(color.rgb, hue), float3(0.0, 0.0, 0.0)), float3(color.a, color.a, color.a));
    float fadeIn = P.fadeAdd.x > 0.0 ? particleSmooth(l / P.fadeAdd.x) : 1.0;
    float fadeOut = P.fadeAdd.y > 0.0 ? particleSmooth((1.0 - l) / P.fadeAdd.y) : 1.0;
    float amount = P.sparkle.x;
    float wave = 0.5 + 0.5 * sin(PARTICLE_TAU * fract(P.sparkle.y * (1.0 + 0.6 * (rColor.y - 0.5)) * tau + rColor.z));
    float twinkle = 1.0 - amount + amount * pow(max(wave, 0.0), 1.0 + 3.0 * amount);
    float strength = fadeIn * fadeOut * twinkle * keep * fade;
    if (strength <= 0.0) {
        return particleCollapsed();
    }
    float additive = clamp(mix(P.fadeAdd.z, P.fadeAdd.w, l), 0.0, 1.0);

    ParticleVertex o;
    o.color = float4(color.rgb * strength, color.a * strength * (1.0 - additive));
    o.look = float4(shape, 0.0, rLife.y, 0.0);
    // Corners 0..3 go around the quad: (-1, -1), (1, -1), (1, 1), (-1, 1).
    float sx = S.corner > 0.5 && S.corner < 2.5 ? 1.0 : -1.0;
    float sy = S.corner > 1.5 ? 1.0 : -1.0;
    if (ripple) {
        // Flat on the ground: the corners go through the ground axes, so the
        // ring is a perspective-correct ellipse.
        float halfUnits = 0.5 * sizeUnits * sizePx / max(rawPx, 0.000001);
        float4 east = F.X * halfUnits;
        float4 north = F.Y * halfUnits;
        if (headClip.w - abs(east.w) - abs(north.w) <= 0.000001) {
            return particleCollapsed();
        }
        float4 cornerClip = headClip + sx * east + sy * north;
        o.position = float4(cornerClip.x, cornerClip.y, PARTICLE_Z_NEAR * cornerClip.w, cornerClip.w);
        o.uv = float4(sx, sy, 0.0, aa);
        return o;
    }
    // Screen quads in logical px from the viewport center (y down).
    float2 px = pxHead;
    if (stretched) {
        // A capsule from the tail to the head, uv.x along it in half sizes.
        float2 dir = span > 0.001 ? (pxHead - pxTail) / span : float2(0.0, -1.0);
        float along = sx < 0.0 ? -halfPx : span + halfPx;
        px = pxTail + dir * along + float2(-dir.y, dir.x) * (sy * halfPx);
        o.uv = float4(along / halfPx, sy, span / halfPx, aa);
    } else {
        float angle = PARTICLE_TAU * fract(rSpin.x + mix(P.sizeSpin.z, P.sizeSpin.w, rSpin.y) * (1.0 / 360.0) * tau);
        float c = cos(angle);
        float s = sin(angle);
        px = pxHead + float2(c * sx - s * sy, s * sx + c * sy) * halfPx;
        o.uv = float4(sx, sy, 0.0, aa);
    }
    o.position = float4(px * F.screen.xy, PARTICLE_Z_NEAR, 1.0);
    return o;
}

// One corner of the full-screen emitter-screen-tint quad (emitter vertices
// 0-3); collapses when the tint is transparent. shape.glsl lays the vignette.
ParticleVertex particleTint(float4 tint, float vignette, float corner) {
    if (tint.a <= 0.0) {
        return particleCollapsed();
    }
    float sx = corner > 0.5 && corner < 2.5 ? 1.0 : -1.0;
    float sy = corner > 1.5 ? 1.0 : -1.0;
    ParticleVertex o;
    o.position = float4(sx, sy, PARTICLE_Z_NEAR, 1.0);
    o.uv = float4(sx, sy, 0.0, 0.0);
    o.color = tint;
    o.look = float4(100.0, clamp(vignette, 0.0, 1.0), 0.0, 0.0);
    return o;
}
