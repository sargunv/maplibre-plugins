// Shared fragment functions for animated icons: the analytic coverage of one
// baked frame of the catalog texture (../catalog/FORMAT.md, "Texel records"),
// painted and composited op by op. The same source compiles as GLSL
// (OpenGL, Vulkan, WebGL2) and MSL. ../baker/src/shade.ts is the same
// algorithm in f32 on the CPU; keep the two in step.
//
// A host defines, before this file:
//   float2, float4      GLSL: vec2 and vec4 (MSL has them natively)
//   DX(v), DY(v)        screen-space derivatives: dFdx/dFdy, MSL dfdx/dfdy
//   FETCH(i)            texel i (an int) of the catalog texture `u_art`:
//                       column i & (W - 1), row i >> ICON_ART_SHIFT clamped
//                       to [0, ICON_ART_ROWS - 1], so any int reads inside
//                       the texture
//   ICON_ART_PARAM      a trailing parameter declaration, with its leading
//                       comma, through which FETCH reads the texture (MSL:
//                       `, texture2d<float, access::read> art`); empty in GLSL
//   ICON_ART_ARG        the matching argument (MSL: `, art`); empty in GLSL
// and, in GLSL ES, `precision highp float; precision highp int;`: the
// coverage needs full float precision.
//
// It provides:
//   float4 iconShade(float2 uv, float frame, float4 primary, float4 secondary, float opacity ICON_ART_PARAM)
//     uv         the fragment's position in canvas pixels (y down)
//     frame      the texel of the frame record to draw (a whole number)
//     primary    icon-color, premultiplied; its alpha is the strength
//     secondary  the secondary recolor, likewise (vec4(0) draws as authored)
//     opacity    icon-opacity
//   Returns the icon's premultiplied color at the fragment. iconShade takes
//   derivatives, so call it in uniform control flow.
//
// Every loop bound, index and texel row is clamped, so even texels that
// validation never saw, or a frame chosen from a NaN playhead, keep reads
// inside the texture and loops bounded.
//
// Coverage follows Slug (Eric Lengyel, "GPU-Centered Font Rendering Directly
// from Glyph Outlines", JCGT 2017). Each pixel casts a horizontal and a
// vertical ray, sums the signed crossings of the curves in its band of each
// direction, weighted by how close each crossing is to the pixel, and blends
// the two rays' coverage. Band lists are sorted so a ray exits early, and a
// pixel on the near side of its band's split casts the ray the other way
// (the paper's section 4). The root selection and coverage combination are
// ported from Slug's reference pixel shader, which carries this notice:
//
//   Reference pixel shader for the Slug algorithm.
//   This code is made available under the MIT License.
//   Copyright 2017, by Eric Lengyel.
//
// Unlike the reference, the roots are solved in the cancellation-free form,
// because curves here are in arbitrary local units rather than em units: a
// nearly straight curve keeps its crossing exact, where the reference's
// fixed 1/65536 threshold on the quadratic coefficient would lose it.

// Which roots of a sample-relative quadratic cross the ray: bit 0 for the
// first root, bit 8 for the second (Slug's CalcRootCode). A coordinate of
// zero counts as positive, so a curve ending on the ray and the next one
// starting there are counted once between them.
uint iconRootCode(float y1, float y2, float y3) {
    uint shift = (y1 < 0.0 ? 1u : 0u) | (y2 < 0.0 ? 2u : 0u) | (y3 < 0.0 ? 4u : 0u);
    return (0x2E74u >> shift) & 0x0101u;
}

// The x coordinates where the quadratic (p1, p2, p3) crosses y = 0, at its
// two roots t1 = (b - d) / a and t2 = (b + d) / a in Slug's order, where
// the curve is a t^2 - 2b t + c. Each real root is taken in whichever of the
// two equivalent forms avoids cancellation, and a linear curve (a = 0) has
// one root, used for both. As in Slug, imaginary roots become a double root
// at the vertex, t = b / a, so a curve grazing the ray adds nothing.
float2 iconSolve(float2 p1, float2 p2, float2 p3) {
    float2 a = p1 - p2 * 2.0 + p3;
    float2 b = p1 - p2;
    float discriminant = b.y * b.y - a.y * p1.y;
    bool curved = abs(a.y) > 1e-12;
    float tVertex = curved ? b.y / a.y : 0.0;
    float q = b.y >= 0.0 ? b.y + sqrt(max(discriminant, 0.0)) : b.y - sqrt(max(discriminant, 0.0));
    float tNear = discriminant > 0.0 ? p1.y / q : tVertex;
    float tFar = discriminant > 0.0 && curved ? q / a.y : tNear;
    float t1 = b.y >= 0.0 ? tNear : tFar;
    float t2 = b.y >= 0.0 ? tFar : tNear;
    return float2((a.x * t1 - b.x * 2.0) * t1 + p1.x, (a.x * t2 - b.x * 2.0) * t2 + p1.x);
}

