// Writes baked outputs: a catalog, its base64 mirror for the JS package
// (the demo), and a plain-text notice of the licenses its animations come
// under (app catalogs). In check mode it only reports what is stale, like
// scripts/sync-shaders.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LicenseNotice } from "./bake.ts";

/** plugins/animated-icon */
export const pluginRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export interface SyncOptions {
  /** Only compare; never write. */
  readonly check: boolean;
}

/**
 * Brings one output file up to date. Returns whether it was stale; in check
 * mode the file is left alone.
 */
export function syncFile(
  path: string,
  content: Uint8Array | string,
  { check }: SyncOptions,
): boolean {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const current = existsSync(path) ? readFileSync(path) : null;
  if (current && Buffer.compare(current, bytes) === 0) return false;
  const shown = relative(process.cwd(), path);
  if (check) {
    console.error(`stale: ${shown}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    console.log(`wrote ${shown}`);
  }
  return true;
}

/** The credit lines and license texts, as plain lines. */
function noticeLines(licenses: readonly LicenseNotice[]): string[] {
  const lines: string[] = [];
  for (const { credits, text } of licenses) {
    lines.push("", ...credits.map((credit) => `- ${credit}`), "");
    lines.push(...text.split("\n").map((line) => line.trimEnd()));
  }
  return lines;
}

/**
 * A `/*! ... *\/` comment with the notices of the licenses the catalog's
 * animations come under. Bundlers keep such legal comments (the gallery's
 * build asks for them), so the notices travel with the artwork.
 */
function legalComment(licenses: readonly LicenseNotice[]): string {
  if (licenses.length === 0) return "";
  const lines = [
    "The catalog below contains data derived from:",
    ...noticeLines(licenses),
  ];
  const body = lines.map((line) => (line ? ` * ${line}` : " *")).join("\n");
  if (body.includes("*/")) throw new Error("a license notice contains */");
  return `/*!\n${body}\n */\n`;
}

/**
 * The generated module that carries a catalog into the JS package, with the
 * notices of the licenses its animations come under. `source` names the
 * catalog file it mirrors, relative to the plugin.
 */
export function catalogModule(
  bytes: Uint8Array,
  licenses: readonly LicenseNotice[] = [],
  source = "catalog/demo.mlvc",
): string {
  return (
    `// Generated from ${source} by baker/src/cli.ts. Do not edit.\n` +
    legalComment(licenses) +
    `export default ${JSON.stringify(Buffer.from(bytes).toString("base64"))};\n`
  );
}

/**
 * The plain-text notice that travels with an app catalog (`notice` in a
 * manifest): which animations it holds, their credits, and the license
 * texts they come under. `source` names the catalog file.
 */
export function noticeText(
  licenses: readonly LicenseNotice[],
  source: string,
): string {
  const head =
    licenses.length === 0
      ? [`${source} contains no third-party data.`]
      : [`${source} contains data derived from:`, ...noticeLines(licenses)];
  return `${head.join("\n")}\n`;
}
