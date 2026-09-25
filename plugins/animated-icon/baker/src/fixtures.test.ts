import { describe, expect, it } from "vite-plus/test";

import { Catalog } from "../../js/src/catalog.ts";
import {
  buildFixtures,
  emitFixtures,
  formatJson,
  frameColor,
} from "./fixtures.ts";

describe("formatJson", () => {
  it("keeps what fits in 80 columns, counting the comma, on one line", () => {
    const item = (n: number) => ({ file: "x".repeat(n), error: "e" });
    // 4 spaces + the object is 80 columns only without a trailing comma.
    expect(formatJson({ a: [item(48), item(48)] })).toBe(
      [
        "{",
        '  "a": [',
        "    {",
        `      "file": "${"x".repeat(48)}",`,
        '      "error": "e"',
        "    },",
        `    { "file": "${"x".repeat(48)}", "error": "e" }`,
        "  ]",
        "}",
      ].join("\n"),
    );
    expect(formatJson({ box: [2, 2.5, [], {}] })).toBe(
      '{ "box": [2, 2.5, [], {}] }',
    );
  });
});

describe("fixtures", () => {
  const files = buildFixtures();
  const manifest = JSON.parse(files.get("manifest.json") as string) as {
    valid: { file: string }[];
    samples: {
      file: string;
      entry: string;
      exact: boolean;
      speed: unknown;
      offset: unknown;
      mode: string;
    }[];
    malformed: { file: string; message: string }[];
  };

  it("are the files on disk, and build the same twice", () => {
    expect(emitFixtures({ check: true })).toBe(0);
    const again = buildFixtures();
    expect([...again.keys()]).toEqual([...files.keys()]);
    for (const [name, content] of files)
      expect(again.get(name), name).toEqual(content);
  });

  it("list every generated catalog in the manifest", () => {
    const listed = [...manifest.valid, ...manifest.malformed].map(
      (f) => f.file,
    );
    const catalogs = [...files.keys()].filter((name) => name.endsWith(".mlvc"));
    expect(listed.sort()).toEqual(catalogs.sort());
  });

  it("break exactly the rule their message names", () => {
    for (const { file, message } of manifest.malformed) {
      const bytes = files.get(file) as Uint8Array;
      expect(() => Catalog.parse(bytes), file).toThrow(message);
    }
    for (const { file } of manifest.valid) {
      expect(() => Catalog.parse(files.get(file) as Uint8Array)).not.toThrow();
    }
  });

  it("sample every mode, speed and clock case the contract lists", () => {
    const { samples } = manifest;
    expect(new Set(samples.map((s) => s.mode))).toEqual(
      new Set(["loop", "alternate", "once"]),
    );
    const exact = samples.filter((s) => s.exact);
    expect(exact.some((s) => (s.speed as number) < 0)).toBe(true);
    expect(exact.some((s) => Math.abs(s.speed as number) > 4)).toBe(true);
    expect(exact.some((s) => (s.offset as number) < 0)).toBe(true);
    expect(exact.some((s) => s.entry.includes("#"))).toBe(true);
    const inexact = samples
      .filter((s) => !s.exact)
      .map((s) => [s.speed, s.offset, s.mode]);
    expect(inexact).toContainEqual(["NaN", 0, "loop"]);
    expect(inexact).toContainEqual([1, "Infinity", "alternate"]);
    expect(inexact).toContainEqual([-1, "-Infinity", "loop"]);
    expect(inexact).toContainEqual([1, "NaN", "once"]);
  });

  it("color every timing frame by its index", () => {
    const frames = Catalog.parse(files.get("frames.mlvc") as Uint8Array);
    const f60 = frames.animations.find((a) => a.name === "f60");
    expect(f60?.frameCount).toBe(60);
    const colors = new Set<string>();
    for (let f = 0; f < 60; f++) {
      const record = frames.texels.subarray(
        4 * ((f60?.frameTexel ?? 0) + f),
        4 * ((f60?.frameTexel ?? 0) + f) + 4,
      );
      const ops = record[1] ?? 0;
      const paint = Array.from(
        frames.texels.subarray(4 * (ops + 3), 4 * (ops + 4)),
      );
      expect(paint).toEqual(frameColor(f).map((v) => Math.fround(v)));
      colors.add(paint.join());
    }
    expect(colors.size).toBe(60);
  });
});
