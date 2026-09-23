import { defineConfig } from "vite-plus";

export default defineConfig({
  server: {
    port: 5173,
    // The shared spec.json files live next to each plugin, outside this app.
    fs: { allow: ["../.."] },
  },
  // The dev-server dependency optimizer drops maplibre-gl's worker chunk
  // (maplibre-gl-worker.mjs 404s and the map never loads); serve it as-is.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  lint: { options: { typeAware: true, typeCheck: true } },
});
