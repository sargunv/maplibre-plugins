import { defineConfig } from "vite-plus";

export default defineConfig({
  // GitHub Pages serves the gallery under the repository name; the Pages
  // workflow sets this, local builds stay at the root.
  base: process.env.GALLERY_BASE ?? "/",
  server: {
    port: 5173,
    // The shared spec.json files live next to each plugin, outside this app.
    fs: { allow: ["../.."] },
  },
  // The dev-server dependency optimizer drops maplibre-gl's worker chunk
  // (maplibre-gl-worker.mjs 404s and the map never loads); serve it as-is.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  // Keep `/*! ... */` comments in the minified bundle: they carry the
  // licenses of bundled artwork, such as the animated-icon demo catalog's.
  build: { rolldownOptions: { output: { comments: { legal: true } } } },
  lint: { options: { typeAware: true, typeCheck: true } },
});
