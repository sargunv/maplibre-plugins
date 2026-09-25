// The profile census: how many Lottie files of a set each tier covers
// (Core-0, Core, Composite, Later, never), and with `bake`, how many of a
// deterministic sample of them actually bake: the full pipeline in memory,
// at 30 fps and the default limits (displayPx 48, the content box), in
// worker threads. The profile share counts what the profile accepts; the
// bake share also counts what the limits and the path booleans allow.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  describe,
  type FeatureId,
  fileTier,
  type FileTier,
  scan,
  type Violation,
} from "./profile.ts";

/** Frames per second of a census bake. */
export const CENSUS_FPS = 30;
/** Logical pixels of a census bake's anchor box. */
export const CENSUS_DISPLAY_PX = 48;

/** Why a sampled file did or did not bake. */
export type BakeOutcome =
  | "baked"
  | "ops"
  | "band entries"
  | "size"
  | "visits"
  | "precomp-clip"
  | "matte-sources"
  | "opacity-isolation"
  | "gradient-stops"
  | "error";

export interface BakeResult {
  readonly outcome: BakeOutcome;
  readonly detail?: string;
  /** Path booleans that fell back, when it baked. */
  readonly fallbacks: number;
  readonly visits?: number;
  readonly bytes?: number;
}

export interface CensusFile {
  /** The path as given (or found under a given directory). */
  readonly path: string;
  /** The directory it came from: the set it counts toward. */
  readonly set: string;
  readonly tier: FileTier | "unreadable";
  readonly violations: readonly Violation[];
  /** Core features it uses. */
  readonly core: readonly FeatureId[];
  /** Whether it was in the bake sample. */
  readonly sampled: boolean;
  readonly bake?: BakeResult;
}

/** Sorts a bake failure into the census's reasons. */
export function outcomeOf(error: unknown): {
  outcome: BakeOutcome;
  detail: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const violations = (error as { violations?: readonly Violation[] })
    .violations;
  if (violations && violations.length > 0) {
    const feature = (violations[0] as Violation).feature;
    const known: readonly string[] = [
      "precomp-clip",
      "matte-sources",
      "opacity-isolation",
      "gradient-stops",
    ];
    return {
      outcome: known.includes(feature) ? (feature as BakeOutcome) : "error",
      detail: violations.map(describe).join("; "),
    };
  }
  if (/a frame holds at most/.test(message))
    return { outcome: "ops", detail: message };
  if (/band lists \d+ curves/.test(message))
    return { outcome: "band entries", detail: message };
  if (/baked bytes, over the limit/.test(message))
    return { outcome: "size", detail: message };
  if (/curve visits per pixel, over the limit/.test(message)) {
    return { outcome: "visits", detail: message };
  }
  return { outcome: "error", detail: message };
}

/** The .json files a path names: itself, or a directory's, sorted. */
function expand(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
}

/** Scans every file; marks every `sample`-th file of each set for baking. */
export function scanFiles(paths: readonly string[], sample = 1): CensusFile[] {
  const out: CensusFile[] = [];
  for (const arg of paths) {
    const files = expand(arg);
    const set = statSync(arg).isDirectory() ? arg : dirname(arg);
    files.forEach((path, index) => {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        out.push({
          path,
          set,
          tier: "unreadable",
          violations: [],
          core: [],
          sampled: index % sample === 0,
        });
        return;
      }
      const result = scan(json);
      out.push({
        path,
        set,
        tier: fileTier(result),
        violations: result.violations,
        core: [...new Set(result.core.map((v) => v.feature))],
        sampled: index % sample === 0,
      });
    });
  }
  return out;
}

/** Whether the profile alone lets a file bake. */
export function profilePasses(file: CensusFile): boolean {
  return file.tier === "Core-0" || file.tier === "Core";
}

/** Bakes files in worker threads; results in the order given. */
export async function bakeFiles(
  paths: readonly string[],
  workers = Math.max(1, availableParallelism() - 1),
): Promise<BakeResult[]> {
  const results: BakeResult[] = [];
  let next = 0;
  const script = new URL("./census-worker.ts", import.meta.url);
  const run = (): Promise<void> =>
    new Promise((resolveRun, reject) => {
      const worker = new Worker(script);
      const feed = (): void => {
        if (next >= paths.length) {
          void worker.terminate().then(() => resolveRun());
          return;
        }
        const index = next++;
        worker.postMessage({ index, path: resolve(paths[index] as string) });
      };
      worker.on("message", (message: { index: number; result: BakeResult }) => {
        results[message.index] = message.result;
        feed();
      });
      worker.on("error", reject);
      feed();
    });
  await Promise.all(
    Array.from({ length: Math.min(workers, paths.length) }, () => run()),
  );
  return results;
}

