// Input stamps for the baked outputs (catalog/stamps.json), so checking
// that they are current costs a few hashes instead of a bake. Each output
// records the hash of everything it is baked from and the hash of what was
// written:
//
//   { "<output, relative to the plugin>": { "inputs": "<sha256>", "output": "<sha256>" } }
//
// The inputs are, in sorted path order: the manifest, every Lottie and
// license file it names, the baker's sources (tests and test helpers
// excluded) and package.json, the JS catalog reader, and the resolved
// canvaskit-wasm version. The fixtures directory is one entry, hashed over
// its sorted files, with the same inputs minus a manifest.
//
// The default run rebakes only what is stale; `--check` compares stamps
// with disk and never bakes (the pre-commit hook); `--check --full`
// rebakes everything in memory and compares bytes (CI).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { bakeCatalog, type CatalogManifest, readManifest } from "./bake.ts";
import {
  catalogModule,
  noticeText,
  type SyncOptions,
  syncFile,
} from "./emit.ts";
import { formatReport } from "./report.ts";

/** One output's stamp. */
export interface Stamp {
  readonly inputs: string;
  readonly output: string;
}

/** Every stamp, by output path relative to the plugin. */
export type Stamps = Readonly<Record<string, Stamp>>;

/** Where the stamps live, relative to the plugin. */
export const STAMPS_FILE = "catalog/stamps.json";
/** The fixtures' stamp key. */
export const FIXTURES = "fixtures/catalog";

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every file under `dir`, recursively, sorted. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
    .sort();
}

/** The canvaskit-wasm version this baker resolves and bakes with. */
export function canvaskitVersion(): string {
  const require = createRequire(import.meta.url);
  const path = require.resolve("canvaskit-wasm/package.json");
  const { version } = JSON.parse(readFileSync(path, "utf8")) as {
    version: string;
  };
  return version;
}

/** The inputs every output shares: the baker, the reader, canvaskit. */
export function bakerInputs(root: string): string[] {
  return [
    ...walk(join(root, "baker", "src")).filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".testing.ts"),
    ),
    join(root, "baker", "package.json"),
    join(root, "js", "src", "catalog.ts"),
  ];
}

/** A manifest and every Lottie and license file it names. */
export function manifestInputs(
  path: string,
  manifest: CatalogManifest,
): string[] {
  const dir = dirname(path);
  const files = new Set<string>([path]);
  for (const entry of manifest.animations) {
    files.add(resolve(dir, entry.file));
    if (entry.license !== undefined) files.add(resolve(dir, entry.license));
  }
  return [...files];
}

/**
 * The sha256 of `files` in sorted path order (each path relative to
 * `root`, then its bytes) and the canvaskit version.
 */
