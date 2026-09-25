// Reader for the `.mlvc` vector flipbook catalog, version 2
// (../../catalog/FORMAT.md). Twin of ../../native/src/catalog.zig: both
// reject malformed catalogs with the same messages, write the same header
// block and shader defines, and pick the same frames, checked against the
// shared fixtures in ../../fixtures/catalog.

/** The 8 magic bytes, `MLVCAT\0\0`. */
const MAGIC = "MLVCAT\0\0";
export const VERSION = 2;
export const MAX_ANIMATIONS = 510;
/** Seconds after which the animation clock wraps to 0. */
export const CLOCK_PERIOD = 4096;
const MAX_OPS = 64;
const MAX_BANDS = 16;
const MAX_BAND_ENTRIES = 1024;
const MAX_STOPS = 8;
const MAX_TEXTURE_SIZE = 2048;
const HEADER_BYTES = 64;
const RECORD_BYTES = 64;
const TEXEL_BYTES = 16;
/**
 * Integer fields stay below it, where f32 is exact, and float record fields
 * stay at or below it in magnitude.
 */
const MAX_MAGNITUDE = 16777216;
const NAME_PATTERN = "[a-z0-9][a-z0-9_#-]*";

/** 0 loop, 1 alternate, 2 once: the icon-animation-mode values. */
export type AnimationMode = 0 | 1 | 2;

/** One animation record; index `i` is enum index `i + 1`. */
export interface CatalogAnimation {
  readonly name: string;
  /** Anchor box `x0, y0, x1, y1` in canvas pixels (y down). */
  readonly box: readonly [number, number, number, number];
  /** Logical pixels of the box's longer side at `icon-size` 1. */
  readonly displayPx: number;
  readonly fps: number;
  readonly frameCount: number;
  /** Texel of the animation's first frame record. */
  readonly frameTexel: number;
  /** Lottie canvas width and height in canvas pixels. */
  readonly canvas: readonly [number, number];
  /** Loops per second on the playhead: `Math.fround(fps / frameCount)`. */
  readonly loopRate: number;
}

/** A malformed catalog; the message names the offending field. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

const f32 = Math.fround;

/**
 * The frame an animation shows (FORMAT.md "Timing"), in f32 as the vertex
 * shader computes it, but never fused: `clock` in seconds on the plugin's
 * wrapped clock, `speed` and `offset` the icon-animation-speed and -offset
 * values. Returns 0 when the playhead is not finite.
 */
export function frameAt(
  animation: CatalogAnimation,
  clock: number,
  speed: number,
  offset: number,
  mode: AnimationMode,
): number {
  // A clamp that lets NaN through, as the GPU may.
  const sf = f32(speed);
  const sp = sf < -4 ? -4 : sf > 4 ? 4 : sf;
  const s = f32(f32(f32(clock) * sp) + f32(offset));
  const u = f32(s * animation.loopRate);
  if (!Number.isFinite(u)) return 0;
  const fract = (x: number): number => f32(x - Math.floor(x));
  const p =
    mode === 1
      ? f32(1 - Math.abs(f32(1 - 2 * fract(f32(u * 0.5)))))
      : mode === 2
        ? Math.min(Math.max(u, 0), 1)
        : fract(u);
  const count = animation.frameCount;
  const frame = Math.floor(f32(p * count));
  return Math.min(Math.max(frame, 0), count - 1);
}

/**
 * Wraps seconds onto the animation clock, `[0, 4096)`: `t - 4096 *
 * floor(t / 4096)` in double precision, 0 for a non-finite `t` or when
 * rounding reaches 4096.
 */
export function wrapClock(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const wrapped = seconds - CLOCK_PERIOD * Math.floor(seconds / CLOCK_PERIOD);
  return wrapped >= 0 && wrapped < CLOCK_PERIOD ? wrapped : 0;
}

/**
 * A parsed and validated catalog. It copies what it needs from the source
 * bytes, so the catalog does not keep them alive.
 */
export class Catalog {
  /** Records in enum order: index `i` is enum value `i + 1`. */
  readonly animations: readonly CatalogAnimation[];
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly texelCount: number;
  /** log2 of textureWidth: 10 or 11. */
  readonly artShift: number;
  /**
   * The `u_art` texture, textureWidth × textureHeight RGBA32F texels: the
   * texel section, then zeros. Upload it as is.
   */
  readonly texture: Float32Array;
  /** The texel section: texture.subarray(0, 4 * texelCount). */
  readonly texels: Float32Array;
  /** Floats of the IconCatalogUBO block: 4 + 8 per entry, `none` included. */
  readonly headerBlockFloats: number;

