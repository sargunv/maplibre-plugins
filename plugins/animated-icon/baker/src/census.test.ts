import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { census, formatCensus, outcomeOf, scanFiles } from "./census.ts";
import { comp, el, fl, layer } from "./lottie.testing.ts";
import { ProfileError } from "./profile.ts";

const dir = mkdtempSync(join(tmpdir(), "animated-icon-census-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const set = join(dir, "set");
mkdirSync(set);
const dot = comp([layer([el(32, 32, 20), fl(0, 0, 0)])], { op: 6 });
writeFileSync(join(set, "a-core0.json"), JSON.stringify(dot));
writeFileSync(
  join(set, "b-core.json"),
  JSON.stringify({ ...dot, layers: [{ ...dot.layers[0], ao: 1 }] }),
);
writeFileSync(
  join(set, "c-later.json"),
  JSON.stringify({ ...dot, layers: [{ ...dot.layers[0], bm: 3 }] }),
);
writeFileSync(join(set, "d-never.json"), JSON.stringify({ ...dot, w: 1000 }));
writeFileSync(join(set, "e-broken.json"), "{");
writeFileSync(
  join(set, "f-crowd.json"),
  JSON.stringify(
    comp(
      Array.from({ length: 65 }, (_, i) => layer([el(i, 32, 1), fl(0, 0, 0)])),
      { op: 2 },
    ),
  ),
);
writeFileSync(join(set, "notes.txt"), "not a Lottie file");

describe("scanFiles", () => {
  it("sorts every file into its tier and samples every k-th file", () => {
    const files = scanFiles([set], 2);
    expect(files.map((f) => [f.tier, f.sampled])).toEqual([
      ["Core-0", true],
      ["Core", false],
      ["Later", true],
      ["never", false],
      ["unreadable", true],
      ["Core-0", false],
    ]);
    expect(files[1]?.core).toEqual(["auto-orient"]);
  });
});

describe("outcomeOf", () => {
  it("sorts bake failures into the census's reasons", () => {
    expect(
      outcomeOf(new Error("frame 3 has 70 draws; a frame holds at most 64"))
        .outcome,
    ).toBe("ops");
    expect(
      outcomeOf(
        new Error("shape 2: a horizontal band lists 300 curves, at most 256"),
      ).outcome,
    ).toBe("band entries");
    expect(
      outcomeOf(
        new Error("x: 2000000 baked bytes, over the limit of 1048576; ..."),
      ).outcome,
    ).toBe("size");
    expect(
      outcomeOf(
        new Error("x: about 90.0 curve visits per pixel, over the limit of 64"),
      ).outcome,
    ).toBe("visits");
    expect(
      outcomeOf(
        new ProfileError("a.json", [
          { path: "layers[0]", feature: "precomp-clip" },
        ]),
      ).outcome,
    ).toBe("precomp-clip");
    expect(outcomeOf(new Error("anything else")).outcome).toBe("error");
  });
});

describe("census", () => {
  it("bakes the sampled files the profile passes, in workers, and reports both shares", async () => {
    const files = await census([set], { bake: true, sample: 1, workers: 2 });
    const outcomes = Object.fromEntries(
      files.map((f) => [f.path.split("/").pop(), f.bake?.outcome]),
    );
    expect(outcomes).toEqual({
      "a-core0.json": "baked",
      "b-core.json": "baked",
      "c-later.json": undefined,
      "d-never.json": undefined,
      "e-broken.json": undefined,
      "f-crowd.json": "ops",
    });
    const text = formatCensus(files, true);
    expect(text).toContain(
      "tiers: Core-0 2, Core 1, Composite 0, Later 1, never 1, unreadable 1",
    );
    expect(text).toContain("profile share: 3/6 (50%)");
    expect(text).toContain(
      "bake share: 2/6 sampled files bake (33%); 2/3 of those the profile passes (67%)",
    );
    expect(text).toContain("ops: 1 (f-crowd.json)");
    expect(text).toContain("blend-modes: 1 (e.g. c-later.json)");
  });
});
