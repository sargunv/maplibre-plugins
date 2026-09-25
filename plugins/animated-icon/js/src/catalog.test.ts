// Mirrors the tests in ../../native/src/catalog.zig: both twins read the
// shared fixtures in ../../fixtures/catalog, so they cannot drift apart
// unnoticed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  type AnimationMode,
  Catalog,
  CatalogError,
  frameAt,
  loadCatalog,
  wrapClock,
} from "./catalog.ts";
import demoBase64 from "./generated/catalog.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(pluginRoot, "fixtures", "catalog");

interface Manifest {
  valid: {
    file: string;
    texture: [number, number];
    texel_count: number;
    defines: string;
    animations: {
      name: string;
      box: number[];
      display_px: number;
      fps: number;
      frame_count: number;
      frame_texel: number;
      canvas: number[];
      loop_rate: number;
    }[];
    header_block: number[];
  }[];
  samples: {
    file: string;
    entry: string;
    clock: number;
    speed: number | string;
    offset: number | string;
    mode: "loop" | "alternate" | "once";
    frame: number;
    exact: boolean;
  }[];
  malformed: { file: string; message: string }[];
}

const manifest = JSON.parse(
  readFileSync(join(fixturesDir, "manifest.json"), "utf8"),
) as Manifest;

function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

const MODES = ["loop", "alternate", "once"] as const;

describe("shared catalog fixtures", () => {
  it("has the fixtures the contract lists", () => {
    expect(manifest.valid.length).toBeGreaterThanOrEqual(12);
    expect(manifest.malformed.length).toBeGreaterThanOrEqual(35);
    expect(manifest.samples.length).toBeGreaterThanOrEqual(40);
    expect(
      new Set(manifest.samples.map((s) => s.clock)).size,
    ).toBeLessThanOrEqual(8);
  });

  for (const valid of manifest.valid) {
    describe(valid.file, () => {
      const catalog = Catalog.parse(fixture(valid.file));

      it("parses into the manifest's model", () => {
        expect([catalog.textureWidth, catalog.textureHeight]).toEqual(
          valid.texture,
        );
        expect(catalog.texelCount).toBe(valid.texel_count);
        expect(catalog.artShift).toBe(valid.texture[0] === 2048 ? 11 : 10);
        expect(
          catalog.animations.map((a) => ({
            name: a.name,
            box: [...a.box],
            display_px: a.displayPx,
            fps: a.fps,
            frame_count: a.frameCount,
            frame_texel: a.frameTexel,
            canvas: [...a.canvas],
            loop_rate: a.loopRate,
          })),
        ).toEqual(valid.animations);
        expect(catalog.enumValues()).toEqual([
          "none",
          ...valid.animations.map((a) => a.name),
        ]);
      });

      it("prints the shared shader defines", () => {
        expect(catalog.shaderDefines()).toBe(valid.defines);
      });

      it("writes the shared header block", () => {
        const block = new Float32Array(catalog.headerBlockFloats).fill(7);
        catalog.writeHeaderBlock(0, block);
        expect(Array.from(block)).toEqual(valid.header_block);
      });

      it("holds the texel section, then zeros, as the texture", () => {
        const { textureWidth: w, textureHeight: h, texelCount } = catalog;
        expect(catalog.texture.length).toBe(w * h * 4);
        expect(catalog.texels.length).toBe(texelCount * 4);
        expect(catalog.texels.buffer).toBe(catalog.texture.buffer);
        const bytes = fixture(valid.file);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const texelsOffset = view.getUint32(44, true);
        for (let k = 0; k < texelCount * 4; k++) {
          expect(
            Object.is(
              catalog.texture[k],
              view.getFloat32(texelsOffset + 4 * k, true),
            ),
          ).toBe(true);
        }
        expect(
          catalog.texture.subarray(texelCount * 4).every((v) => v === 0),
        ).toBe(true);
      });
    });
  }

  it("picks every sample's frame, non-finite playheads included", () => {
    const catalogs = new Map<string, Catalog>();
    const number = (v: number | string): number =>
      typeof v === "number" ? v : Number(v);
    for (const sample of manifest.samples) {
      let catalog = catalogs.get(sample.file);
      if (!catalog) {
        catalog = Catalog.parse(fixture(sample.file));
        catalogs.set(sample.file, catalog);
      }
      const animation = catalog.animations.find((a) => a.name === sample.entry);
      expect(animation, sample.entry).toBeDefined();
      if (!animation) continue;
      const mode = MODES.indexOf(sample.mode) as AnimationMode;
      expect(
        frameAt(
          animation,
          sample.clock,
          number(sample.speed),
          number(sample.offset),
          mode,
        ),
        JSON.stringify(sample),
      ).toBe(sample.frame);
      if (!sample.exact) expect(sample.frame).toBe(0);
    }
  });

  it("rejects every malformed catalog with the shared message", () => {
    for (const { file, message } of manifest.malformed) {
      let error: unknown;
      try {
        Catalog.parse(fixture(file));
      } catch (e) {
        error = e;
      }
      expect(error, file).toBeInstanceOf(CatalogError);
      expect((error as Error).message, file).toBe(message);
    }
  });
});

