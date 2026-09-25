// The Lottie profile the baker accepts. Milestone M1 bakes the Core tier:
// Core-0 (shape, null and solid layers with parenting; transforms;
// keyframes with easing, holds and spatial tangents; groups, paths with
// morphs, rectangles, ellipses and stars; fills and strokes; animated color
// and opacity) plus precompositions with time stretch and remap,
// auto-orient, trim paths, dashes, repeaters, round corners, loopIn and
// loopOut, primary and secondary color slots, linear and radial gradients,
// opaque masks and opaque alpha mattes. Everything else is rejected with
// the JSON path, the feature and the tier that would add it, unless the
// catalog entry lists the feature in its `ignore` list, in which case the
// baker drops it knowingly. An entry may drop a Core feature the same way.
// Inert data (expression controls, markers, merge-paths mode 1) is noted
// in the report.

import { parseLoop } from "./keyframes.ts";

/** Tiers by what the runtime would need to draw them. */
export type Tier = "Core (M1)" | "Composite (M3)" | "Later" | null;

interface FeatureInfo {
  /** A noun phrase for messages; plural unless `one` is set. */
  readonly name: string;
  readonly one?: boolean;
  /** The tier that adds it; null when no tier is planned. */
  readonly tier: Tier;
  /** A fix to suggest instead of, or besides, the tier. */
  readonly hint?: string;
}

/** The tier the baker bakes. */
export const BAKED_TIER = "Core (M1)" satisfies Tier;

/**
 * Every feature the profile knows, by its `ignore` id. Core (M1) features
 * bake; the rest are rejected. Some are only found while baking:
 * `opacity-isolation`, `precomp-clip`, `matte-sources` and
 * `gradient-stops`.
 */
export const FEATURES = {
  precomps: { name: "precomposition layers", tier: "Core (M1)" },
  "time-remap": { name: "time remapping", one: true, tier: "Core (M1)" },
  "time-stretch": { name: "time stretch", one: true, tier: "Core (M1)" },
  "auto-orient": { name: "auto-orient", one: true, tier: "Core (M1)" },
  "loop-expressions": { name: "loopIn/loopOut expressions", tier: "Core (M1)" },
  masks: { name: "masks", tier: "Core (M1)" },
  mattes: { name: "track mattes", tier: "Core (M1)" },
  gradients: { name: "gradient fills and strokes", tier: "Core (M1)" },
  trim: { name: "trim paths", tier: "Core (M1)" },
  dashes: { name: "dashed strokes", tier: "Core (M1)" },
  repeaters: { name: "repeaters", tier: "Core (M1)" },
  "round-corners": { name: "round corners", tier: "Core (M1)" },
  "color-slots": {
    name: "primary and secondary color slots",
    tier: "Core (M1)",
  },
  images: { name: "image layers", tier: "Later" },
  text: { name: "text layers", tier: null },
  "other-layers": { name: "audio, camera and data layers", tier: null },
  "3d": { name: "3D layers", tier: null },
  "mask-opacity": {
    name: "translucent or animated-opacity masks",
    tier: "Composite (M3)",
  },
  "mask-contraction": { name: "negative mask expansions", tier: "Later" },
  "luma-mattes": { name: "luma track mattes", tier: "Later" },
  "matte-sources": {
    name: "track mattes with translucent sources",
    tier: "Composite (M3)",
  },
  "precomp-clip": {
    name: "precomposition content outside the precomposition's bounds",
    tier: "Composite (M3)",
    hint: "or keep the content inside the precomposition",
  },
  effects: { name: "layer effects", tier: null },
  "layer-styles": { name: "layer styles", tier: null },
  "blend-modes": { name: "blend modes", tier: "Later" },
  expressions: {
    name: "expressions",
    tier: null,
    hint: 'use After Effects "Convert Expression to Keyframes"',
  },
  "gradient-highlights": {
    name: "radial gradient highlights",
    tier: "Composite (M3)",
  },
  "gradient-stops": {
    name: "gradients with more than 8 color and opacity stops together",
    tier: null,
    hint: "use fewer stops, or ignore it to resample the gradient to 8",
  },
  "merge-paths": { name: "merge paths modes 2-5", tier: "Composite (M3)" },
  "path-modifiers": {
    name: "offset path, pucker and bloat, zig zag and twist modifiers",
    tier: null,
  },
  "unknown-shapes": { name: "unknown shape items", tier: null },
  slots: {
    name: "slots other than a fill or stroke color's primary or secondary",
    tier: "Later",
  },
  "opacity-isolation": {
    name: "translucent layers or groups over overlapping shapes",
    tier: "Composite (M3)",
    hint: "or ignore it to fold the opacity into each shape",
  },
  "canvas-size": { name: "canvases larger than 512 px", tier: null },
} as const satisfies Record<string, FeatureInfo>;

