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
  // The model tests sweep thousands of particle lives through the shader's
  // CPU build; `pnpm -r test` runs them beside the other packages' suites,
  // which can push one past 5 s on CI.
  test: { environment: "node", testTimeout: 30_000 },
});
