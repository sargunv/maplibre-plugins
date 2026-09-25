import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Catalog } from "../../js/src/catalog.ts";
import type { SyncOptions } from "./emit.ts";
import { comp, el, fl, layer } from "./lottie.testing.ts";
import {
  formatStamps,
  inputsHash,
  outputHash,
  readStamps,
  runBake,
  runCheck,
  STAMPS_FILE,
} from "./stamps.ts";

const base = mkdtempSync(join(tmpdir(), "animated-icon-stamps-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let root = "";
let fixture = "one";
let logs: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Writes the fake fixtures, or counts them stale. */
function fixtures({ check }: SyncOptions): number {
  const path = join(root, "fixtures", "catalog", "fixture.txt");
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === fixture) return 0;
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fixture);
  }
  return 1;
}

const options = () => ({
  root,
  fixtures,
  log: (line: string) => logs.push(line),
});

/** The manifests the last run baked, from its report lines. */
const baked = (): string[] => logs.map((line) => line.split(":")[0] ?? "");

beforeEach(() => {
  root = mkdtempSync(join(base, "plugin-"));
  fixture = "one";
  logs = [];
  write("baker/src/bake.ts", "export {};\n");
  write("baker/src/bake.test.ts", "// tests are not inputs\n");
  write("baker/package.json", "{}\n");
  write("js/src/catalog.ts", "export {};\n");
  write(
    "animations/dot.json",
    JSON.stringify(comp([layer([el(32, 32, 20), fl(0, 0, 0)])], { op: 12 })),
  );
  write("animations/LICENSE", "MIT License\n");
  write(
    "animations/demo.json",
    JSON.stringify({
      output: "../catalog/demo.mlvc",
      js: "../js/src/generated/catalog.ts",
      fps: 10,
      animations: [
        { name: "dot", file: "dot.json", displayPx: 16, box: "canvas" },
      ],
    }),
  );
  write(
    "animations/app.json",
    JSON.stringify({
      output: "../catalog/app.mlvc",
      notice: "../catalog/app.mlvc.LICENSE.txt",
      fps: 10,
      animations: [
        {
          name: "dot",
          file: "dot.json",
          displayPx: 16,
          box: "canvas",
          credit: "Dots",
          license: "LICENSE",
        },
      ],
    }),
  );
  // Manifests without an output are not baked by the default run.
  write(
    "animations/draft.json",
    JSON.stringify({
      animations: [{ name: "x", file: "missing.json", displayPx: 1 }],
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runBake", () => {
  it("bakes every manifest with an output, the fixtures and the stamps", async () => {
    expect(await runBake(options())).toBe(6);
    expect(baked()).toEqual(["animations/app.json", "animations/demo.json"]);
    expect(
      Catalog.parse(
        new Uint8Array(readFileSync(join(root, "catalog/demo.mlvc"))),
      ).enumValues(),
    ).toEqual(["none", "dot"]);
    expect(read("js/src/generated/catalog.ts")).toMatch(
      /^\/\/ Generated from catalog\/demo\.mlvc by baker/,
    );
    expect(read("catalog/app.mlvc.LICENSE.txt")).toBe(
      "catalog/app.mlvc contains data derived from:\n\n- dot: Dots\n\nMIT License\n",
    );
    const stamps = readStamps(root);
    expect(Object.keys(stamps)).toEqual([
      "catalog/app.mlvc",
      "catalog/app.mlvc.LICENSE.txt",
      "catalog/demo.mlvc",
      "fixtures/catalog",
      "js/src/generated/catalog.ts",
    ]);
    expect(stamps["catalog/demo.mlvc"]?.output).toBe(
      outputHash(join(root, "catalog/demo.mlvc")),
    );
    expect(read(STAMPS_FILE)).toBe(formatStamps(stamps));
    // Nothing is stale now: a second run writes nothing.
    logs = [];
    expect(await runBake(options())).toBe(0);
    expect(baked()).toEqual([]);
  });

  it("rebakes only what an input change touches", async () => {
    await runBake(options());
    write(
      "animations/app.json",
      read("animations/app.json").replace('"Dots"', '"Dots by Someone"'),
    );
    logs = [];
    await runBake(options());
    expect(baked()).toEqual(["animations/app.json"]);
    // A license change is an input of the manifests that name it.
    write("animations/LICENSE", "MIT License\n\nCopyright\n");
    logs = [];
    await runBake(options());
    expect(baked()).toEqual(["animations/app.json"]);
    expect(read("catalog/app.mlvc.LICENSE.txt")).toMatch(/Copyright/);
  });

  it("rebakes everything with force, and after a baker change the fixtures too", async () => {
    await runBake(options());
    logs = [];
    await runBake({ ...options(), force: true });
    expect(baked()).toEqual(["animations/app.json", "animations/demo.json"]);
    fixture = "two";
    write("baker/src/bake.ts", "export const changed = 1;\n");
    logs = [];
    await runBake(options());
    expect(baked()).toEqual(["animations/app.json", "animations/demo.json"]);
    expect(read("fixtures/catalog/fixture.txt")).toBe("two");
    // A test file is not an input.
    write("baker/src/bake.test.ts", "// changed\n");
    logs = [];
    expect(await runBake(options())).toBe(0);
  });

  it("restores a hand-edited output", async () => {
    await runBake(options());
    const bytes = read("catalog/app.mlvc.LICENSE.txt");
    write("catalog/app.mlvc.LICENSE.txt", "edited\n");
    logs = [];
    await runBake(options());
    expect(read("catalog/app.mlvc.LICENSE.txt")).toBe(bytes);
  });
});

describe("runCheck", () => {
  it("passes when the stamps match, without baking", async () => {
    await runBake(options());
    logs = [];
    expect(await runCheck(options())).toBe(0);
    expect(baked()).toEqual([]);
    expect(await runCheck({ ...options(), full: true })).toBe(0);
    expect(baked()).toEqual(["animations/app.json", "animations/demo.json"]);
  });

  it("fails on stale inputs, a hand-edited output, a missing output and no stamps", async () => {
    // Four outputs and the fixtures.
    expect(await runCheck(options())).toBe(5);
    await runBake(options());
    write(
      "animations/dot.json",
      read("animations/dot.json").replace('"op":12', '"op":24'),
    );
    // Both manifests' four outputs are stale; the fixtures are not.
    expect(await runCheck(options())).toBe(4);
    await runBake(options());
    write("catalog/demo.mlvc", "edited");
    expect(await runCheck(options())).toBe(1);
    expect(await runCheck({ ...options(), full: true })).toBe(1);
    rmSync(join(root, "catalog/demo.mlvc"));
    expect(await runCheck(options())).toBe(1);
    await runBake(options());
    expect(await runCheck(options())).toBe(0);
  });

  it("with full, rebakes in memory and catches stale stamps and fixtures", async () => {
    await runBake(options());
    const stamps = readStamps(root);
    write(
      STAMPS_FILE,
      formatStamps({
        ...stamps,
        "catalog/demo.mlvc": {
          inputs: "0",
          output: stamps["catalog/demo.mlvc"]?.output ?? "",
        },
      }),
    );
    expect(await runCheck({ ...options(), full: true })).toBe(1);
    expect(await runCheck(options())).toBe(1);
    await runBake(options());
    fixture = "two";
    expect(await runCheck({ ...options(), full: true })).toBe(1);
  });
});

describe("inputsHash", () => {
  it("covers paths, contents and order-independence", () => {
    write("a.txt", "a");
    write("b.txt", "b");
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    expect(inputsHash(root, [a, b])).toBe(inputsHash(root, [b, a, a]));
    const before = inputsHash(root, [a, b]);
    write("b.txt", "c");
    expect(inputsHash(root, [a, b])).not.toBe(before);
  });
});