export type FeatureId = keyof typeof FEATURES;

export function isFeatureId(id: string): id is FeatureId {
  return Object.hasOwn(FEATURES, id);
}

/** Whether a feature bakes (is in the Core tier) rather than being rejected. */
export function isCore(feature: FeatureId): boolean {
  return FEATURES[feature].tier === BAKED_TIER;
}

export interface Violation {
  /** JSON path into the Lottie file, e.g. `layers[3].masksProperties`. */
  readonly path: string;
  readonly feature: FeatureId;
}

/** The message for one rejected feature. */
export function describe({ path, feature }: Violation): string {
  const info: FeatureInfo = FEATURES[feature];
  const tier = info.tier
    ? `${info.one ? "needs" : "need"} profile tier ${info.tier}`
    : `${info.one ? "is" : "are"} outside every profile tier`;
  const hint = info.hint ? `; ${info.hint}` : "";
  return `${path}: ${info.name} ${tier}${hint} (ignore id "${feature}")`;
}

/** Thrown when a Lottie file uses features the profile does not bake. */
export class ProfileError extends Error {
  readonly violations: readonly Violation[];
  constructor(file: string, violations: readonly Violation[]) {
    super(
      `${file} uses features outside profile tier ${BAKED_TIER}:\n` +
        violations.map((v) => `  ${describe(v)}`).join("\n") +
        "\nList a feature's ignore id in the catalog entry's \"ignore\" to bake without it.",
    );
    this.name = "ProfileError";
    this.violations = violations;
  }
}

/** What the check found that is allowed but worth reporting. */
export interface ProfileNotes {
  /** Features the entry ignores that the file uses, with their paths. */
  readonly ignored: readonly Violation[];
  /** Core features the file uses, which bake. */
  readonly core: readonly Violation[];
  /** Inert data the baker skips. */
  readonly inert: readonly string[];
}

