// Writes the shared catalog fixtures (../../fixtures/catalog): small valid
// catalogs, malformed variants of one of them, timing samples, and
// manifest.json, which pairs every file with what the catalog twins must
// report. Both twins' tests read the same files: each valid catalog's
// model, shader defines and header block; each timing sample's frame; and
// each malformed file's exact message.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { type AnimationMode, Catalog, frameAt } from "../../js/src/catalog.ts";
import { pluginRoot, type SyncOptions, syncFile } from "./emit.ts";
import {
  type AnimationInput,
  type CatalogInput,
  type Contour,
  type FrameInput,
  type OpInput,
  type PaintInput,
  type Point,
  packCatalog,
  polygon,
} from "./pack.ts";

export const fixturesDir = join(pluginRoot, "fixtures", "catalog");

type Rgba = readonly [number, number, number, number];

/**
 * A circle of `n` quadratic arcs, each through two points on the circle
 * with its control point where their tangents meet.
 */
export function circle(cx: number, cy: number, r: number, n = 16): Contour {
  const step = (2 * Math.PI) / n;
  const reach = r / Math.cos(step / 2);
  return Array.from({ length: n }, (_, k) => ({
    on: [cx + r * Math.cos(k * step), cy + r * Math.sin(k * step)] as Point,
    ctrl: [
      cx + reach * Math.cos((k + 0.5) * step),
      cy + reach * Math.sin((k + 0.5) * step),
    ] as Point,
  }));
}

