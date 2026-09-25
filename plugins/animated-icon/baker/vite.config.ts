import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  // Whole-catalog bakes take seconds, more on a busy machine.
  test: { environment: "node", testTimeout: 30_000 },
});