/** What a scan found. */
export interface Scan {
  /** Features outside the Core tier. */
  readonly violations: Violation[];
  /** Core features in use. */
  readonly core: Violation[];
  readonly inert: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isKeyframes(k: unknown): boolean {
  return Array.isArray(k) && k.length > 0 && isObject(k[0]) && "t" in k[0];
}

/** Whether a property is ever something other than `value`. */
function varies(property: unknown, value: number): boolean {
  if (!isObject(property)) return false;
  if (typeof property.x === "string") return true;
  const k = property.k;
  if (isKeyframes(k)) return true;
  const v = Array.isArray(k) ? k[0] : k;
  return typeof v === "number" && v !== value;
}

/** Whether a property ever goes below zero. */
function goesNegative(property: unknown): boolean {
  if (!isObject(property)) return false;
  const k = property.k;
  const values = isKeyframes(k)
    ? list(k).flatMap((key) =>
        isObject(key) ? [...list(key.s), ...list(key.e)] : [],
      )
    : [k].flat();
  return values.some((v) => typeof v === "number" && v < 0);
}

/**
 * Collects every feature the file uses beyond Core-0 and the inert data
 * it carries. Hidden layers and items are skipped, as lottie-web skips
 * them, except for their transforms, which still parent other layers.
 * Precompositions are scanned once each, under `assets[i].layers`.
 */
export function scan(lottie: unknown): Scan {
  const violations: Violation[] = [];
  const core: Violation[] = [];
  const inert: string[] = [];
  const use = (path: string, feature: FeatureId): void => {
    (isCore(feature) ? core : violations).push({ path, feature });
  };
  if (!isObject(lottie)) return { violations, core, inert };

  const w = Number(lottie.w);
  const h = Number(lottie.h);
  if (w > 512 || h > 512) use(w > 512 ? "w" : "h", "canvas-size");
  if (list(lottie.markers).length > 0) {
    inert.push(
      'markers (an entry\'s "markers" field bakes them as extra entries)',
    );
  }

  // Expressions: a whole loopIn/loopOut call on a keyframed number
  // property bakes; paths have no loops in lottie-web; anything else is
  // an expression.
  const expressions = (value: unknown, path: string, shapes = false): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => expressions(item, `${path}[${i}]`, shapes));
    } else if (isObject(value)) {
      if (typeof value.x === "string" && "k" in value) {
        use(
          `${path}.x`,
          !shapes && parseLoop(value.x) ? "loop-expressions" : "expressions",
        );
      }
      // Every key, `x` too: with separate dimensions, a position's `x` is
      // the X property itself. An expression string is a no-op to visit.
      for (const [key, item] of Object.entries(value)) {
        const path2 = path ? `${path}.${key}` : key;
        expressions(item, path2, shapes || (value.ty === "sh" && key === "ks"));
      }
    }
  };

  // lottie-web swaps a slot's value in for any property with a `sid`; the
  // baker recolors only the primary and secondary slots of a fill or
  // stroke color.
  const slots = (
    value: unknown,
    path: string,
    owner?: Json,
    key?: string,
  ): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (!(isObject(item) && item.hd === true)) slots(item, `${path}[${i}]`);
      });
    } else if (isObject(value)) {
      if (typeof value.sid === "string") {
        const color =
          (value.sid === "primary" || value.sid === "secondary") &&
          key === "c" &&
          (owner?.ty === "fl" || owner?.ty === "st");
        use(`${path}.sid`, color ? "color-slots" : "slots");
      }
      for (const [k, item] of Object.entries(value)) {
        slots(item, `${path}.${k}`, value, k);
      }
    }
  };

  // Slot values replace properties, so their expressions count too.
  expressions(lottie.slots, "slots");

  const shapes = (items: unknown[], path: string): void => {
    items.forEach((value, index) => {
      if (!isObject(value) || value.hd === true) return;
      const at = `${path}[${index}]`;
      // lottie-web's SVG renderer sets mix-blend-mode on styles and groups
      // (SVGShapeElement.js:147-148, 163-164) when bm is truthy; shapes,
      // transforms and modifiers ignore it.
      if (
        value.bm &&
        ["gr", "fl", "st", "gf", "gs"].includes(value.ty as string)
      ) {
        use(`${at}.bm`, "blend-modes");
      }
      switch (value.ty) {
        case "gr":
          shapes(list(value.it), `${at}.it`);
          break;
        case "sh":
        case "rc":
        case "el":
        case "sr":
        case "tr":
        case "fl":
          break;
        case "st":
          if (list(value.d).length > 0) use(`${at}.d`, "dashes");
          break;
        case "gf":
        case "gs":
          use(at, "gradients");
          if (value.ty === "gs" && list(value.d).length > 0) {
            use(`${at}.d`, "dashes");
          }
          if (value.t === 2 && varies(value.h, 0)) {
            use(`${at}.h`, "gradient-highlights");
          }
          break;
        case "tm":
          use(at, "trim");
          break;
        case "rp":
          use(at, "repeaters");
          break;
        case "rd":
          use(at, "round-corners");
          break;
        case "mm":
          if (value.mm === 1 || value.mm === undefined) {
            inert.push(
              `${at}: merge paths mode 1 (lottie-web draws the paths unmerged)`,
            );
          } else {
            use(at, "merge-paths");
          }
          break;
        case "op":
        case "pb":
        case "zz":
        case "tw":
          use(at, "path-modifiers");
          break;
        default:
          use(`${at}.ty`, "unknown-shapes");
      }
    });
  };

  const assets = list(lottie.assets);
  const scanned = new Set<number>();
  const layers = (values: unknown[], at: string): void => {
    values.forEach((value, index) => {
      if (!isObject(value)) return;
      const path = `${at}[${index}]`;
      layer(value, path);
    });
  };
  const layer = (value: Json, at: string): void => {
    // A hidden layer's transform still parents other layers.
    expressions(value.ks, `${at}.ks`);
    slots(value.ks, `${at}.ks`);
    if (value.hd === true) return;
    switch (value.ty) {
      case 0: {
        use(`${at}.ty`, "precomps");
        const asset = assets.findIndex(
          (a) => isObject(a) && a.id === value.refId,
        );
        if (asset >= 0 && !scanned.has(asset)) {
          scanned.add(asset);
          layers(
            list((assets[asset] as Json).layers),
            `assets[${asset}].layers`,
          );
        }
        if (value.tm !== undefined) {
          use(`${at}.tm`, "time-remap");
          expressions(value.tm, `${at}.tm`);
        }
        if (value.sr !== undefined && value.sr !== 1) {
          use(`${at}.sr`, "time-stretch");
        }
        break;
      }
      case 1:
      case 3:
      case 4:
        break;
      case 2:
        use(`${at}.ty`, "images");
        break;
      case 5:
        use(`${at}.ty`, "text");
        break;
      default:
        use(`${at}.ty`, "other-layers");
    }
    if (value.ty !== 0) {
      // lottie-web reads time remap and stretch only on precompositions
      // (CompElement.js:49-56).
      if (value.tm !== undefined) {
        inert.push(
          `${at}.tm: time remap on a layer that is not a precomposition`,
        );
      }
      if (value.sr !== undefined && value.sr !== 1) {
        inert.push(
          `${at}.sr: time stretch on a layer that is not a precomposition`,
        );
      }
    }
    if (value.ddd === 1) use(`${at}.ddd`, "3d");
    const masks = list(value.masksProperties);
    if (masks.length > 0) {
      use(`${at}.masksProperties`, "masks");
      masks.forEach((mask, m) => {
        if (!isObject(mask) || mask.mode === "n") return;
        const path = `${at}.masksProperties[${m}]`;
        expressions(mask.pt, `${path}.pt`, true);
        if (varies(mask.o, 100)) use(`${path}.o`, "mask-opacity");
        expressions(mask.x, `${path}.x`);
        if (goesNegative(mask.x)) use(`${path}.x`, "mask-contraction");
      });
    }
    if (value.tt !== undefined && value.tt !== 0) {
      use(
        `${at}.tt`,
        value.tt === 1 || value.tt === 2 ? "mattes" : "luma-mattes",
      );
    }
    if (value.ao === 1) use(`${at}.ao`, "auto-orient");
    list(value.ef).forEach((effect, e) => {
      if (isObject(effect) && effect.ty === 5) {
        inert.push(`${at}.ef[${e}]: expression controls`);
      } else {
        use(`${at}.ef[${e}]`, "effects");
      }
    });
    if (list(value.sy).length > 0) use(`${at}.sy`, "layer-styles");
    if (value.bm !== undefined && value.bm !== 0)
      use(`${at}.bm`, "blend-modes");
    if (value.ty === 4) {
      expressions(value.shapes, `${at}.shapes`);
      slots(value.shapes, `${at}.shapes`);
      shapes(list(value.shapes), `${at}.shapes`);
    }
  };
  layers(list(lottie.layers), "layers");
  return { violations, core, inert };
}

