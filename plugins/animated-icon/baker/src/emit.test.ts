import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { catalogModule, noticeText, syncFile } from "./emit.ts";

describe("catalogModule", () => {
  it("carries the catalog as a base64 default export", () => {
    const bytes = new Uint8Array([77, 76, 86, 0, 255]);
    const text = catalogModule(bytes);
    expect(text.startsWith("// Generated from catalog/demo.mlvc")).toBe(true);
    const match = /^export default "([A-Za-z0-9+/=]*)";\n$/m.exec(text);
    expect(match).not.toBeNull();
    expect(new Uint8Array(Buffer.from(match?.[1] ?? "", "base64"))).toEqual(
      bytes,
    );
    expect(text).not.toContain("/*!");
  });

  it("carries the license notices in a legal comment", () => {
    const text = catalogModule(new Uint8Array([1]), [
      {
        credits: ["sun: Suns by Someone", "moon: Suns by Someone"],
        text: "MIT License\n\nCopyright (c) Someone",
      },
    ]);
    expect(text.split("\n").slice(0, 9)).toEqual([
      "// Generated from catalog/demo.mlvc by baker/src/cli.ts. Do not edit.",
      "/*!",
      " * The catalog below contains data derived from:",
      " *",
      " * - sun: Suns by Someone",
      " * - moon: Suns by Someone",
      " *",
      " * MIT License",
      " *",
    ]);
    expect(text).toContain(" * Copyright (c) Someone\n */\nexport default ");
    expect(() =>
      catalogModule(new Uint8Array([1]), [{ credits: [], text: "a */ b" }]),
    ).toThrow(/contains \*\//);
  });
});

describe("catalogModule's source", () => {
  it("names the catalog file it mirrors", () => {
    expect(
      catalogModule(new Uint8Array([1]), [], "catalog/other.mlvc"),
    ).toMatch(
      /^\/\/ Generated from catalog\/other\.mlvc by baker\/src\/cli\.ts\. Do not edit\.\n/,
    );
  });
});

describe("noticeText", () => {
  it("lists the credits and the license texts in plain text", () => {
    expect(
      noticeText(
        [
          {
            credits: ["sun: Suns by Someone"],
            text: "MIT License\n\nCopyright (c) Someone",
          },
          { credits: ["moon: Moons"], text: "BSD" },
        ],
        "catalog/weather.mlvc",
      ),
    ).toBe(
      [
        "catalog/weather.mlvc contains data derived from:",
        "",
        "- sun: Suns by Someone",
        "",
        "MIT License",
        "",
        "Copyright (c) Someone",
        "",
        "- moon: Moons",
        "",
        "BSD",
        "",
      ].join("\n"),
    );
    expect(noticeText([], "a.mlvc")).toBe(
      "a.mlvc contains no third-party data.\n",
    );
  });
});

describe("syncFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "animated-icon-baker-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports stale files and writes them only outside check mode", () => {
    const path = join(dir, "nested", "out.txt");
    expect(syncFile(path, "one", { check: true })).toBe(true);
    expect(() => readFileSync(path)).toThrow();
    expect(syncFile(path, "one", { check: false })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("one");
    expect(syncFile(path, "one", { check: true })).toBe(false);
    expect(syncFile(path, new Uint8Array([1, 2]), { check: true })).toBe(true);
  });
});
