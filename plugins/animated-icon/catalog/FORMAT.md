# `.mlvc` vector flipbook catalog, version 2

The baker (`../baker`) compiles Lottie animations into this binary catalog. Both
runtimes read it: `native/src/catalog.zig` and `js/src/catalog.ts` are twins
tested against the shared fixtures in `../fixtures/catalog/`, and
`baker/src/pack.ts` is the only writer. Every frame of every animation stays
resident: the texel section is uploaded once as the RGBA32F texture `u_art`, and
the shader (`../shaders/icon.glsl`, with `baker/src/shade.ts` as its CPU twin)
picks a frame record and walks its ops.

Version 1 (milestone M0, frame regions copied into a uniform block) is gone.
Readers reject it with `unsupported catalog version 1; rebake it with the M1
baker`, and any other version but 2 with `unsupported catalog version <n>`.

## Conventions

- Integers are little-endian `u32`, floats little-endian IEEE-754 `f32`. Offsets
  are bytes from the start of the file.
- Every section starts on a 16-byte boundary at or after byte 64.
- A **texel** is 4 × f32 (16 bytes). Texel indices count from the start of the
  texel section, which is also the texture's texel order.
- An **integer field** stored in an f32 is finite, whole and in `[0, 2^24)`,
  where f32 is exact. An **index** is an integer field below `texel_count`.
- Coordinates are f32. Canvas pixels are the Lottie composition's units, with y
  pointing down. Each shape has its own **local** units.

## Header (64 bytes)

| Offset | Field               | Meaning                                                                               |
| ------ | ------------------- | ------------------------------------------------------------------------------------- |
| 0      | `magic`             | the 8 bytes `MLVCAT\0\0`                                                              |
| 8      | `version`           | `2`                                                                                   |
| 12     | `animation_count`   | N entries, not counting the implicit `none`; at most 510                              |
| 16     | `texture_width`     | `1024` or `2048`                                                                      |
| 20     | `texture_height`    | `max(1, ceil(texel_count / texture_width))`, at most 2048                             |
| 24     | `texel_count`       | texels in the texel section                                                           |
| 28     | `flags`             | `0`                                                                                   |
| 32     | `animations_offset` | N animation records of 64 bytes                                                       |
| 36     | `names_offset`      | the names section                                                                     |
| 40     | `names_size`        | bytes in the names section                                                            |
| 44     | `texels_offset`     | the texel section, which ends the file: `texels_offset + 16 × texel_count` = its size |
| 48     | reserved            | 16 zero bytes                                                                         |

The records and names lie before the texel section. 510 animations keep the
header block (below) within 16 KiB: `16 + 32 × 511 = 16368` bytes.

## Animation record (64 bytes)

Records are in enum order: record `i` is enum index `i + 1`, because index 0 is
`none`.

| Offset | Field              | Meaning                                                                                            |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------- |
| 0      | `box` (4 × f32)    | anchor box `x0, y0, x1, y1` in canvas pixels; `x0 < x1`, `y0 < y1`, each at most 2^24 in magnitude |
| 16     | `display_px` (f32) | logical pixels of the box's longer side at `icon-size` 1, in `(0, 2^24]`                           |
| 20     | `fps` (f32)        | frames per second, in `(0, 2^24]`                                                                  |
| 24     | `frame_count`      | frames in the loop, `1` to `2^24 - 1`                                                              |
| 28     | `frame_texel`      | the entry's first frame record; `frame_texel + frame_count <= texel_count`                         |
| 32     | `name_offset`      | byte offset of the name within the names section                                                   |
| 36     | `name_length`      | name length in bytes; `name_offset + name_length <= names_size`                                    |
| 40     | `canvas` (2 × f32) | Lottie canvas width and height in canvas pixels, each in `(0, 2^24]`                               |
| 48     | reserved           | 16 zero bytes                                                                                      |

