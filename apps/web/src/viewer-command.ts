// The command that opens a gallery preset in the native viewer
// (apps/native-viewer). The viewer reads none of an example's metadata: a
// flag left out takes the viewer's own default (apps/native-viewer/src/
// types.zig: center 37.7749,-122.4194, zoom 13, bearing 12, pitch 30), which
// is not the preset's, so the command passes every camera field, zeros
// included. The viewer's default style is the gallery's basemap, so it needs
// no --style.

import type { PluginEntry } from "./plugins.ts";

type Camera = PluginEntry["camera"];

export interface ViewerPreset {
  /** The example's path from the viewer app, e.g. `../../plugins/particles/examples/fire.json`. */
  layer: string;
  camera: Camera | undefined;
  /** The style layer to insert the layer before. */
  before: string | undefined;
}

/** The `mise` command that opens `preset` in the native viewer with `plugin`'s library. */
export function viewerCommand(plugin: string, preset: ViewerPreset): string {
  const args = [`--layer ${preset.layer}`];
  if (preset.camera) {
    const { center, zoom, bearing, pitch } = preset.camera;
    args.push(
      `--center ${center[0]},${center[1]}`,
      `--zoom ${zoom}`,
      `--bearing ${bearing}`,
      `--pitch ${pitch}`,
    );
  }
  if (preset.before) args.push(`--before ${preset.before}`);
  return `mise run //apps/native-viewer:run ${plugin} -- ${args.join(" ")}`;
}
