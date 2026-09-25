import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "browser",
    dts: true,
    sourcemap: true,
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  // The 16-bit segment test lays out a 12,000-point coast; `pnpm -r test` runs
  // it beside the other packages' suites, which can push it past 5 s on CI.
  test: { environment: "node", testTimeout: 30_000 },
});