export function rect(x0: number, y0: number, x1: number, y1: number): Contour {
  return polygon([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
}

/** A star of `points` tips between radii `inner` and `outer`. */
export function star(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  points: number,
): Contour {
  return polygon(
    Array.from({ length: 2 * points }, (_, k): Point => {
      const r = k % 2 === 0 ? outer : inner;
      const a = (k * Math.PI) / points - Math.PI / 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    }),
  );
}

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/** The bounds of a contour list's on and control points. */
function bounds(
  contours: readonly Contour[],
): [number, number, number, number] {
  let box: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const contour of contours) {
    for (const { on, ctrl } of contour) {
      for (const [x, y] of [on, ctrl]) {
        box = [
          Math.min(box[0], x),
          Math.min(box[1], y),
          Math.max(box[2], x),
          Math.max(box[3], y),
        ];
      }
    }
  }
  return box;
}

function solid(color: Rgba, slot: 0 | 1 | 2 = 0): PaintInput {
  return { kind: "solid", color, slot };
}

/** An op drawing shape `index` in canvas space (identity affine). */
function draw(
  shapes: readonly { contours: readonly Contour[] }[],
  index: number,
  paint: PaintInput,
  fillRule: "nonzero" | "evenodd" = "nonzero",
): OpInput {
  const shape = shapes[index];
  if (!shape) throw new Error(`no shape ${index}`);
  return {
    bbox: bounds(shape.contours),
    affine: IDENTITY,
    shape: index,
    fillRule,
    paint,
  };
}

function animation(
  name: string,
  frames: FrameInput[],
  extra: Partial<AnimationInput> = {},
): AnimationInput {
  return {
    name,
    canvas: [32, 32],
    box: [0, 0, 32, 32],
    displayPx: 32,
    fps: 60,
    frames,
    ...extra,
  };
}

/** The color of frame f of the timing fixture: its index in 2 bits per channel. */
export function frameColor(f: number): Rgba {
  return [(f & 3) / 3, ((f >> 2) & 3) / 3, ((f >> 4) & 3) / 3, 1];
}

/** The rigid arrow of the `affine` fixture, drawn turned and scaled. */
function affineFixture(): CatalogInput {
  const arrow = polygon([
    [-5, -1.5],
    [1, -1.5],
    [1, -4],
    [5, 0],
    [1, 4],
    [1, 1.5],
    [-5, 1.5],
  ]);
  const scale = 1.5;
  const frames = [0, 30, 75, 160].map((degrees): FrameInput => {
    const a = (degrees * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    // Local to canvas: translate(16, 16) · rotate(a) · scale; the op stores
    // the inverse, canvas to local.
    const toCanvas = (p: Point): Point => [
      16 + scale * (c * p[0] - s * p[1]),
      16 + scale * (s * p[0] + c * p[1]),
    ];
    const box = bounds([
      arrow.map(({ on, ctrl }) => ({ on: toCanvas(on), ctrl: toCanvas(ctrl) })),
    ]);
    const inv = 1 / scale;
    return {
      ops: [
        {
          bbox: box,
          affine: [
            c * inv,
            s * inv,
            -s * inv,
            c * inv,
            -(c * 16 + s * 16) * inv,
            (s * 16 - c * 16) * inv,
          ],
          shape: 0,
          fillRule: "nonzero",
          paint: solid([0.95, 0.55, 0.1, 1], 1),
        },
      ],
    };
  });
  return {
    shapes: [{ contours: [arrow], pxPerUnit: (48 / 32) * scale }],
    animations: [animation("arrow", frames, { displayPx: 48 })],
  };
}

export interface ValidFixture {
  readonly name: string;
  readonly input: CatalogInput;
}

/** The valid fixtures, by file name without the extension. */
export function validFixtures(): ValidFixture[] {
  const squareShapes = [{ contours: [rect(2, 2, 14, 14)], pxPerUnit: 1 }];
  const circleShapes = [10, 12].map((r) => ({
    contours: [circle(16, 16, r)],
    pxPerUnit: 2,
  }));
  const ringShapes = [
    { contours: [circle(16, 16, 12), circle(16, 16, 8)], pxPerUnit: 1 },
  ];
  const slotShapes = [
    { contours: [rect(2, 2, 30, 30)], pxPerUnit: 1 },
    { contours: [circle(16, 16, 10)], pxPerUnit: 1 },
    { contours: [star(16, 16, 3, 7, 5)], pxPerUnit: 1 },
  ];
  const gradientShapes = [
    { contours: [rect(4, 6, 28, 26)], pxPerUnit: 1.5 },
    { contours: [circle(16, 16, 12)], pxPerUnit: 1.5 },
  ];
  const linear: PaintInput = {
    kind: "linear",
    from: [4, 10],
    to: [28, 22],
    stops: [
      { offset: 0, color: [0.9, 0.2, 0.1, 1] },
      { offset: 0.4, color: [0.1, 0.8, 0.3, 0.5] },
      { offset: 1, color: [0.2, 0.3, 0.95, 0.8] },
    ],
    opacity: 0.75,
  };
  const radial: PaintInput = {
    kind: "radial",
    from: [14, 14],
    to: [26, 18],
    stops: [
      { offset: 0, color: [1, 1, 0.6, 1] },
      { offset: 0.35, color: [1, 0.6, 0.1, 1] },
      { offset: 0.35, color: [0.8, 0.1, 0.1, 0.9] },
      { offset: 1, color: [0.3, 0, 0.3, 0] },
    ],
    opacity: 1,
  };
  const dedupeShapes = [{ contours: [star(16, 16, 5, 13, 6)], pxPerUnit: 1.5 }];
  const dotShapes = [
    ...[6, 8, 10, 12].map((r) => ({
      contours: [circle(16, 16, r)],
      pxPerUnit: 2,
    })),
    { contours: [rect(3, 25, 29, 30)], pxPerUnit: 2 },
  ];
  const dotFrames = [0, 1, 2, 3].map((k): FrameInput => ({
    ops: [
      draw(dotShapes, k, solid([0.1, 0.4, 0.9, 1], 1)),
      draw(dotShapes, 4, linear),
    ],
  }));
  const frameShapes = [{ contours: [rect(0, 0, 32, 32)], pxPerUnit: 1 }];
  const frames = (count: number): FrameInput[] =>
    Array.from({ length: count }, (_, f) => ({
      ops: [draw(frameShapes, 0, solid(frameColor(f)))],
    }));
  return [
    { name: "empty", input: { shapes: [], animations: [] } },
    {
      name: "square",
      input: {
        shapes: squareShapes,
        animations: [
          animation(
            "square",
            [{ ops: [draw(squareShapes, 0, solid([0.2, 0.4, 0.6, 1]))] }],
            {
              canvas: [16, 16],
              box: [0, 0, 16, 16],
              displayPx: 16,
            },
          ),
        ],
      },
    },
    {
      name: "circle",
      input: {
        shapes: circleShapes,
        animations: [
          animation(
            "circle",
            [0, 1].map((k) => ({
              ops: [draw(circleShapes, k, solid([0.9, 0.1, 0.1, 0.5], 1))],
            })),
            { box: [4, 4, 28, 28], displayPx: 48 },
          ),
        ],
      },
    },
    {
      name: "ring",
      input: {
        shapes: ringShapes,
        animations: [
          animation("ring", [
            {
              ops: [
                draw(ringShapes, 0, solid([0.1, 0.6, 0.3, 0.8]), "evenodd"),
              ],
            },
          ]),
        ],
      },
    },
    {
      name: "slots",
      input: {
        shapes: slotShapes,
        animations: [
          animation("slots", [
            {
              ops: [
                draw(slotShapes, 0, solid([0.95, 0.95, 0.9, 1])),
                draw(slotShapes, 1, solid([0.2, 0.5, 0.9, 0.9], 1)),
                draw(slotShapes, 2, solid([0.9, 0.8, 0.1, 1], 2)),
              ],
            },
          ]),
        ],
      },
    },
    {
      name: "gradient-linear",
      input: {
        shapes: gradientShapes,
        animations: [
          animation("linear", [{ ops: [draw(gradientShapes, 0, linear)] }]),
        ],
      },
    },
    {
      name: "gradient-radial",
      input: {
        shapes: gradientShapes,
        animations: [
          animation("radial", [{ ops: [draw(gradientShapes, 1, radial)] }]),
        ],
      },
    },
    {
      name: "dedupe",
      input: {
        shapes: dedupeShapes,
        animations: [
          animation("a", [
            { ops: [draw(dedupeShapes, 0, solid([0.3, 0.3, 0.8, 1]))] },
            { ops: [draw(dedupeShapes, 0, solid([0.8, 0.3, 0.3, 1]))] },
            { ops: [draw(dedupeShapes, 0, solid([0.3, 0.3, 0.8, 1]))] },
          ]),
          animation("b", [
            { ops: [draw(dedupeShapes, 0, solid([0.1, 0.7, 0.2, 0.6], 1))] },
          ]),
        ],
      },
    },
    {
      name: "markers",
      input: {
        shapes: dotShapes,
        animations: [
          animation("dot", dotFrames, { fps: 30, displayPx: 48 }),
          { name: "dot#half", of: "dot", start: 2, count: 2 },
        ],
      },
    },
    {
      name: "wide",
      input: {
        shapes: squareShapes,
        animations: [
          animation(
            "wide",
            [{ ops: [draw(squareShapes, 0, solid([0.5, 0.5, 0.5, 1]))] }],
            {
              canvas: [16, 16],
              box: [0, 0, 16, 16],
            },
          ),
        ],
        textureWidth: 2048,
      },
    },
    { name: "affine", input: affineFixture() },
    {
      name: "frames",
      input: {
        shapes: frameShapes,
        animations: [
          animation("f1", frames(1), { fps: 1 }),
          animation("f7", frames(7), { fps: 10 }),
          animation("f60", frames(60), { fps: 24 }),
          { name: "f60#mid", of: "f60", start: 20, count: 20 },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Timing samples against frames.mlvc (FORMAT.md "Timing").
// ---------------------------------------------------------------------------

const MODES = ["loop", "alternate", "once"] as const;
type ModeName = (typeof MODES)[number];

/** At most 8 clocks, so a GPU harness renders one image per clock; all f32. */
const SAMPLE_CLOCKS = [
  0, 0.25, 1.25, 7.75, 100.5, 1234.5625, 4095.125, 4095.9375,
];

/** Per clock, the entries, speeds, offsets and modes sampled (rotated per clock). */
const SAMPLE_PLANS: readonly [string, number, number, ModeName][] = [
  ["f7", 1, 0, "loop"],
  ["f60", -1.5, 0.37, "alternate"],
  ["f60#mid", 1, -0.4, "once"],
  ["f1", 3, 0, "loop"],
  ["f7", -2, 10.2, "once"],
  ["f60", 7, -3.3, "loop"],
  ["f7", -9, 1.1, "alternate"],
  ["f60#mid", 0.5, 2.05, "loop"],
];

function ulp(s: number): number {
  return 2 ** (Math.floor(Math.log2(Math.max(Math.abs(s), 2 ** -126))) - 23);
}

/**
 * Whether a sample's frame is exact: its playhead in frames lies at least
 * `0.05 + 8 ulp(s) fps` frames from every frame boundary (a GPU may fuse
 * `clock * speed + offset`), or, in once mode, well outside the one loop.
 */
function exact(
  entry: { fps: number; frameCount: number; loopRate: number },
  clock: number,
  speed: number,
  offset: number,
  mode: ModeName,
): boolean {
  const f = Math.fround;
  const sp = Math.min(Math.max(f(speed), -4), 4);
  const s = f(f(f(clock) * sp) + f(offset));
  const u = f(s * entry.loopRate);
  if (!Number.isFinite(u)) return false;
  const margin = 0.05 + 8 * ulp(s) * entry.fps;
  const frames = u * entry.frameCount;
  if (
    mode === "once" &&
    (u < -margin / entry.frameCount || u > 1 + margin / entry.frameCount)
  )
    return true;
  return Math.abs(frames - Math.round(frames)) >= margin;
}

interface Sample {
  file: string;
  entry: string;
  clock: number;
  speed: number | string;
  offset: number | string;
  mode: ModeName;
  frame: number;
  exact: boolean;
}

function number(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

function timingSamples(catalog: Catalog): Sample[] {
  const byName = new Map(catalog.animations.map((a) => [a.name, a]));
  const sample = (
    entry: string,
    clock: number,
    speed: number,
    offset: number,
    mode: ModeName,
    isExact: boolean,
  ): Sample => {
    const a = byName.get(entry);
    if (!a) throw new Error(`frames.mlvc has no ${entry}`);
    return {
      file: "frames.mlvc",
      entry,
      clock,
      speed: number(speed),
      offset: number(offset),
      mode,
      frame: frameAt(
        a,
        clock,
        speed,
        offset,
        MODES.indexOf(mode) as AnimationMode,
      ),
      exact: isExact,
    };
  };
  const samples: Sample[] = [];
  SAMPLE_CLOCKS.forEach((clock, c) => {
    for (let k = 0; k < 6; k++) {
      const plan = SAMPLE_PLANS[(c + k) % SAMPLE_PLANS.length];
      if (!plan) continue;
      const [entry, speed, offset0, mode] = plan;
      const a = byName.get(entry);
      if (!a) throw new Error(`frames.mlvc has no ${entry}`);
      // Nudge the offset off frame boundaries until the sample is exact.
      let offset = offset0;
      for (let tries = 0; !exact(a, clock, speed, offset, mode); tries++) {
        if (tries > 100)
          throw new Error(
            `no exact sample near ${entry} ${clock} ${speed} ${offset0}`,
          );
        offset = Math.fround(offset + 0.0137);
      }
      samples.push(sample(entry, clock, speed, offset, mode, true));
    }
  });
  // Non-finite playheads: the CPU twins pick frame 0; a GPU any frame.
  samples.push(sample("f7", 1.25, Number.NaN, 0, "loop", false));
  samples.push(sample("f60", 7.75, 1, Infinity, "alternate", false));
  samples.push(sample("f7", 100.5, -1, -Infinity, "loop", false));
  samples.push(sample("f60#mid", 0.25, 1, Number.NaN, "once", false));
  return samples;
}

// ---------------------------------------------------------------------------
// Malformed variants of `markers`, each breaking one rule.
// ---------------------------------------------------------------------------

interface Malformed {
  readonly file: string;
  readonly message: string;
  readonly bytes: Uint8Array;
}

function malformedFixtures(base: Uint8Array): Malformed[] {
  const out: Malformed[] = [];
  const catalog = Catalog.parse(base);
  const header = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const size = base.length;
  const count = catalog.texelCount;
  const width = catalog.textureWidth;
  const height = catalog.textureHeight;
  const animationsOffset = header.getUint32(32, true);
  const namesOffset = header.getUint32(36, true);
  const namesSize = header.getUint32(40, true);
  const texelsOffset = header.getUint32(44, true);
  const record = (i: number): number => animationsOffset + 64 * i;
  const t = catalog.texels;
  const texel = (i: number, c: number): number => t[4 * i + c] ?? NaN;
  const dot = catalog.animations[0];
  if (!dot || catalog.animations[1]?.name !== "dot#half")
    throw new Error("markers changed");

  // The records the deep variants patch: frame 0's two ops, op 0's circle,
  // op 1's rectangle and gradient.
  const frame = dot.frameTexel;
  const ops = texel(frame, 1);
  const op1 = ops + 4;
  const circleShape = texel(ops + 2, 2);
  const g = texel(op1 + 3, 0);
  const stops = texel(op1 + 3, 1);
  const hBand0 = circleShape + 2;
  const listTexel = texel(hBand0, 2);
  const listCount = texel(hBand0, 1);
  const hCount = texel(circleShape, 0);
  if (!(listCount >= 3 && hCount > 1))
    throw new Error("markers' circle bands changed");

  type Patch = (view: DataView, bytes: Uint8Array) => Uint8Array | void;
  const variant = (file: string, message: string, patch: Patch): void => {
    const bytes = base.slice();
    const patched = patch(new DataView(bytes.buffer), bytes) ?? bytes;
    out.push({ file: `${file}.mlvc`, message, bytes: patched });
  };
  const u32 =
    (at: number, value: number): Patch =>
    (view) =>
      view.setUint32(at, value, true);
  const f32 =
    (at: number, value: number): Patch =>
    (view) =>
      view.setFloat32(at, value, true);
  const setTexel = (i: number, c: number, value: number): Patch =>
    f32(texelsOffset + 16 * i + 4 * c, value);

  // Header.
  variant(
    "truncated-header",
    "header: the file is 40 bytes, shorter than the 64-byte header",
    (_, b) => b.slice(0, 40),
  );
  variant("bad-magic", "magic: not an .mlvc catalog", (_, b) => {
    b[0] = 0x58;
  });
  variant(
    "version-1",
    "unsupported catalog version 1; rebake it with the M1 baker",
    u32(8, 1),
  );
  variant("version-3", "unsupported catalog version 3", u32(8, 3));
  variant("bad-flags", "flags: got 1, expected 0", u32(28, 1));
  variant(
    "too-many-animations",
    "animation_count: got 511, expected at most 510",
    u32(12, 511),
  );
  variant(
    "bad-texture-width",
    "texture_width: got 512, expected 1024 or 2048",
    u32(16, 512),
  );
  variant(
    "texture-too-small",
    "texel_count: got 3000000, more than the 2097152 texels of a 1024-wide texture with 2048 rows",
    u32(24, 3000000),
  );
  variant(
    "bad-texture-height",
    `texture_height: got ${height + 1}, expected ${height} for ${count} texels ${width} wide`,
    u32(20, height + 1),
  );
  variant(
    "misaligned-animations",
    "animations_offset: got 72, expected a multiple of 16",
    u32(32, 72),
  );
  variant(
    "animations-into-header",
    "animations_offset: got 48, which points into the header",
    u32(32, 48),
  );
  variant(
    "misaligned-names",
    `names_offset: got ${namesOffset + 4}, expected a multiple of 16`,
    u32(36, namesOffset + 4),
  );
  variant(
    "names-into-header",
    "names_offset: got 0, which points into the header",
    u32(36, 0),
  );
  variant(
    "misaligned-texels",
    `texels_offset: got ${texelsOffset + 8}, expected a multiple of 16`,
    u32(44, texelsOffset + 8),
  );
  variant(
    "texels-into-header",
    "texels_offset: got 32, which points into the header",
    u32(44, 32),
  );
  variant(
    "records-past-texels",
    `animation_count: 100 records of 64 bytes at ${animationsOffset} run past the texel section at ${texelsOffset}`,
    u32(12, 100),
  );
  variant(
    "names-past-texels",
    `names_size: 5000 bytes at ${namesOffset} run past the texel section at ${texelsOffset}`,
    u32(40, 5000),
  );
  variant(
    "truncated-texels",
    `texel_count: ${count} texels of 16 bytes at ${texelsOffset} end at byte ${size}, but the file has ${size - 16} bytes`,
    (_, b) => b.slice(0, size - 16),
  );
  variant(
    "trailing-bytes",
    `texel_count: ${count} texels of 16 bytes at ${texelsOffset} end at byte ${size}, but the file has ${size + 16} bytes`,
    (_, b) => {
      const longer = new Uint8Array(size + 16);
      longer.set(b);
      return longer;
    },
  );

  // Records.
  variant(
    "name-past-names",
    `animation 0: name: bytes 0..5000 run past the ${namesSize}-byte names section`,
    u32(record(0) + 36, 5000),
  );
  variant("empty-name", "animation 0: name: empty", u32(record(0) + 36, 0));
  variant(
    "bad-name",
    "animation 0: name: must match [a-z0-9][a-z0-9_#-]*",
    (_, b) => {
      b[namesOffset] = 0x44; // "Dot"
    },
  );
  variant(
    "reserved-name",
    'animation 1: name: "none" is reserved',
    (view, b) => {
      view.setUint32(record(1) + 36, 4, true);
      b.set(new TextEncoder().encode("none"), namesOffset + 3);
    },
  );
  variant(
    "duplicate-name",
    "animation 1: name: repeats animation 0",
    (view) => {
      view.setUint32(record(1) + 32, 0, true);
      view.setUint32(record(1) + 36, 3, true);
    },
  );
  const boxMessage =
    "box: expected finite x0 < x1 and y0 < y1, each at most 16777216 in magnitude";
  variant(
    "empty-box",
    `animation 1 "dot#half": ${boxMessage}`,
    f32(record(1) + 8, dot.box[0]),
  );
  variant(
    "nan-box",
    `animation 0 "dot": ${boxMessage}`,
    f32(record(0) + 4, Number.NaN),
  );
  variant(
    "huge-box",
    `animation 0 "dot": ${boxMessage}`,
    f32(record(0) + 8, 2 ** 25),
  );
  variant(
    "bad-display-px",
    'animation 0 "dot": display_px: expected a finite number in (0, 16777216]',
    f32(record(0) + 16, 0),
  );
  variant(
    "bad-fps",
    'animation 1 "dot#half": fps: expected a finite number in (0, 16777216]',
    f32(record(1) + 20, Number.NaN),
  );
  variant(
    "zero-frames",
    'animation 0 "dot": frame_count: got 0, expected 1 to 16777215',
    u32(record(0) + 24, 0),
  );
  variant(
    "huge-frame-count",
    'animation 0 "dot": frame_count: got 16777216, expected 1 to 16777215',
    u32(record(0) + 24, 16777216),
  );
  variant(
    "frames-past-texels",
    `animation 1 "dot#half": frame_texel: frames at texels ${count - 1}..${count + 1} run past the ${count} texels`,
    u32(record(1) + 28, count - 1),
  );
  variant(
    "bad-canvas",
    'animation 0 "dot": canvas: expected finite sizes in (0, 16777216]',
    f32(record(0) + 44, -1),
  );

  // Frames and ops.
  const at0 = 'animation 0 "dot": frame 0';
  const op0 = `${at0}: op 0`;
  const op1Path = `${at0}: op 1`;
  variant(
    "too-many-ops",
    `${at0}: op_count: expected an integer from 0 to 64`,
    setTexel(frame, 0, 65),
  );
  variant(
    "fractional-op-count",
    `${at0}: op_count: expected an integer from 0 to 64`,
    setTexel(frame, 0, 0.5),
  );
  variant(
    "bad-op-texel",
    `${at0}: op_texel: expected an integer`,
    setTexel(frame, 1, 1.5),
  );
  variant(
    "ops-past-texels",
    `${at0}: op_texel: ops at texels ${count - 4}..${count + 4} run past the ${count} texels`,
    setTexel(frame, 1, count - 4),
  );
  variant(
    "bad-later-frame",
    'animation 0 "dot": frame 3: op_count: expected an integer from 0 to 64',
    setTexel(frame + 3, 0, -1),
  );
  variant(
    "nan-bbox",
    `${op0}: bbox: expected finite x0 <= x1 and y0 <= y1`,
    setTexel(ops, 2, Infinity),
  );
  variant(
    "inverted-bbox",
    `${op0}: bbox: expected finite x0 <= x1 and y0 <= y1`,
    setTexel(ops, 0, 100),
  );
  variant(
    "nan-linear",
    `${op0}: linear part: expected finite values`,
    setTexel(ops + 1, 1, Number.NaN),
  );
  variant(
    "nan-translation",
    `${op0}: translation: expected finite values`,
    setTexel(ops + 2, 0, Infinity),
  );
  variant(
    "bad-shape-texel",
    `${op0}: shape: expected a texel index`,
    setTexel(ops + 2, 2, count),
  );
  variant(
    "bad-style",
    `${op0}: style: expected an integer made of bits 0 to 4`,
    setTexel(ops + 2, 3, 33),
  );
  variant(
    "fractional-style",
    `${op0}: style: expected an integer made of bits 0 to 4`,
    setTexel(ops + 2, 3, 1.5),
  );
  variant(
    "style-slot-3",
    `${op0}: style: slot 3 is not 0, 1 or 2`,
    setTexel(ops + 2, 3, 3),
  );
  variant(
    "style-kind-3",
    `${op0}: style: paint kind 3 is not 0, 1 or 2`,
    setTexel(ops + 2, 3, 24),
  );
  variant(
    "gradient-slot",
    `${op1Path}: style: a gradient paint must use slot 0`,
    setTexel(op1 + 2, 3, 9),
  );
  variant(
    "bad-color",
    `${op0}: color: expected finite premultiplied values in [0, 1]`,
    setTexel(ops + 3, 0, 1.5),
  );
  variant(
    "nan-color",
    `${op0}: color: expected finite premultiplied values in [0, 1]`,
    setTexel(ops + 3, 3, Number.NaN),
  );

  // Gradients.
  const gp = `${op1Path}: gradient`;
  variant(
    "bad-gradient-texel",
    `${gp}: expected a texel index`,
    setTexel(op1 + 3, 0, count),
  );
  variant(
    "bad-stop-count",
    `${gp}: stop_count: expected an integer from 2 to 8`,
    setTexel(op1 + 3, 1, 9),
  );
  variant(
    "one-stop",
    `${gp}: stop_count: expected an integer from 2 to 8`,
    setTexel(op1 + 3, 1, 1),
  );
  variant(
    "bad-gradient-opacity",
    `${gp}: opacity: expected a number in [0, 1]`,
    setTexel(op1 + 3, 2, 1.5),
  );
  variant(
    "gradient-past-texels",
    `${gp}: records at texels ${count - 2}..${count + 1 + stops} run past the ${count} texels`,
    setTexel(op1 + 3, 0, count - 2),
  );
  variant(
    "nan-gradient-ends",
    `${gp}: endpoints: expected finite values`,
    setTexel(g, 3, Number.NaN),
  );
  variant(
    "bad-gradient-offset",
    `${gp}: offset 1: expected a number in [0, 1]`,
    setTexel(g + 1, 1, 1.5),
  );
  variant(
    "decreasing-offsets",
    `${gp}: offset 1: below offset 0`,
    setTexel(g + 1, 0, 0.5),
  );
  variant(
    "bad-stop-color",
    `${gp}: stop 2: expected a color in [0, 1]`,
    setTexel(g + 5, 1, -0.25),
  );

  // Shapes and bands.
  const sp = `${op0}: shape`;
  const band = `${sp}: horizontal band 0`;
  variant(
    "zero-bands",
    `${sp}: band counts: expected integers from 1 to 16`,
    setTexel(circleShape, 0, 0),
  );
  variant(
    "too-many-bands",
    `${sp}: band counts: expected integers from 1 to 16`,
    setTexel(circleShape, 1, 17),
  );
  // Op 0 names the last texel as its shape, whose band counts then need
  // headers past the end.
  variant(
    "bands-past-texels",
    `${sp}: band headers at texels ${count - 1}..${count + 33} run past the ${count} texels`,
    (view) => {
      view.setFloat32(texelsOffset + 16 * (ops + 2) + 8, count - 1, true);
      view.setFloat32(texelsOffset + 16 * (count - 1), 16, true);
      view.setFloat32(texelsOffset + 16 * (count - 1) + 4, 16, true);
    },
  );
  variant(
    "nan-band-transform",
    `${sp}: band transform: expected finite values`,
    setTexel(circleShape + 1, 2, Number.NaN),
  );
  variant(
    "nan-split",
    `${band}: split: expected a finite number`,
    setTexel(hBand0, 0, Number.NaN),
  );
  variant(
    "band-count-too-large",
    `${band}: count: expected an integer from 0 to 1024`,
    setTexel(hBand0, 1, 1025),
  );
  variant(
    "bad-list-texel",
    `${band}: list_texel: expected a texel index`,
    setTexel(hBand0, 2, count),
  );
  variant(
    "list-past-texels",
    `${band}: list at texels ${count - 1}..${count - 1 + Math.ceil(listCount / 2)} runs past the ${count} texels`,
    setTexel(hBand0, 2, count - 1),
  );
  variant(
    "bad-list-entry",
    `${band}: list entry 1 is not a curve index`,
    setTexel(listTexel, 2, count - 1),
  );
  variant(
    "bad-negative-entry",
    `${band}: list entry 0 (negative ray) is not a curve index`,
    setTexel(listTexel, 1, 1.5),
  );
  variant(
    "nan-vertical-split",
    `${sp}: vertical band 0: split: expected a finite number`,
    setTexel(circleShape + 2 + hCount, 0, Number.NaN),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

/**
 * Formats JSON the way dprint's JSON plugin does with this repo's settings
 * (80 columns, 2 spaces, single line where it fits), so the checked-in
 * manifest passes `mise run check` unchanged.
 */
export function formatJson(
  value: unknown,
  indent = 0,
  prefix = 0,
  comma = false,
): string {
  const flat = oneLine(value);
  if (
    typeof value !== "object" ||
    value === null ||
    indent + prefix + flat.length + (comma ? 1 : 0) <= 80
  ) {
    return flat;
  }
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map(
      (v, i) => pad + formatJson(v, indent + 2, 0, i < value.length - 1),
    );
    return `[\n${items.join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(value);
  const items = entries.map(([k, v], i) => {
    const key = `${JSON.stringify(k)}: `;
    return (
      pad + key + formatJson(v, indent + 2, key.length, i < entries.length - 1)
    );
  });
  return `{\n${items.join(",\n")}\n${close}}`;
}

function oneLine(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`,
    );
    return `{ ${items.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** Every fixture file by name, including manifest.json. */
export function buildFixtures(): Map<string, Uint8Array | string> {
  const files = new Map<string, Uint8Array | string>();
  const catalogs = new Map<string, Catalog>();
  const valid = validFixtures().map(({ name, input }) => {
    const packed = packCatalog(input);
    const file = `${name}.mlvc`;
    files.set(file, packed.bytes);
    const catalog = Catalog.parse(packed.bytes);
    catalogs.set(name, catalog);
    const block = new Float32Array(catalog.headerBlockFloats);
    catalog.writeHeaderBlock(0, block);
    return {
      file,
      texture: [catalog.textureWidth, catalog.textureHeight],
      texel_count: catalog.texelCount,
      defines: catalog.shaderDefines(),
      animations: catalog.animations.map((a) => ({
        name: a.name,
        box: [...a.box],
        display_px: a.displayPx,
        fps: a.fps,
        frame_count: a.frameCount,
        frame_texel: a.frameTexel,
        canvas: [...a.canvas],
        loop_rate: a.loopRate,
      })),
      header_block: Array.from(block),
    };
  });
  const framesCatalog = catalogs.get("frames");
  const base = files.get("markers.mlvc");
  if (!framesCatalog || !(base instanceof Uint8Array))
    throw new Error("missing base fixtures");
  const malformed = malformedFixtures(base);
  for (const { file, bytes } of malformed) files.set(file, bytes);
  const manifest = {
    $comment:
      "Generated by baker/src/fixtures.ts. Do not edit. Both catalog twins test against every entry. In frames.mlvc, frame f of f1, f7 and f60 is one full-box square colored ((f & 3) / 3, ((f >> 2) & 3) / 3, ((f >> 4) & 3) / 3, 1); f60#mid plays f60's frames 20 to 39, so its frame k shows f60's color 20 + k. A sample's frame is within its entry; non-exact samples have non-finite playheads, where the CPU twins pick 0 and a GPU may show any frame of the entry.",
    valid,
    samples: timingSamples(framesCatalog),
    malformed: malformed.map(({ file, message }) => ({ file, message })),
  };
  files.set("manifest.json", `${formatJson(manifest)}\n`);
  return files;
}

/**
 * Writes the fixtures and removes files that are no longer generated.
 * Returns the number of stale files.
 */
export function emitFixtures(options: SyncOptions): number {
  const files = buildFixtures();
  let stale = 0;
  for (const [name, content] of files) {
    if (syncFile(join(fixturesDir, name), content, options)) stale++;
  }
  if (existsSync(fixturesDir)) {
    for (const name of readdirSync(fixturesDir)) {
      if (files.has(name)) continue;
      stale++;
      const path = join(fixturesDir, name);
      if (options.check) {
        console.error(`unexpected: ${relative(process.cwd(), path)}`);
      } else {
        rmSync(path);
        console.log(`removed ${relative(process.cwd(), path)}`);
      }
    }
  }
  return stale;
}

// `node baker/src/fixtures.ts [--check]` writes (or checks) the fixtures alone.
if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale = emitFixtures({ check });
  if (check && stale > 0) {
    console.error(
      "catalog fixtures are stale; run `node baker/src/fixtures.ts`",
    );
    process.exit(1);
  }
}