Names are UTF-8, unique, match `[a-z0-9][a-z0-9_#-]*` and are never `none`. By
convention `a#m` is marker `m` of animation `a`: an ordinary record whose frame
window lies inside `a`'s frame records. Readers do not check that relation.

## Texel records

The writer lays out the texel section as every animation's frame records, then
the op lists, the shapes and the gradients. Readers do not rely on that order.

### Frame

One texel at `frame_texel + f`: `(op_count, op_texel, 0, 0)`. `op_count` is an
integer from 0 to 64 and `op_texel` an integer with `op_texel + 4 × op_count <=
texel_count`. Frames with identical ops share one op list, and marker entries
share their animation's frame records.

### Op

Four texels at `op_texel + 4k`. Ops draw in order, the first at the bottom,
composited source-over inside the icon.

| Texel | Contents                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| `O0`  | `(x0, y0, x1, y1)`: a conservative bounding box of the op's coverage in canvas pixels, `x0 <= x1`, `y0 <= y1`   |
| `O1`  | `(a, b, c, d)`: the linear part of the canvas-to-local map                                                      |
| `O2`  | `(tx, ty, shape_texel, style)`: the map's translation, the shape record's index, and the style                  |
| `O3`  | solid: the color, premultiplied, each component in [0, 1]; gradient: `(gradient_texel, stop_count, opacity, 0)` |

A canvas point `(u, v)` is local point `q = (a·u + b·v + tx, c·u + d·v + ty)`.
The style integer holds the slot in bits 0–1 (0 authored, 1 primary, 2
secondary), the fill rule in bit 2 (0 nonzero, 1 even-odd) and the paint kind in
bits 3–4 (0 solid, 1 linear, 2 radial); every other bit is 0, and a gradient
op's slot is 0. A gradient's `gradient_texel` is an index, `stop_count` an
integer from 2 to 8 and `opacity` in [0, 1]. A color already includes every
opacity above the paint in the Lottie tree, so the runtime draws it as given.

### Shape

A shape is a set of closed contours of quadratic curves in local units, with
band lists for the coverage shader. At `S`:

| Texel                 | Contents                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `S0`                  | `(H, V, 0, 0)`: horizontal and vertical band counts, integers from 1 to 16; `S + 2 + H + V <= texel_count` |
| `S1`                  | `(hs, hb, vs, vb)`: the band transform, finite                                                             |
| `S2` … `S(1+H)`       | horizontal band headers                                                                                    |
| `S(2+H)` … `S(1+H+V)` | vertical band headers                                                                                      |
| then                  | band lists, then curves                                                                                    |

A local point `q` lies in horizontal band `clamp(floor(q.y·hs + hb), 0, H−1)`
and vertical band `clamp(floor(q.x·vs + vb), 0, V−1)`. Horizontal bands cast
their rays along x, vertical bands along y.

A **band header** is `(split, count, list_texel, 0)`. `split` is finite: samples
whose coordinate along the ray (x for horizontal bands, y for vertical) is below
it cast the negative ray, so `split <= -1e38` turns the split off (the writer
uses `-3.0e38`). `count` is an integer from 0 to 1024, and `list_texel` an index
with `list_texel + ceil(count / 2) <= texel_count`.

A **band list** holds `count` entries, two per texel: entry `i` is in texel
`list_texel + i / 2`, in its `xy` half when `i` is even and its `zw` half when
odd, as `(pos_i, neg_i)`. `pos` lists every curve of the band by **descending
maximum** coordinate along the ray, `neg` the same curves by **ascending
minimum**; ties go to the lower curve index. Each entry is a curve index `c`, an
integer with `c + 1 < texel_count`. When the split is off, `neg` repeats `pos`.
An unused `zw` half is 0.

**Curves:** a contour of n curves takes n + 1 texels starting at `c`: texel `c +
k` is `(on_k.x, on_k.y, ctrl_k.x, ctrl_k.y)` for k < n, and texel `c + n` is
`(on_0.x, on_0.y, 0, 0)`, which closes the contour. Curve `c + k` is the
quadratic Bézier `(T[c+k].xy, T[c+k].zw, T[c+k+1].xy)`. A straight segment's
control point is the exact midpoint.

