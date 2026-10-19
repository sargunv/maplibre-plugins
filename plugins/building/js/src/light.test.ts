import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LIGHT,
  EARTH_RADIUS,
  lightUniforms,
  metersPerTileUnit,
  sphericalToCartesian,
} from "./light.ts";

describe("lightUniforms", () => {
  it("puts the default light where maplibre-gl-js does", () => {
    const [x, y, z] = sphericalToCartesian(DEFAULT_LIGHT.position);
    // azimuth 210 + 90 = 300 degrees, polar 30 degrees, r 1.15.
    expect(x).toBeCloseTo(1.15 * Math.cos((300 * Math.PI) / 180) * 0.5, 12);
    expect(y).toBeCloseTo(1.15 * Math.sin((300 * Math.PI) / 180) * 0.5, 12);
    expect(z).toBeCloseTo(1.15 * Math.cos(Math.PI / 6), 12);
    const u = lightUniforms(DEFAULT_LIGHT, 0);
    expect(u.color).toEqual([1, 1, 1, 0.5]);
    expect(u.position.slice(0, 3)).toEqual([x, y, z]);
    expect(u.position[3]).toBe(0);
  });

  it("turns a viewport light with the bearing, as mat3.fromRotation", () => {
    const b = 0.7;
    const [x, y, z] = sphericalToCartesian(DEFAULT_LIGHT.position);
    const u = lightUniforms(DEFAULT_LIGHT, b);
    expect(u.position[0]).toBeCloseTo(Math.cos(b) * x - Math.sin(b) * y, 12);
    expect(u.position[1]).toBeCloseTo(Math.sin(b) * x + Math.cos(b) * y, 12);
    expect(u.position[2]).toBe(z);
    const map = lightUniforms({ ...DEFAULT_LIGHT, anchor: "map" }, b);
    expect(map.position.slice(0, 3)).toEqual([x, y, z]);
  });
});

describe("metersPerTileUnit", () => {
  it("is the equator's circumference over the world's tile units at z0", () => {
    expect(metersPerTileUnit({ z: 0, y: 0 })).toBeCloseTo(
      (2 * Math.PI * EARTH_RADIUS) / 8192,
      9,
    );
  });

  it("shrinks with the cosine of the tile center's latitude", () => {
    // Prague's z15 tile row 11097 is centered near 50.09 N.
    const value = metersPerTileUnit({ z: 15, y: 11097 });
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * 11097.5) / 2 ** 15)));
    expect((lat * 180) / Math.PI).toBeCloseTo(50.09, 1);
    expect(value).toBeCloseTo(
      (2 * Math.PI * EARTH_RADIUS * Math.cos(lat)) / (2 ** 15 * 8192),
      12,
    );
  });
});
