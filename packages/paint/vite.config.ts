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
  test: { environment: "node" },
});