### Gradient

`3 + n` texels at `G`: `G0 = (x0, y0, x1, y1)`, the start and end in local units
(radial: the centre and a point on the radius), finite. `G1` holds offsets 0–3
and `G2` offsets 4–7; unused offsets are 1, and the first n are in [0, 1] and
non-decreasing. `G3` … `G(2+n)` are the stop colors, **straight** (not
premultiplied) RGBA in [0, 1]. Colors interpolate straight and are premultiplied
afterwards, as lottie-web's separate color and opacity gradients do; the
gradient pads beyond its ends.

### Sharing

Any number of ops may name the same `shape_texel` or `gradient_texel`, frames
may share op lists, and marker entries share frame records. None of this changes
how the shader reads the catalog.

## Band construction (writer)

The rules below are normative for tools that rebuild bands, such as tests.

- A curve's **extent** along an axis is that of its three control points.
- **Counts:** a shape of `m` curves spanning `e` pixels along the axis at
  `pxPerUnit` (the largest logical pixels per local unit where it is drawn) gets
  `clamp(min(ceil(m / 4), floor(e / 4)), 1, 16)` bands.
- **Transform:** `hs = H / (ymax − ymin)` and `hb = −ymin·hs` over the shape's
  control-hull bounds, stored as f32; the same with x for `vs`, `vb`. When
  `ymax == ymin`, `H = 1`, `hs = 0` and `hb = 0`.
- **Membership:** a curve belongs to horizontal band `k` when its y extent meets
  `[y_k − ε, y_(k+1) + ε]`, where `y_k = (k − hb) / hs` with the f32 transform
  and `ε = (y_(k+1) − y_k) / 1024`. Vertical bands work the same way with x. The
  margin absorbs the shader's rounding when it picks a band.
- **Split:** on when the band's curves span at least 16 pixels along the ray and
  it lists at least 4 curves; then it is the lower median of the curves'
  midpoints along the ray, `(min + max) / 2`.
- The writer moves each shape so its control-hull minimum is the local origin
  (and shifts each op's translation and gradient points to match), which keeps
  the band transform exact in f32. Identical band lists of one shape are stored
  once, and a band with no curves points `list_texel` at `S`.
- A band lists at most 256 curves; the baker rejects shapes that need more.

## Validation

Readers validate structure and bounds, so that no valid catalog makes the shader
read outside the texture. They do not validate geometry: a curve index that
points at a closing texel is legal and draws garbage. The checks run in this
order, and the first failing check gives the message:

1. **Header:** the size is at least 64 bytes; the magic; the version; `flags`;
   `animation_count <= 510`; `texture_width`; `texel_count` fits a
   `texture_width × 2048` texture and `texture_height` matches it; the section
   offsets are multiples of 16 and at least 64, in field order; the records and
   names end at or before `texels_offset`; the texel section ends the file.
2. **Records, in order:** the name's bounds, pattern, uniqueness and `none`;
   then the box, `display_px`, `fps`, `frame_count`, the frame window and the
   canvas.
3. **Texels, per animation, per frame, per op, depth first:** the frame record;
   the op's fields in texel order (bbox, linear part, translation, shape index,
   style); the style bits; the paint (solid color, or the gradient's fields,
   bounds, endpoints, offsets and stop colors); then the shape (band counts,
   header bounds, transform, and per band its split, count, list bounds and each
   list entry). Each frame record, op and shape is checked once however many
   records name it, and a gradient once per largest stop count.

Messages read `<location>: <problem>`, for example `animation 0 "dot": frame 0:
op 0: shape: horizontal band 0: list entry 1 is not a curve index`. The location
starts with `animation <record> "<name>"` once the name is valid. The exact
texts are pinned by `../fixtures/catalog/manifest.json`, and both readers
produce them byte for byte.