// The coverage of shape record `shape` at local point q, with perPixel the
// screen pixels per local unit along each axis. Band headers are (split,
// count, list, 0); list entry i sits in texel list + i / 2, as (positive-ray
// curve, negative-ray curve) in its xy or zw half.
float iconCoverage(float2 q, float2 perPixel, int shape, int evenOdd ICON_ART_PARAM) {
    float4 counts = FETCH(shape);
    float4 transform = FETCH(shape + 1);
    int hCount = clamp(int(counts.x + 0.5), 1, 16);
    int vCount = clamp(int(counts.y + 0.5), 1, 16);
    int hBand = clamp(int(floor(q.y * transform.x + transform.y)), 0, hCount - 1);
    int vBand = clamp(int(floor(q.x * transform.z + transform.w)), 0, vCount - 1);
    float4 hHeader = FETCH(shape + 2 + hBand);
    float4 vHeader = FETCH(shape + 2 + hCount + vBand);

    // Horizontal ray, toward +x, or toward -x left of the split. Curves are
    // sorted so that once one lies wholly more than half a pixel behind the
    // ray's start, so do all the rest.
    float xcov = 0.0;
    float xwgt = 0.0;
    bool xneg = q.x < hHeader.x;
    int xcount = clamp(int(hHeader.y + 0.5), 0, 1024);
    int xlist = int(hHeader.z + 0.5);
    for (int i = 0; i < xcount; i++) {
        float4 entry = FETCH(xlist + (i >> 1));
        float2 pair = (i & 1) == 0 ? entry.xy : entry.zw;
        int c = int((xneg ? pair.y : pair.x) + 0.5);
        float4 p12 = FETCH(c) - float4(q, q);
        float2 p1 = p12.xy;
        float2 p2 = p12.zw;
        float2 p3 = FETCH(c + 1).xy - q;
        if (xneg) {
            if (min(min(p1.x, p2.x), p3.x) * perPixel.x > 0.5) break;
        } else {
            if (max(max(p1.x, p2.x), p3.x) * perPixel.x < -0.5) break;
        }
        uint code = iconRootCode(p1.y, p2.y, p3.y);
        if (code != 0u) {
            float2 r = iconSolve(p1, p2, p3) * perPixel.x;
            if ((code & 1u) != 0u) {
                xcov += xneg ? -clamp(0.5 - r.x, 0.0, 1.0) : clamp(r.x + 0.5, 0.0, 1.0);
                xwgt = max(xwgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
            }
            if (code > 1u) {
                xcov += xneg ? clamp(0.5 - r.y, 0.0, 1.0) : -clamp(r.y + 0.5, 0.0, 1.0);
                xwgt = max(xwgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
            }
        }
    }

    // Vertical ray, toward +y, or toward -y above the split: the same with
    // the axes swapped, and the crossings counted with the opposite sign.
    float ycov = 0.0;
    float ywgt = 0.0;
    bool yneg = q.y < vHeader.x;
    int ycount = clamp(int(vHeader.y + 0.5), 0, 1024);
    int ylist = int(vHeader.z + 0.5);
    for (int i = 0; i < ycount; i++) {
        float4 entry = FETCH(ylist + (i >> 1));
        float2 pair = (i & 1) == 0 ? entry.xy : entry.zw;
        int c = int((yneg ? pair.y : pair.x) + 0.5);
        float4 p12 = FETCH(c) - float4(q, q);
        float2 p1 = p12.xy;
        float2 p2 = p12.zw;
        float2 p3 = FETCH(c + 1).xy - q;
        if (yneg) {
            if (min(min(p1.y, p2.y), p3.y) * perPixel.y > 0.5) break;
        } else {
            if (max(max(p1.y, p2.y), p3.y) * perPixel.y < -0.5) break;
        }
        uint code = iconRootCode(p1.x, p2.x, p3.x);
        if (code != 0u) {
            float2 r = iconSolve(p1.yx, p2.yx, p3.yx) * perPixel.y;
            if ((code & 1u) != 0u) {
                ycov += yneg ? clamp(0.5 - r.x, 0.0, 1.0) : -clamp(r.x + 0.5, 0.0, 1.0);
                ywgt = max(ywgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
            }
            if (code > 1u) {
                ycov += yneg ? -clamp(0.5 - r.y, 0.0, 1.0) : clamp(r.y + 0.5, 0.0, 1.0);
                ywgt = max(ywgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
            }
        }
    }

    // Slug's CalcCoverage: the rays blended by weight, never below the
    // weaker of the two; either winding direction counts.
    float coverage = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));
    return evenOdd != 0 ? 1.0 - abs(1.0 - fract(coverage * 0.5) * 2.0) : clamp(coverage, 0.0, 1.0);
}

// Recolors a slot's premultiplied color: the hue moves toward the recolor by
// its alpha (the strength) while the authored alpha stays
// (../catalog/FORMAT.md, "Recoloring").
float4 iconRecolor(float4 color, float4 recolor) {
    if (recolor.a > 0.0 && color.a > 0.0) {
        return float4(mix(color.rgb / color.a, recolor.rgb / recolor.a, recolor.a) * color.a, color.a);
    }
    return color;
}

// Offset k (0 to 7) of a gradient's two offset texels.
float iconStopOffset(float4 low, float4 high, int k) {
    float4 v = k < 4 ? low : high;
    int c = k & 3;
    return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
}

// Gradient record `gradient` with `stops` stops at local point q, padded at
// both ends: linear from its start to its end, or radial around its start.
// Stop colors are straight and interpolate straight; the result is
// premultiplied, before the op's opacity.
float4 iconGradient(float2 q, int gradient, int stops, int radial ICON_ART_PARAM) {
    float4 ends = FETCH(gradient);
    float2 d = ends.zw - ends.xy;
    float t = radial != 0 ? length(q - ends.xy) / max(length(d), 1e-6) : dot(q - ends.xy, d) / max(dot(d, d), 1e-12);
    t = clamp(t, 0.0, 1.0);
    float4 low = FETCH(gradient + 1);
    float4 high = FETCH(gradient + 2);
    float4 color = FETCH(gradient + 3);
    if (t > iconStopOffset(low, high, 0)) {
        if (t >= iconStopOffset(low, high, stops - 1)) {
            color = FETCH(gradient + 2 + stops);
        } else {
            for (int k = 0; k < stops - 1; k++) {
                float a = iconStopOffset(low, high, k);
                float b = iconStopOffset(low, high, k + 1);
                if (t <= b) {
                    color = mix(FETCH(gradient + 3 + k), FETCH(gradient + 4 + k), clamp((t - a) / max(b - a, 1e-6), 0.0, 1.0));
                    break;
                }
            }
        }
    }
    return float4(color.rgb * color.a, color.a);
}

float4 iconShade(float2 uv, float frame, float4 primary, float4 secondary, float opacity ICON_ART_PARAM) {
    // Canvas pixels per screen pixel along each axis, taken once, before any
    // loop, so the derivatives are well defined.
    float2 dx = DX(uv);
    float2 dy = DY(uv);
    float2 extent = abs(dx) + abs(dy);
    float4 record = FETCH(int(frame + 0.5));
    int count = clamp(int(record.x + 0.5), 0, 64);
    int ops = int(record.y + 0.5);
    float4 color = float4(0.0);
    for (int k = 0; k < count; k++) {
        // An op draws a shape through its canvas-to-local map, (bbox, linear
        // part, (translation, shape, style), paint). A pixel more than a
        // pixel outside its bbox has no coverage from it.
        int o = ops + 4 * k;
        float4 box = FETCH(o);
        if (uv.x < box.x - extent.x || uv.y < box.y - extent.y || uv.x > box.z + extent.x || uv.y > box.w + extent.y) continue;
        float4 affine = FETCH(o + 1);
        float4 place = FETCH(o + 2);
        float4 paint = FETCH(o + 3);
        float2 q = float2(affine.x * uv.x + affine.y * uv.y + place.x, affine.z * uv.x + affine.w * uv.y + place.y);
        float2 qdx = float2(affine.x * dx.x + affine.y * dx.y, affine.z * dx.x + affine.w * dx.y);
        float2 qdy = float2(affine.x * dy.x + affine.y * dy.y, affine.z * dy.x + affine.w * dy.y);
        float2 perPixel = 1.0 / max(abs(qdx) + abs(qdy), float2(1e-6));
        int style = int(place.w + 0.5);
        float coverage = iconCoverage(q, perPixel, int(place.z + 0.5), (style >> 2) & 1 ICON_ART_ARG);
        if (coverage <= 0.0) continue;
        // Style: bits 0-1 the slot, bits 3-4 the paint kind (solid, linear,
        // radial). A solid paint is premultiplied; a gradient's is
        // (texel, stops, opacity, 0).
        int kind = (style >> 3) & 3;
        int slot = style & 3;
        float4 c = kind == 0 ? paint : iconGradient(q, int(paint.x + 0.5), clamp(int(paint.y + 0.5), 2, 8), kind == 2 ? 1 : 0 ICON_ART_ARG) * paint.z;
        if (kind == 0 && slot == 1) c = iconRecolor(c, primary);
        if (kind == 0 && slot == 2) c = iconRecolor(c, secondary);
        c *= coverage;
        color = c + color * (1.0 - c.a);
    }
    return color * opacity;
}