export function inputsHash(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  const sorted = [...new Set(files.map((file) => resolve(file)))].sort(
    (a, b) => (relative(root, a) < relative(root, b) ? -1 : 1),
  );
  for (const file of sorted) {
    hash.update(`${relative(root, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  hash.update(`canvaskit-wasm@${canvaskitVersion()}`);
  return hash.digest("hex");
}

/**
 * The sha256 of a file, or of a directory's files in sorted order (each
 * relative path, then its bytes); null when it does not exist.
 */
export function outputHash(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return sha256(readFileSync(path));
  const hash = createHash("sha256");
  for (const file of walk(path)) {
    hash.update(`${relative(path, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The stamps on disk, or none. */
export function readStamps(root: string): Stamps {
  const path = join(root, STAMPS_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Stamps;
}

/** Stamps as the committed file holds them: sorted keys, dprint's layout. */
export function formatStamps(stamps: Stamps): string {
  const sorted = Object.fromEntries(
    Object.keys(stamps)
      .sort()
      .map((key) => [key, stamps[key]]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** A manifest the default run bakes: one with an `output`. */
export interface BakedManifest {
  readonly path: string;
  readonly manifest: CatalogManifest;
}

/** Every `animations/*.json` with an `output`, in name order. */
export function bakedManifests(root: string): BakedManifest[] {
  const dir = join(root, "animations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name))
    .flatMap((path) => {
      const json: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof json !== "object" || json === null || !("output" in json)) {
        return [];
      }
      return [{ path, manifest: readManifest(path) }];
    });
}

/** A manifest's outputs, absolute, with their contents from a bake. */
async function bakeOutputs(
  root: string,
  { path, manifest }: BakedManifest,
  log: (line: string) => void,
): Promise<[string, Uint8Array | string][]> {
  const dir = dirname(path);
  const baked = await bakeCatalog(path);
  log(`${relative(root, path)}:\n${formatReport(baked)}\n`);
  const output = resolve(dir, manifest.output as string);
  const source = relative(root, output);
  const outputs: [string, Uint8Array | string][] = [
    [output, baked.packed.bytes],
  ];
  if (manifest.js !== undefined) {
    outputs.push([
      resolve(dir, manifest.js),
      catalogModule(baked.packed.bytes, baked.licenses, source),
    ]);
  }
  if (manifest.notice !== undefined) {
    outputs.push([
      resolve(dir, manifest.notice),
      noticeText(baked.licenses, source),
    ]);
  }
  return outputs;
}

/** The outputs a manifest names, absolute. */
function outputPaths({ path, manifest }: BakedManifest): string[] {
  const dir = dirname(path);
  return [manifest.output, manifest.js, manifest.notice]
    .filter((p): p is string => p !== undefined)
    .map((p) => resolve(dir, p));
}

export interface RunOptions {
  /** The plugin directory. */
  readonly root: string;
  /** Rebake everything, stale or not. */
  readonly force?: boolean;
  /** Writes the catalog fixtures, or in check mode compares them; returns how many were stale. */
  readonly fixtures: (options: SyncOptions) => number;
  readonly log?: (line: string) => void;
}

/**
 * The default run: rebakes every manifest whose stamps are stale (or all
 * with `force`), writes the fixtures when their inputs changed, and
 * updates stamps.json. Returns the number of files written.
 */
export async function runBake(options: RunOptions): Promise<number> {
  const { root, force = false, fixtures } = options;
  const log = options.log ?? console.log;
  const shared = bakerInputs(root);
  const stamps: Record<string, Stamp> = { ...readStamps(root) };
  let written = 0;
  const known = new Set<string>();
  for (const baked of bakedManifests(root)) {
    const inputs = inputsHash(root, [
      ...shared,
      ...manifestInputs(baked.path, baked.manifest),
    ]);
    const paths = outputPaths(baked);
    const stale =
      force ||
      paths.some((path) => {
        const stamp = stamps[relative(root, path)];
        return stamp?.inputs !== inputs || stamp.output !== outputHash(path);
      });
    for (const path of paths) known.add(relative(root, path));
    if (!stale) continue;
    for (const [path, content] of await bakeOutputs(root, baked, log)) {
      if (syncFile(path, content, { check: false })) written += 1;
      stamps[relative(root, path)] = {
        inputs,
        output: outputHash(path) as string,
      };
    }
  }
  const fixtureInputs = inputsHash(root, shared);
  const fixturesDir = join(root, FIXTURES);
  const stamp = stamps[FIXTURES];
  if (
    force ||
    stamp?.inputs !== fixtureInputs ||
    stamp.output !== outputHash(fixturesDir)
  ) {
    written += fixtures({ check: false });
    stamps[FIXTURES] = {
      inputs: fixtureInputs,
      output: outputHash(fixturesDir) ?? "",
    };
  }
  known.add(FIXTURES);
  for (const key of Object.keys(stamps)) {
    if (!known.has(key)) delete stamps[key];
  }
  if (
    syncFile(join(root, STAMPS_FILE), formatStamps(stamps), { check: false })
  ) {
    written += 1;
  }
  return written;
}

/**
 * The checks: without `full`, whether every stamp matches its inputs and
 * its output on disk (no bake); with `full`, whether a bake in memory
 * reproduces every output and the stamps byte for byte. Returns the
 * number of stale files.
 */
export async function runCheck(
  options: RunOptions & { readonly full?: boolean },
): Promise<number> {
  const { root, full = false, fixtures } = options;
  const log = options.log ?? console.log;
  const shared = bakerInputs(root);
  const stamps = readStamps(root);
  const expected: Record<string, Stamp> = {};
  let stale = 0;
  const report = (path: string, why: string): void => {
    stale += 1;
    console.error(`stale: ${path} (${why})`);
  };
  for (const baked of bakedManifests(root)) {
    const inputs = inputsHash(root, [
      ...shared,
      ...manifestInputs(baked.path, baked.manifest),
    ]);
    if (full) {
      for (const [path, content] of await bakeOutputs(root, baked, log)) {
        if (syncFile(path, content, { check: true })) stale += 1;
        const bytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content;
        expected[relative(root, path)] = { inputs, output: sha256(bytes) };
      }
      continue;
    }
    for (const path of outputPaths(baked)) {
      const key = relative(root, path);
      const stamp = stamps[key];
      const output = outputHash(path);
      if (!stamp) report(key, "no stamp");
      else if (stamp.inputs !== inputs) report(key, "inputs changed");
      else if (output === null) report(key, "missing");
      else if (stamp.output !== output) report(key, "edited since baked");
    }
  }
  const fixtureInputs = inputsHash(root, shared);
  if (full) {
    stale += fixtures({ check: true });
    expected[FIXTURES] = {
      inputs: fixtureInputs,
      output: outputHash(join(root, FIXTURES)) ?? "",
    };
    if (
      syncFile(join(root, STAMPS_FILE), formatStamps(expected), { check: true })
    ) {
      stale += 1;
    }
  } else {
    const stamp = stamps[FIXTURES];
    const output = outputHash(join(root, FIXTURES));
    if (!stamp) report(FIXTURES, "no stamp");
    else if (stamp.inputs !== fixtureInputs) report(FIXTURES, "inputs changed");
    else if (stamp.output !== output) report(FIXTURES, "edited since baked");
  }
  return stale;
}