## Texture

The texture is `texture_width × texture_height` RGBA32F, sampled nearest: texels
`0 … texel_count − 1` are the texel section and the rest are 0. The shader reads
texel `i` at column `i & (W − 1)` and row `clamp(i >> ICON_ART_SHIFT, 0,
ICON_ART_ROWS − 1)`, so any integer reads inside the texture.

## Header block and shader defines

The plugin writes the `IconCatalogUBO` uniform block (std140) every frame from
the catalog. It has `E = animation_count + 1` entries and `16 + 32·E` bytes, all
f32:

| Byte     | Contents                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 0        | `(clock, 0, 0, 0)`: seconds in [0, 4096)                                                                     |
| 16 + 32e | entry e: the box `(x0, y0, x1, y1)`                                                                          |
| 32 + 32e | entry e: `(display_px, loop_rate, frame_count, frame_texel)`, `loop_rate = f32(f64(fps) / f64(frame_count))` |

Entry 0 (`none`) is all zero. A clock that rounds to 4096 in f32, or lies
outside [0, 4096), is written as 0. Every shader stage starts with these
defines, one per line, each line ending in `\n`:

```
#define ICON_ENTRY_COUNT <E>
#define ICON_ART_SHIFT <log2 texture_width>
#define ICON_ART_ROWS <texture_height>
```

## Timing

The vertex shader picks each icon's frame from the clock and the icon's
`icon-animation-speed`, `-offset` and `-mode` (0 loop, 1 alternate, 2 once), in
f32, in this order:

```
sp = clamp(speed, -4, 4)
s  = clock * sp + offset                          // seconds on the playhead
u  = s * loop_rate                                // loops
p  = mode == 1 ? 1 - abs(1 - 2 * fract(u * 0.5))
   : mode == 2 ? clamp(u, 0, 1)
   :             fract(u)                         // fract(x) = x - floor(x)
f  = clamp(int(floor(p * frame_count)), 0, frame_count - 1)
```

and draws the frame record at `frame_texel + f`. The integer clamp keeps even a
NaN or infinite playhead inside the entry; the CPU twins (`frameAt`) pick frame
0 whenever `u` is not finite. Speed 0 holds the frame at `offset`; `once` shows
frame 0 while `s < 0` and holds the last frame once `s` reaches one loop.

The clock is `t − 4096·floor(t / 4096)` over seconds since the plugin's first
clock read (natively) or page load (JS), so it wraps about every 68 minutes.

The baker samples frame `i` at Lottie time `ip + i·fr / fps`, with
`frame_count = max(1, round((op − ip) / fr · fps))`. A marker `{cm, tm, dr}`
becomes an entry of `max(1, round(dr / fr · fps))` frames starting at frame
`round((tm − ip) / fr · fps)` of its animation, clipped to the animation.

## Coverage

For each op whose bounding box the pixel is within a pixel of, the shader maps
the pixel into local units, picks its horizontal and vertical band, and walks
each band's list from the sample outward, casting the positive ray (toward +x or
+y) or, below the split, the negative one. Each ray sums the signed crossings of
its curves, weighted by closeness, and stops at the first curve wholly more than
half a pixel behind it; the two rays blend as in Slug (Lengyel, JCGT 2017).
Every loop bound, index and texel row is clamped, so malformed texels can
neither read outside the texture nor loop without bound.

## Recoloring

For a slot-1 (primary) or slot-2 (secondary) solid paint with authored
premultiplied color `c` and recolor `o` (premultiplied, alpha `s` = strength),
the drawn color is `c` when `s = 0`, else `(mix(c.rgb / c.a, o.rgb / s, s) ·
c.a, c.a)`: the hue moves toward the recolor while the authored alpha, and so
the shape's translucency, stays. `icon-color` is the primary recolor; M1 passes
`(0, 0, 0, 0)` as the secondary, so secondary paints draw as authored.