describe("Catalog", () => {
  it("rejects version 1 catalogs with the rebake message", () => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("MLVCAT\0\0"));
    new DataView(bytes.buffer).setUint32(8, 1, true);
    expect(() => Catalog.parse(bytes)).toThrow(
      new CatalogError(
        "unsupported catalog version 1; rebake it with the M1 baker",
      ),
    );
  });

  it("copies the bytes it parses", () => {
    const bytes = fixture("square.mlvc");
    const catalog = Catalog.parse(bytes);
    const before = Array.from(catalog.texels);
    bytes.fill(0);
    expect(Array.from(catalog.texels)).toEqual(before);
  });

  it("parses bytes at any offset of a buffer", () => {
    const bytes = fixture("circle.mlvc");
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    const catalog = Catalog.parse(shifted.subarray(3));
    expect(Array.from(catalog.texels)).toEqual(
      Array.from(Catalog.parse(bytes).texels),
    );
  });

  it("writes the clock into the header block, and 0 outside [0, 4096)", () => {
    const catalog = Catalog.parse(fixture("frames.mlvc"));
    const block = new Float32Array(catalog.headerBlockFloats);
    catalog.writeHeaderBlock(1234.5, block);
    expect(block[0]).toBe(1234.5);
    for (const clock of [wrapClock(4095.99999999), 4096, Number.NaN, -1]) {
      catalog.writeHeaderBlock(clock, block);
      expect(block[0]).toBe(0);
    }
    expect(() => catalog.writeHeaderBlock(0, new Float32Array(4))).toThrow(
      RangeError,
    );
  });
});

describe("frameAt", () => {
  const catalog = Catalog.parse(fixture("frames.mlvc"));
  const f7 = catalog.animations[1];

  it("follows the timing rules", () => {
    expect(f7?.name).toBe("f7");
    if (!f7) return;
    expect(f7.loopRate).toBe(Math.fround(10 / 7));
    // 0.35 s at 10 fps is frame 3; speed 0 holds the offset's frame.
    expect(frameAt(f7, 0.35, 1, 0, 0)).toBe(3);
    expect(frameAt(f7, 1000, 0, 0.35, 0)).toBe(3);
    // Speeds clamp to ±4, and negative speeds play backwards.
    expect(frameAt(f7, 0.05, 100, 0, 0)).toBe(frameAt(f7, 0.05, 4, 0, 0));
    expect(frameAt(f7, 0.05, -1, 0, 0)).toBe(6);
    // Once holds frame 0 before the start and the last frame after one loop.
    expect(frameAt(f7, 1, 1, -5, 2)).toBe(0);
    expect(frameAt(f7, 1, 1, 5, 2)).toBe(6);
    // Alternate plays forward, then backward.
    expect(frameAt(f7, 0.65, 1, 0, 1)).toBe(6);
    expect(frameAt(f7, 0.85, 1, 0, 1)).toBe(5);
    // Non-finite playheads pick frame 0.
    expect(frameAt(f7, 1, Number.NaN, 0, 0)).toBe(0);
    expect(frameAt(f7, 1, 1, Infinity, 2)).toBe(0);
    expect(frameAt(f7, 1, 1, -Infinity, 1)).toBe(0);
  });
});

describe("wrapClock", () => {
  it("wraps onto [0, 4096)", () => {
    expect(wrapClock(0)).toBe(0);
    expect(wrapClock(4101)).toBe(5);
    expect(wrapClock(-1)).toBe(4095);
    expect(wrapClock(-1e-20)).toBe(0);
    expect(wrapClock(Number.NaN)).toBe(0);
    expect(wrapClock(Infinity)).toBe(0);
    expect(wrapClock(-Infinity)).toBe(0);
  });
});

describe("loadCatalog", () => {
  const bytes = fixture("markers.mlvc");

  it("parses bytes, buffers and responses", async () => {
    const expected = Catalog.parse(bytes).enumValues();
    expect((await loadCatalog(bytes)).enumValues()).toEqual(expected);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    expect((await loadCatalog(buffer)).enumValues()).toEqual(expected);
    expect((await loadCatalog(new Response(bytes))).enumValues()).toEqual(
      expected,
    );
  });

  it("rejects an HTTP error and a malformed body", async () => {
    await expect(
      loadCatalog(
        new Response("missing", { status: 404, statusText: "Not Found" }),
      ),
    ).rejects.toThrow(
      new CatalogError("failed to load the catalog: HTTP 404 Not Found"),
    );
    await expect(loadCatalog(new Response("not a catalog"))).rejects.toThrow(
      CatalogError,
    );
  });
});

describe("demo catalog", () => {
  const demo = Catalog.fromBase64(demoBase64);

  it("is catalog/demo.mlvc", () => {
    const bytes = new Uint8Array(
      readFileSync(join(pluginRoot, "catalog", "demo.mlvc")),
    );
    expect(Catalog.parse(bytes)).toEqual(demo);
  });

  it("has the stable demo names first", () => {
    expect(demo.enumValues().slice(0, 3)).toEqual(["none", "pulse", "pin"]);
  });
});
