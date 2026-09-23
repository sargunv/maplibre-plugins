// Shared fragment function for every location indicator component. The same
// source compiles as GLSL (OpenGL, Vulkan, WebGL) and MSL; each host defines
// float2/float4, DX/DY (screen derivatives), and ATAN before including it.
//
// p is the point in the component's unit space (the quad spans ±1.15).
// style.x selects the shape:
//   0  disc with a border (puck, accuracy circle);
//        style.y = border width, in pixels when style.w == 0, else as a
//        fraction of the radius
//   1  sector fading toward the edge (bearing accuracy); style.z = half-angle
//   2  soft disc (shadow)
//   3  ring (pulse); style.y = ring width in pixels
//   4  arrow (bearing)
// Derivatives measure coverage in framebuffer pixels, including perspective
// and device pixel ratio, so every edge is anti-aliased at one pixel.
float4 shade(float2 p, float4 style, float4 fill, float4 border) {
    float radius = length(p);
    float distance = radius - 1.0;
    float coverage = 1.0;
    if (style.x > 3.5) {
        float2 a = float2(0.0, -1.0);
        float2 b = float2(0.39, -0.28);
        float2 d = float2(-0.39, -0.28);
        float2 e0 = b - a, e1 = d - b, e2 = a - d;
        float2 v0 = p - a, v1 = p - b, v2 = p - d;
        float2 q0 = v0 - e0 * clamp(dot(v0,e0)/dot(e0,e0),0.0,1.0);
        float2 q1 = v1 - e1 * clamp(dot(v1,e1)/dot(e1,e1),0.0,1.0);
        float2 q2 = v2 - e2 * clamp(dot(v2,e2)/dot(e2,e2),0.0,1.0);
        float s = sign(e0.x*e2.y-e0.y*e2.x);
        float2 q = min(min(float2(dot(q0,q0),s*(v0.x*e0.y-v0.y*e0.x)),
                           float2(dot(q1,q1),s*(v1.x*e1.y-v1.y*e1.x))),
                           float2(dot(q2,q2),s*(v2.x*e2.y-v2.y*e2.x)));
        distance = -sqrt(q.x)*sign(q.y);
    }
    float aa = max(length(float2(DX(distance),DY(distance))), 0.000001);
    float pixels = distance / aa;
    if (style.x < 0.5) {
        float edge = 1.0-smoothstep(-0.5,0.5,pixels);
        float width = style.w > 0.0 ? style.y / aa : style.y;
        float ring = width > 0.0 ? smoothstep(-width-0.5,-width+0.5,pixels) : 0.0;
        return mix(fill,border,ring)*edge;
    }
    if (style.x < 1.5) {
        float angle = ATAN(abs(p.x),-p.y);
        float angularAA = max(length(float2(DX(angle),DY(angle))),0.000001);
        coverage = style.z >= 3.1415926 ? 1.0 : 1.0-smoothstep(style.z-angularAA,style.z+angularAA,angle);
        coverage *= 1.0-smoothstep(0.0,1.0,radius);
    } else if (style.x < 2.5) {
        coverage = exp(-3.0*radius*radius)*(1.0-smoothstep(0.7,1.0,radius));
    } else if (style.x < 3.5) {
        return fill*(1.0-smoothstep(style.y-0.5,style.y+0.5,abs(pixels)));
    }
    return fill*coverage*(1.0-smoothstep(-0.5,0.5,pixels));
}
