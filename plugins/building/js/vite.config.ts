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
  // The fixture suite lays out every roof shape on a dozen footprints;
  // `pnpm -r test` runs it beside the other packages' suites.
  test: { environment: "node", testTimeout: 30_000 },
});
