// Integer hashing shared by the particle model. This is the TypeScript twin
// of particleHash, particleUnit and particleWeyl in ../../shaders/particle.glsl
// and of native/src/hash.zig; fixtures/hash.json holds its outputs, and the
// other twins are tested against them. All arithmetic is on uint32 and exact.

export type Uint3 = readonly [number, number, number];

/** pcg3d (Jarzynski and Olano, JCGT 2020): three well-mixed uint32s from three. */
export function pcg3d(x: number, y: number, z: number): Uint3 {
  let a = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  let c = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  c = (c ^ (c >>> 16)) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  return [a, b, c];
}

/** The top 24 bits of a hash as a float in [0, 1), exact in f32. */
export function u01(h: number): number {
  return (h >>> 8) / 16777216;
}

/** The k-th term of the golden-ratio Weyl sequence in [0, 1), exact. */
export function weyl(k: number): number {
  return u01(Math.imul(k, 0x9e3779b9) >>> 0);
}
