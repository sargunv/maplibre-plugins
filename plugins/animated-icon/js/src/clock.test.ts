import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CLOCK_PERIOD } from "./catalog.ts";
import { clockSeconds, setClockOverride } from "./clock.ts";

afterEach(() => {
  setClockOverride(null);
  vi.restoreAllMocks();
});

describe("clockSeconds", () => {
  it("is performance.now() in seconds, wrapped to [0, 4096)", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(12_345);
    expect(clockSeconds()).toBe(12.345);
    now.mockReturnValue((CLOCK_PERIOD + 1.5) * 1000);
    expect(clockSeconds()).toBeCloseTo(1.5, 9);
    now.mockReturnValue(CLOCK_PERIOD * 3 * 1000);
    expect(clockSeconds()).toBe(0);
  });

  it("pins at a wrapped override until null or a non-finite value", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    setClockOverride(2.5);
    expect(clockSeconds()).toBe(2.5);
    setClockOverride(CLOCK_PERIOD + 7);
    expect(clockSeconds()).toBe(7);
    setClockOverride(-1);
    expect(clockSeconds()).toBe(CLOCK_PERIOD - 1);
    setClockOverride(Number.NaN);
    expect(clockSeconds()).toBe(1);
    setClockOverride(3);
    setClockOverride(null);
    expect(clockSeconds()).toBe(1);
  });
});