/**
 * Checks a Lottie file against the profile. Throws a ProfileError listing
 * every feature outside the Core tier that the entry does not ignore;
 * returns what it ignored, the Core features it bakes and the inert data
 * it found.
 */
export function checkProfile(
  file: string,
  lottie: unknown,
  ignore: readonly string[] = [],
): ProfileNotes {
  for (const id of ignore) {
    if (!isFeatureId(id)) {
      throw new Error(
        `${file}: unknown ignore id ${JSON.stringify(id)}; known ids: ${Object.keys(FEATURES).join(", ")}`,
      );
    }
  }
  const { violations, core, inert } = scan(lottie);
  const rejected = violations.filter((v) => !ignore.includes(v.feature));
  if (rejected.length > 0) throw new ProfileError(file, rejected);
  return {
    ignored: [...violations, ...core].filter((v) => ignore.includes(v.feature)),
    core: core.filter((v) => !ignore.includes(v.feature)),
    inert,
  };
}

/** A file's tier: the lowest tier that bakes every feature it uses. */
export type FileTier = "Core-0" | "Core" | "Composite" | "Later" | "never";

/** The tier a scan puts a file in, for the census. */
export function fileTier({ violations, core }: Scan): FileTier {
  const tiers = new Set(violations.map((v) => FEATURES[v.feature].tier));
  if (tiers.has(null)) return "never";
  if (tiers.has("Later")) return "Later";
  if (tiers.has("Composite (M3)")) return "Composite";
  return core.length > 0 ? "Core" : "Core-0";
}