/** The census: every file scanned, the sampled ones that pass the profile baked. */
export async function census(
  paths: readonly string[],
  options: {
    readonly bake?: boolean;
    readonly sample?: number;
    readonly workers?: number;
  } = {},
): Promise<CensusFile[]> {
  const files = scanFiles(paths, options.sample ?? 1);
  if (!options.bake) return files;
  const todo = files.filter((file) => file.sampled && profilePasses(file));
  const results = await bakeFiles(
    todo.map((file) => file.path),
    options.workers,
  );
  const byPath = new Map(todo.map((file, i) => [file.path, results[i]]));
  return files.map((file) => {
    const bake = byPath.get(file.path);
    return bake ? { ...file, bake } : file;
  });
}

const TIERS: readonly (FileTier | "unreadable")[] = [
  "Core-0",
  "Core",
  "Composite",
  "Later",
  "never",
  "unreadable",
];

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(0)}%` : "-";
}

/** The census as text: per set, the tiers, the shares and the reasons. */
export function formatCensus(
  files: readonly CensusFile[],
  baked: boolean,
): string {
  const sets = [...new Set(files.map((file) => file.set))];
  const lines: string[] = [];
  for (const set of sets) {
    const members = files.filter((file) => file.set === set);
    const count = (tier: string): number =>
      members.filter((file) => file.tier === tier).length;
    const pass = members.filter(profilePasses).length;
    lines.push(`${set} (${members.length} files)`);
    lines.push(
      `  tiers: ${TIERS.map((tier) => `${tier} ${count(tier)}`).join(", ")}`,
    );
    lines.push(
      `  profile share: ${pass}/${members.length} (${percent(pass, members.length)}) bake under the Core tier's profile`,
    );
    const reasons = new Map<string, { count: number; example: string }>();
    for (const file of members) {
      for (const feature of new Set(file.violations.map((v) => v.feature))) {
        const known = reasons.get(feature) ?? { count: 0, example: file.path };
        known.count += 1;
        reasons.set(feature, known);
      }
    }
    const first = [...reasons].sort((a, b) => b[1].count - a[1].count);
    if (first.length > 0) {
      lines.push("  first rejections (files):");
      for (const [feature, { count: n, example }] of first.slice(0, 8)) {
        lines.push(`    ${feature}: ${n} (e.g. ${basename(example)})`);
      }
    }
    if (!baked) continue;
    const sampled = members.filter((file) => file.sampled);
    const tried = sampled.filter(profilePasses);
    const ok = tried.filter((file) => file.bake?.outcome === "baked");
    const fallbacks = ok.filter((file) => (file.bake?.fallbacks ?? 0) > 0);
    lines.push(
      `  bake share: ${ok.length}/${sampled.length} sampled files bake (${percent(ok.length, sampled.length)}); ${ok.length}/${tried.length} of those the profile passes (${percent(ok.length, tried.length)}); ${fallbacks.length} with path boolean fallbacks`,
    );
    const outcomes = new Map<string, string[]>();
    for (const file of tried) {
      const outcome = file.bake?.outcome ?? "error";
      if (outcome === "baked") continue;
      outcomes.set(outcome, [
        ...(outcomes.get(outcome) ?? []),
        basename(file.path),
      ]);
    }
    for (const [outcome, names] of outcomes) {
      lines.push(
        `    ${outcome}: ${names.length} (${names.slice(0, 4).join(", ")})`,
      );
    }
  }
  return lines.join("\n");
}

/** The census as JSON, with paths under `root` relative to it. */
export function censusJson(files: readonly CensusFile[], root: string): string {
  const shown = (path: string): string => {
    const inside = relative(root, resolve(path));
    return inside.startsWith("..") ? resolve(path) : inside;
  };
  return `${JSON.stringify(
    files.map((file) => ({
      ...file,
      path: shown(file.path),
      set: shown(file.set),
    })),
    null,
    1,
  )}\n`;
}
