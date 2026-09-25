// hash.ts against an independent BigInt pcg3d and against fixtures/hash.json,
// the vectors native/src/hash.zig and the shader's own hash (in model.test.ts)
// are tested with. Regenerate the fixture with `UPDATE_FIXTURES=1 pnpm test`,
// then `pnpm exec dprint fmt` it.

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { pcg3d, u01, weyl } from "./hash.ts";

const FIXTURE = new URL("../../fixtures/hash.json", import.meta.url);

/** pcg3d written out in BigInt, modulo 2^32 after every step. */
function referencePcg3d(x: number, y: number, z: number): number[] {
  const mask = 0xffffffffn;
  let [a, b, c] = [x, y, z].map(
    (v) => (BigInt(v) * 1664525n + 1013904223n) & mask,
  ) as [bigint, bigint, bigint];
  const mixRound = (): void => {
    a = (a + b * c) & mask;
    b = (b + c * a) & mask;
    c = (c + a * b) & mask;
  };
  mixRound();
  a ^= a >> 16n;
  b ^= b >> 16n;
  c ^= c >> 16n;
  mixRound();
  return [a, b, c].map(Number);
}

/** Deterministic uint32 inputs: edge values, small counters and seeds. */
function inputs(): [number, number, number][] {
  const list: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0xffffffff, 0xffffffff, 0xffffffff],
    [0x80000000, 0x7fffffff, 0x5eed],
    [12345, 42, 0x5eed],
    [7, 3, 0x6a09],
    [32768, 16384, 0xb0b],
    [0x9e3779b9, 81919, 0x71],
    [4000, 0, 7],
    [1234567890, 4095, 0x9e37],
  ];
  let state = 0x2545f491;
  for (let i = 0; i < 20; i++) {
    state = pcg3d(state, i, 99)[0];
    const [p, q, r] = pcg3d(state, i, 100);
    list.push([p, q >>> (i % 32), r & 0xffff]);
  }
  return list;
}

interface HashFixture {
  $comment: string;
  cases: { input: number[]; hash: number[]; unit: number[] }[];
  weyl: { k: number; value: number }[];
}

function buildFixture(): HashFixture {
  const ks = [0, 1, 2, 3, 4, 5, 10, 100, 255, 1000, 4095, 65535, 65536];
  ks.push(123456789, 0x7fffffff, 0xffffffff);
  return {
    $comment:
      "pcg3d vectors (input -> hash, and each hash word through particleUnit) and particleWeyl terms. Expected outputs come from js/src/hash.ts; native/src/hash.zig is checked against them, and js/src/model.test.ts runs particleHash, particleUnit and particleWeyl of shaders/particle.glsl, compiled for the CPU, on them.",
    cases: inputs().map(([x, y, z]) => {
      const hash = pcg3d(x, y, z);
      return { input: [x, y, z], hash: [...hash], unit: hash.map(u01) };
    }),
    weyl: ks.map((k) => ({ k, value: weyl(k) })),
  };
}

describe("pcg3d", () => {
  it("matches a BigInt reference", () => {
    for (const [x, y, z] of inputs()) {
      expect(pcg3d(x, y, z)).toEqual(referencePcg3d(x, y, z));
    }
  });

  it("returns uint32 words", () => {
    for (const [x, y, z] of inputs()) {
      for (const word of pcg3d(x, y, z)) {
        expect(Number.isInteger(word)).toBe(true);
        expect(word).toBeGreaterThanOrEqual(0);
        expect(word).toBeLessThan(2 ** 32);
      }
    }
  });

  it("spreads consecutive counters evenly", () => {
    const buckets = Array.from({ length: 16 }, () => 0);
    const n = 16000;
    for (let i = 0; i < n; i++) {
      const bucket = Math.floor(u01(pcg3d(i, 0, 0x5eed)[0]) * 16);
      buckets[bucket]!++;
    }
    for (const count of buckets) {
      expect(Math.abs(count - n / 16)).toBeLessThan(0.1 * (n / 16));
    }
  });
});

describe("u01 and weyl", () => {
  it("maps the top 24 bits to [0, 1) exactly", () => {
    expect(u01(0)).toBe(0);
    expect(u01(0xff)).toBe(0);
    expect(u01(0x100)).toBe(2 ** -24);
    expect(u01(0xffffffff)).toBe(1 - 2 ** -24);
    expect(Math.fround(u01(0x12345678))).toBe(u01(0x12345678));
  });

  it("steps by the golden ratio and fills [0, 1) evenly", () => {
    expect(weyl(0)).toBe(0);
    expect(weyl(1)).toBeCloseTo(0.6180339887, 6);
    const n = 1000;
    const terms = Array.from({ length: n }, (_, k) => weyl(k)).sort(
      (a, b) => a - b,
    );
    let gap = terms[0]! + 1 - terms[n - 1]!;
    for (let k = 1; k < n; k++) gap = Math.max(gap, terms[k]! - terms[k - 1]!);
    // The golden-ratio sequence keeps every gap under about 2.6 / n.
    expect(gap).toBeLessThan(3 / n);
  });
});

describe("fixtures/hash.json", () => {
  const fixture = buildFixture();
  if (process.env.UPDATE_FIXTURES) {
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as HashFixture;

  it("holds the current hash outputs", () => {
    expect(stored.cases.length).toBeGreaterThan(20);
    for (const { input, hash, unit } of stored.cases) {
      const [x, y, z] = input as [number, number, number];
      expect(hash).toEqual([...pcg3d(x, y, z)]);
      expect(unit).toEqual(hash.map(u01));
    }
    for (const { k, value } of stored.weyl) expect(value).toBe(weyl(k));
  });

  it("is what this file generates", () => {
    expect(stored).toEqual(fixture);
  });
});
