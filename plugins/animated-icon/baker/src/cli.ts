// The baker's command line.
//
//   node baker/src/cli.ts [--force]
//       Rebake every animations/*.json with an "output" whose stamp is stale
//       (every one with --force), write the catalog fixtures, update
//       catalog/stamps.json, and print each rebaked catalog's report.
//   node baker/src/cli.ts --check [--full]
//       Exit 1 when any stamp's inputs or output differ from disk (fast; the
//       pre-commit hook). With --full, rebake everything in memory and exit
//       1 on any byte difference (CI).
//   node baker/src/cli.ts bake <manifest.json> [-o <out.mlvc>] [--fps <n>] [--notice <file>]
//       Bake one app manifest anywhere; --fps is the default for entries
//       without their own. With -o, the manifest's notice and JS module are
//       left alone (pass --notice for a notice). No stamps.
//   node baker/src/cli.ts census [--bake] [--sample <k>] [--json <out>] <files or dirs...>
//       Count files per profile tier and list the first rejections; with
//       --bake, also bake every k-th file of each directory that the profile
//       passes (30 fps, default limits) and report the bake share.
//
// A catalog holds its manifest's animations in the manifest's order (the
// enum order styles see), each followed by its marker entries.

import { writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { bakeCatalog, readManifest } from "./bake.ts";
import { census, censusJson, formatCensus } from "./census.ts";
import { catalogModule, noticeText, pluginRoot, syncFile } from "./emit.ts";
import { emitFixtures } from "./fixtures.ts";
import { formatReport } from "./report.ts";
import { runBake, runCheck } from "./stamps.ts";

async function bake(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      fps: { type: "string" },
      notice: { type: "string" },
    },
  });
  const [path] = positionals;
  if (!path || positionals.length > 1) {
    throw new Error(
      "usage: cli.ts bake <manifest.json> [-o <out.mlvc>] [--fps <n>] [--notice <file>]",
    );
  }
  const fps = values.fps === undefined ? undefined : Number(values.fps);
  if (fps !== undefined && !(Number.isFinite(fps) && fps > 0)) {
    throw new Error(`--fps: expected a number > 0, got ${values.fps}`);
  }
  const manifest = readManifest(path);
  const dir = dirname(resolve(path));
  const output = values.out
    ? resolve(values.out)
    : manifest.output
      ? resolve(dir, manifest.output)
      : undefined;
  if (!output) throw new Error(`${path} has no "output"; pass -o <out.mlvc>`);
  const baked = await bakeCatalog(path, fps === undefined ? {} : { fps });
  console.log(`${formatReport(baked)}\n`);
  // The notice and module name the catalog by its path in the plugin, or
  // by its file name elsewhere.
  const inside = relative(pluginRoot, output);
  const source = inside.startsWith("..") ? basename(output) : inside;
  syncFile(output, baked.packed.bytes, { check: false });
  // With -o the bake goes elsewhere, so the manifest's notice and JS
  // module (which name the committed catalog) stay untouched unless
  // --notice asks for one.
  const notice = values.notice
    ? resolve(values.notice)
    : manifest.notice && !values.out
      ? resolve(dir, manifest.notice)
      : undefined;
  if (notice)
    syncFile(notice, noticeText(baked.licenses, source), { check: false });
  if (manifest.js && !values.out) {
    syncFile(
      resolve(dir, manifest.js),
      catalogModule(baked.packed.bytes, baked.licenses, source),
      { check: false },
    );
  }
}

async function runCensus(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      bake: { type: "boolean", default: false },
      sample: { type: "string", default: "1" },
      json: { type: "string" },
    },
  });
  const sample = Number(values.sample);
  if (!(Number.isInteger(sample) && sample >= 1)) {
    throw new Error(
      `--sample: expected a whole number >= 1, got ${values.sample}`,
    );
  }
  if (positionals.length === 0) {
    throw new Error(
      "usage: cli.ts census [--bake] [--sample <k>] [--json <out>] <files or dirs...>",
    );
  }
  const files = await census(positionals, { bake: values.bake, sample });
  console.log(formatCensus(files, values.bake));
  if (values.json) writeFileSync(values.json, censusJson(files, process.cwd()));
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "bake") {
    await bake(rest);
  } else if (command === "census") {
    await runCensus(rest);
  } else {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        check: { type: "boolean", default: false },
        full: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
      },
    });
    const options = { root: pluginRoot, fixtures: emitFixtures };
    if (values.check) {
      const stale = await runCheck({
        ...options,
        full: values.full,
        log: () => {},
      });
      if (stale > 0) {
        console.error(
          "baked files are stale; run `node plugins/animated-icon/baker/src/cli.ts` (mise run bake)",
        );
        process.exitCode = 1;
      }
    } else {
      await runBake({ ...options, force: values.force });
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