  private constructor(parts: CatalogParts) {
    this.animations = parts.animations;
    this.textureWidth = parts.textureWidth;
    this.textureHeight = parts.textureHeight;
    this.texelCount = parts.texelCount;
    this.artShift = parts.textureWidth === 2048 ? 11 : 10;
    this.texture = parts.texture;
    this.texels = parts.texture.subarray(0, 4 * parts.texelCount);
    this.headerBlockFloats = 4 + 8 * (parts.animations.length + 1);
  }

  /** Parses and validates a catalog; throws a CatalogError when malformed. */
  static parse(bytes: Uint8Array): Catalog {
    return new Catalog(parseCatalog(bytes));
  }

  /** Parses a base64-encoded catalog, as in ./generated/catalog.ts. */
  static fromBase64(base64: string): Catalog {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Catalog.parse(bytes);
  }

  /** The `icon-animation` enum values: `"none"`, then every name in order. */
  enumValues(): string[] {
    return ["none", ...this.animations.map((a) => a.name)];
  }

  /**
   * Writes the IconCatalogUBO block (FORMAT.md "Header block"): the clock,
   * then per entry its box and `(display_px, loop_rate, frame_count,
   * frame_texel)`, with entry 0 (`none`) all zero. A clock outside
   * `[0, 4096)` after f32 rounding, such as 4096 itself, is written as 0.
   */
  writeHeaderBlock(clock: number, out: Float32Array): void {
    if (out.length !== this.headerBlockFloats) {
      throw new RangeError(
        `writeHeaderBlock needs ${this.headerBlockFloats} floats, got ${out.length}`,
      );
    }
    out.fill(0);
    const c = f32(clock);
    out[0] = c >= 0 && c < CLOCK_PERIOD ? c : 0;
    this.animations.forEach((a, i) => {
      out.set(a.box, 12 + 8 * i);
      out.set(
        [a.displayPx, a.loopRate, a.frameCount, a.frameTexel],
        16 + 8 * i,
      );
    });
  }

  /**
   * The defines every shader stage starts with: the entry count (`none`
   * included), log2 of the texture width and the texture's rows.
   */
  shaderDefines(): string {
    return (
      `#define ICON_ENTRY_COUNT ${this.animations.length + 1}\n` +
      `#define ICON_ART_SHIFT ${this.artShift}\n` +
      `#define ICON_ART_ROWS ${this.textureHeight}\n`
    );
  }
}

/**
 * Loads and parses a catalog from a URL (fetched), a fetch Response or the
 * bytes themselves. Rejects with a CatalogError on an HTTP error or a
 * malformed catalog.
 */
