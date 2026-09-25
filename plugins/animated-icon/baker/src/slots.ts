// Recolor slots. A solid paint the catalog puts in slot 1 (primary) or 2
// (secondary) takes its color from `icon-color` (and, from M2,
// `icon-secondary-color`) at run time. A paint is slotted when its fill or
// stroke color names a Lottie slot (`sid` "primary" or "secondary",
// lottie-web's SlotManager.getProp, utils/SlotManager.js:5-8), when the
// catalog entry lists its authored color, within a CIE76 color difference
// of 2, under `slots`, or for every solid paint when the entry sets `tint`.
// Gradients are never slotted.

/** Colors, as `#rrggbb` hex, that the entry puts in each slot. */
export interface SlotColors {
  readonly primary?: readonly string[];
  readonly secondary?: readonly string[];
}

/** How an entry assigns slots. */
export interface SlotRule {
  readonly colors?: SlotColors;
  readonly tint?: boolean;
}

/** The largest CIE76 difference at which an authored color matches. */
export const DELTA_E = 2;

const HEX = /^#[0-9a-f]{6}$/i;

/** Whether a string is a `#rrggbb` color. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** A `#rrggbb` color as straight sRGB 0..1. */
export function parseHex(hex: string): [number, number, number] {
  if (!HEX.test(hex))
    throw new Error(`expected #rrggbb, got ${JSON.stringify(hex)}`);
  return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** sRGB (0..1) to CIE L*a*b* under D65. */
export function srgbToLab([r, g, b]: readonly number[]): [
  number,
  number,
  number,
] {
  const linear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const [lr, lg, lb] = [linear(r ?? 0), linear(g ?? 0), linear(b ?? 0)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The CIE76 difference between two sRGB colors. */
export function deltaE(a: readonly number[], b: readonly number[]): number {
  const [l1, a1, b1] = srgbToLab(a);
  const [l2, a2, b2] = srgbToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The slot of a solid paint with authored straight sRGB `color`, given the
 * slot its Lottie color names (`named`) and the entry's rule.
 */
export function slotOf(
  color: readonly number[],
  named: 0 | 1 | 2,
  rule: SlotRule = {},
): 0 | 1 | 2 {
  if (rule.tint) return 1;
  if (named !== 0) return named;
  const matches = (hexes: readonly string[] = []): boolean =>
    hexes.some((hex) => deltaE(color, parseHex(hex)) < DELTA_E);
  if (matches(rule.colors?.primary)) return 1;
  if (matches(rule.colors?.secondary)) return 2;
  return 0;
}
