import { defineConfig } from "vite-plus";

// Workspace-wide lint settings for `vp check`, which hk runs on changed files.
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
});
