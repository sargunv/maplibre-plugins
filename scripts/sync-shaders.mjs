// Mirrors each plugin's shared GLSL into a generated TypeScript module so the
// JS package can embed it without a bundler-specific raw import. The Zig build
// reads the same .glsl file directly.
//
//   node scripts/sync-shaders.mjs          # rewrite generated files
//   node scripts/sync-shaders.mjs --check  # exit 1 when any file is stale

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
let stale = 0;

for (const plugin of readdirSync(join(root, "plugins"))) {
  const shaders = join(root, "plugins", plugin, "shaders");
  if (!existsSync(shaders)) continue;
  for (const file of readdirSync(shaders).filter((f) => f.endsWith(".glsl"))) {
    const source = readFileSync(join(shaders, file), "utf8");
    const name = file.replace(/\.glsl$/, "");
    const target = join(
      root,
      "plugins",
      plugin,
      "js",
      "src",
      "generated",
      `${name}.glsl.ts`,
    );
    const content =
      `// Generated from shaders/${file} by scripts/sync-shaders.mjs. Do not edit.\n` +
      `export default ${JSON.stringify(source)};\n`;
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === content) continue;
    stale++;
    if (check) {
      console.error(`stale: ${target}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      console.log(`wrote ${target}`);
    }
  }
}

if (check && stale > 0) process.exit(1);