export async function loadCatalog(
  source: string | URL | ArrayBuffer | Uint8Array | Response,
): Promise<Catalog> {
  if (source instanceof Uint8Array) return Catalog.parse(source);
  if (source instanceof ArrayBuffer)
    return Catalog.parse(new Uint8Array(source));
  const response = source instanceof Response ? source : await fetch(source);
  if (!response.ok) {
    const url =
      response.url || (source instanceof Response ? "" : String(source));
    throw new CatalogError(
      `failed to load the catalog${url ? ` ${url}` : ""}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  return Catalog.parse(new Uint8Array(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Parsing. The checks and their order mirror catalog.zig exactly: the first
// failing check names the error.
// ---------------------------------------------------------------------------

interface CatalogParts {
  animations: CatalogAnimation[];
  textureWidth: number;
  textureHeight: number;
  texelCount: number;
  texture: Float32Array;
}

function fail(message: string): never {
  throw new CatalogError(message);
}

/** An integer field: finite, whole, in `[0, 2^24)`. */
function isInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < MAX_MAGNITUDE;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_MAGNITUDE;
}

function isUnit(value: number): boolean {
  return value >= 0 && value <= 1;
}

function isNameByte(byte: number, first: boolean): boolean {
  const lower = byte >= 0x61 && byte <= 0x7a;
  const digit = byte >= 0x30 && byte <= 0x39;
  if (first) return lower || digit;
  // `_`, `#` and `-`.
  return lower || digit || byte === 0x5f || byte === 0x23 || byte === 0x2d;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function parseCatalog(bytes: Uint8Array): CatalogParts {
  const size = bytes.length;
  if (size < HEADER_BYTES) {
    fail(
      `header: the file is ${size} bytes, shorter than the ${HEADER_BYTES}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const readF32 = (offset: number): number => view.getFloat32(offset, true);

  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) fail("magic: not an .mlvc catalog");
  }
  const version = u32(8);
  if (version === 1)
    fail("unsupported catalog version 1; rebake it with the M1 baker");
  if (version !== VERSION) fail(`unsupported catalog version ${version}`);
  const flags = u32(28);
  if (flags !== 0) fail(`flags: got ${flags}, expected 0`);
  const animationCount = u32(12);
  if (animationCount > MAX_ANIMATIONS) {
    fail(
      `animation_count: got ${animationCount}, expected at most ${MAX_ANIMATIONS}`,
    );
  }
  const width = u32(16);
  if (width !== 1024 && width !== 2048) {
    fail(`texture_width: got ${width}, expected 1024 or 2048`);
  }
  const height = u32(20);
  const texelCount = u32(24);
  if (texelCount > width * MAX_TEXTURE_SIZE) {
    fail(
      `texel_count: got ${texelCount}, more than the ${width * MAX_TEXTURE_SIZE} texels of a ${width}-wide texture with ${MAX_TEXTURE_SIZE} rows`,
    );
  }
  const rows = Math.max(1, Math.ceil(texelCount / width));
  if (height !== rows) {
    fail(
      `texture_height: got ${height}, expected ${rows} for ${texelCount} texels ${width} wide`,
    );
  }
  const section = (field: string, offset: number): number => {
    const value = u32(offset);
    if (value % 16 !== 0)
      fail(`${field}: got ${value}, expected a multiple of 16`);
    if (value < HEADER_BYTES)
      fail(`${field}: got ${value}, which points into the header`);
    return value;
  };
  const animationsOffset = section("animations_offset", 32);
  const namesOffset = section("names_offset", 36);
  const namesSize = u32(40);
  const texelsOffset = section("texels_offset", 44);
  if (animationsOffset + animationCount * RECORD_BYTES > texelsOffset) {
    fail(
      `animation_count: ${animationCount} records of ${RECORD_BYTES} bytes at ${animationsOffset} run past the texel section at ${texelsOffset}`,
    );
  }
  if (namesOffset + namesSize > texelsOffset) {
    fail(
      `names_size: ${namesSize} bytes at ${namesOffset} run past the texel section at ${texelsOffset}`,
    );
  }
  const texelsEnd = texelsOffset + texelCount * TEXEL_BYTES;
  if (texelsEnd !== size) {
    fail(
      `texel_count: ${texelCount} texels of ${TEXEL_BYTES} bytes at ${texelsOffset} end at byte ${texelsEnd}, but the file has ${size} bytes`,
    );
  }

  const animations: CatalogAnimation[] = [];
  for (let i = 0; i < animationCount; i++) {
    const record = animationsOffset + i * RECORD_BYTES;
    const nameOffset = u32(record + 32);
    const nameLength = u32(record + 36);
    if (nameOffset + nameLength > namesSize) {
      fail(
        `animation ${i}: name: bytes ${nameOffset}..${nameOffset + nameLength} run past the ${namesSize}-byte names section`,
      );
    }
    if (nameLength === 0) fail(`animation ${i}: name: empty`);
    const nameBytes = bytes.subarray(
      namesOffset + nameOffset,
      namesOffset + nameOffset + nameLength,
    );
    nameBytes.forEach((byte, k) => {
      if (!isNameByte(byte, k === 0))
        fail(`animation ${i}: name: must match ${NAME_PATTERN}`);
    });
    const name = String.fromCharCode(...nameBytes);
    if (name === "none") fail(`animation ${i}: name: "none" is reserved`);
    const repeated = animations.findIndex((a) => a.name === name);
    if (repeated >= 0)
      fail(`animation ${i}: name: repeats animation ${repeated}`);

    const path = `animation ${i} "${name}"`;
    const box = [
      readF32(record),
      readF32(record + 4),
      readF32(record + 8),
      readF32(record + 12),
    ] as const;
    const [x0, y0, x1, y1] = box;
    if (
      !(box.every((v) => Math.abs(v) <= MAX_MAGNITUDE) && x0 < x1 && y0 < y1)
    ) {
      fail(
        `${path}: box: expected finite x0 < x1 and y0 < y1, each at most ${MAX_MAGNITUDE} in magnitude`,
      );
    }
    const displayPx = readF32(record + 16);
    if (!isPositive(displayPx)) {
      fail(
        `${path}: display_px: expected a finite number in (0, ${MAX_MAGNITUDE}]`,
      );
    }
    const fps = readF32(record + 20);
    if (!isPositive(fps))
      fail(`${path}: fps: expected a finite number in (0, ${MAX_MAGNITUDE}]`);
    const frameCount = u32(record + 24);
    if (frameCount < 1 || frameCount >= MAX_MAGNITUDE) {
      fail(
        `${path}: frame_count: got ${frameCount}, expected 1 to ${MAX_MAGNITUDE - 1}`,
      );
    }
    const frameTexel = u32(record + 28);
    if (frameTexel + frameCount > texelCount) {
      fail(
        `${path}: frame_texel: frames at texels ${frameTexel}..${frameTexel + frameCount} run past the ${texelCount} texels`,
      );
    }
    const canvas = [readF32(record + 40), readF32(record + 44)] as const;
    if (!canvas.every(isPositive)) {
      fail(`${path}: canvas: expected finite sizes in (0, ${MAX_MAGNITUDE}]`);
    }
    animations.push({
      name,
      box,
      displayPx,
      fps,
      frameCount,
      frameTexel,
      canvas,
      loopRate: f32(fps / frameCount),
    });
  }

  const texture = new Float32Array(width * height * 4);
  if (LITTLE_ENDIAN) {
    new Uint8Array(texture.buffer).set(bytes.subarray(texelsOffset));
  } else {
    for (let k = 0; k < texelCount * 4; k++)
      texture[k] = readF32(texelsOffset + 4 * k);
  }
  validateTexels(animations, texture, texelCount);
  return {
    animations,
    textureWidth: width,
    textureHeight: height,
    texelCount,
    texture,
  };
}

// Bits of the per-texel visit marks: each frame record, op and shape is
// validated once however many records name it. A gradient's mark is the
// largest stop count it was validated for (those checks cover every
// smaller count too).
const FRAME_DONE = 1;
const OP_DONE = 2;
const SHAPE_DONE = 4;
const STOPS_SHIFT = 4;

/**
 * Checks every texel record reachable from the animations, depth first:
 * frame records, their ops, each op's paint and shape. After this, no valid
 * catalog makes the shader read past the texel section.
 */
function validateTexels(
  animations: readonly CatalogAnimation[],
  t: Float32Array,
  count: number,
): void {
  const marks = new Uint8Array(count);
  const texel = (i: number): Float32Array => t.subarray(4 * i, 4 * i + 4);
  const finite = (v: Float32Array): boolean => v.every(Number.isFinite);
  const isIndex = (v: number): boolean => isInteger(v) && v < count;
  const at = (v: Float32Array, k: number): number => v[k] ?? NaN;

  animations.forEach((a, i) => {
    for (let f = 0; f < a.frameCount; f++) {
      const frameIndex = a.frameTexel + f;
      if ((marks[frameIndex] ?? 0) & FRAME_DONE) continue;
      marks[frameIndex] = (marks[frameIndex] ?? 0) | FRAME_DONE;
      const where = `animation ${i} "${a.name}": frame ${f}`;
      const frame = texel(frameIndex);
      const opCount = at(frame, 0);
      if (!(isInteger(opCount) && opCount <= MAX_OPS)) {
        fail(`${where}: op_count: expected an integer from 0 to ${MAX_OPS}`);
      }
      const opTexel = at(frame, 1);
      if (!isInteger(opTexel)) fail(`${where}: op_texel: expected an integer`);
      if (opTexel + 4 * opCount > count) {
        fail(
          `${where}: op_texel: ops at texels ${opTexel}..${opTexel + 4 * opCount} run past the ${count} texels`,
        );
      }
      for (let k = 0; k < opCount; k++) {
        const o = opTexel + 4 * k;
        if ((marks[o] ?? 0) & OP_DONE) continue;
        marks[o] = (marks[o] ?? 0) | OP_DONE;
        validateOp(`${where}: op ${k}`, o);
      }
    }
  });

  function validateOp(where: string, o: number): void {
    const bbox = texel(o);
    if (
      !(
        finite(bbox) &&
        at(bbox, 0) <= at(bbox, 2) &&
        at(bbox, 1) <= at(bbox, 3)
      )
    ) {
      fail(`${where}: bbox: expected finite x0 <= x1 and y0 <= y1`);
    }
    if (!finite(texel(o + 1)))
      fail(`${where}: linear part: expected finite values`);
    const t2 = texel(o + 2);
    if (!(Number.isFinite(at(t2, 0)) && Number.isFinite(at(t2, 1)))) {
      fail(`${where}: translation: expected finite values`);
    }
    const shape = at(t2, 2);
    if (!isIndex(shape)) fail(`${where}: shape: expected a texel index`);
    const style = at(t2, 3);
    if (!(isInteger(style) && style < 32)) {
      fail(`${where}: style: expected an integer made of bits 0 to 4`);
    }
    const slot = style & 3;
    const kind = (style >> 3) & 3;
    if (slot === 3) fail(`${where}: style: slot 3 is not 0, 1 or 2`);
    if (kind === 3) fail(`${where}: style: paint kind 3 is not 0, 1 or 2`);
    if (kind !== 0 && slot !== 0)
      fail(`${where}: style: a gradient paint must use slot 0`);
    const paint = texel(o + 3);
    if (kind === 0) {
      if (!paint.every(isUnit)) {
        fail(`${where}: color: expected finite premultiplied values in [0, 1]`);
      }
    } else {
      validateGradient(`${where}: gradient`, paint);
    }
    if (!((marks[shape] ?? 0) & SHAPE_DONE)) {
      marks[shape] = (marks[shape] ?? 0) | SHAPE_DONE;
      validateShape(`${where}: shape`, shape);
    }
  }

  function validateGradient(where: string, paint: Float32Array): void {
    const g = at(paint, 0);
    if (!isIndex(g)) fail(`${where}: expected a texel index`);
    const stops = at(paint, 1);
    if (!(isInteger(stops) && stops >= 2 && stops <= MAX_STOPS)) {
      fail(`${where}: stop_count: expected an integer from 2 to ${MAX_STOPS}`);
    }
    if (!isUnit(at(paint, 2)))
      fail(`${where}: opacity: expected a number in [0, 1]`);
    if (g + 3 + stops > count) {
      fail(
        `${where}: records at texels ${g}..${g + 3 + stops} run past the ${count} texels`,
      );
    }
    if ((marks[g] ?? 0) >> STOPS_SHIFT >= stops) return;
    marks[g] = ((marks[g] ?? 0) & 15) | (stops << STOPS_SHIFT);
    if (!finite(texel(g))) fail(`${where}: endpoints: expected finite values`);
    for (let k = 0; k < stops; k++) {
      const offset = t[4 * (g + 1) + k] ?? NaN;
      if (!isUnit(offset))
        fail(`${where}: offset ${k}: expected a number in [0, 1]`);
      if (k > 0 && offset < (t[4 * (g + 1) + k - 1] ?? NaN)) {
        fail(`${where}: offset ${k}: below offset ${k - 1}`);
      }
    }
    for (let k = 0; k < stops; k++) {
      if (!texel(g + 3 + k).every(isUnit))
        fail(`${where}: stop ${k}: expected a color in [0, 1]`);
    }
  }

  function validateShape(where: string, s: number): void {
    const s0 = texel(s);
    const h = at(s0, 0);
    const v = at(s0, 1);
    if (
      !(
        isInteger(h) &&
        isInteger(v) &&
        h >= 1 &&
        h <= MAX_BANDS &&
        v >= 1 &&
        v <= MAX_BANDS
      )
    ) {
      fail(`${where}: band counts: expected integers from 1 to ${MAX_BANDS}`);
    }
    if (s + 2 + h + v > count) {
      fail(
        `${where}: band headers at texels ${s}..${s + 2 + h + v} run past the ${count} texels`,
      );
    }
    if (!finite(texel(s + 1)))
      fail(`${where}: band transform: expected finite values`);
    for (let b = 0; b < h + v; b++) {
      const band = `${where}: ${b < h ? `horizontal band ${b}` : `vertical band ${b - h}`}`;
      const header = texel(s + 2 + b);
      if (!Number.isFinite(at(header, 0)))
        fail(`${band}: split: expected a finite number`);
      const entries = at(header, 1);
      if (!(isInteger(entries) && entries <= MAX_BAND_ENTRIES)) {
        fail(
          `${band}: count: expected an integer from 0 to ${MAX_BAND_ENTRIES}`,
        );
      }
      const list = at(header, 2);
      if (!isIndex(list)) fail(`${band}: list_texel: expected a texel index`);
      const listEnd = list + Math.ceil(entries / 2);
      if (listEnd > count) {
        fail(
          `${band}: list at texels ${list}..${listEnd} runs past the ${count} texels`,
        );
      }
      for (let e = 0; e < entries; e++) {
        const base = 4 * (list + (e >> 1)) + 2 * (e & 1);
        if (!isCurve(t[base] ?? NaN))
          fail(`${band}: list entry ${e} is not a curve index`);
        if (!isCurve(t[base + 1] ?? NaN)) {
          fail(`${band}: list entry ${e} (negative ray) is not a curve index`);
        }
      }
    }
  }

  function isCurve(c: number): boolean {
    return isInteger(c) && c + 1 < count;
  }
}
