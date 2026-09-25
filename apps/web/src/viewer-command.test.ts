import { describe, expect, it } from "vite-plus/test";

import { viewerCommand } from "./viewer-command.ts";

interface Example {
  metadata?: {
    "maplibre-plugins:camera"?: {
      center: [number, number];
      zoom: number;
      bearing: number;
      pitch: number;
    };
    "maplibre-plugins:before"?: string;
  };
}

const examples = import.meta.glob<Example>(
  "../../../plugins/particles/examples/*.json",
  { eager: true, import: "default" },
);

/** The `--name value` pairs after `--`. */
function flags(command: string): Record<string, string> {
  const tokens = command.split(" -- ")[1]!.split(" ");
  const result: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 2)
    result[tokens[i]!] = tokens[i + 1]!;
  return result;
}

describe("viewerCommand", () => {
  it("passes every camera field, zeros included, over the viewer's defaults", () => {
    // The viewer defaults to bearing 12 and pitch 30 (types.zig).
    const command = viewerCommand("particles", {
      layer: "../../plugins/particles/examples/fire.json",
      camera: { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 },
      before: undefined,
    });
    expect(command).toBe(
      "mise run //apps/native-viewer:run particles -- --layer ../../plugins/particles/examples/fire.json --center 0,0 --zoom 0 --bearing 0 --pitch 0",
    );
  });

  it("opens every particles example at its own camera and insertion point", () => {
    expect(Object.keys(examples).length).toBeGreaterThan(0);
    for (const [path, example] of Object.entries(examples)) {
      const file = path.slice(path.lastIndexOf("/") + 1);
      const camera = example.metadata?.["maplibre-plugins:camera"];
      const before = example.metadata?.["maplibre-plugins:before"];
      expect(camera, file).toBeDefined();
      const layer = `../../plugins/particles/examples/${file}`;
      const expected: Record<string, string> = {
        "--layer": layer,
        "--center": camera!.center.join(","),
        "--zoom": String(camera!.zoom),
        "--bearing": String(camera!.bearing),
        "--pitch": String(camera!.pitch),
      };
      if (before !== undefined) expected["--before"] = before;
      expect(
        flags(viewerCommand("particles", { layer, camera, before })),
        file,
      ).toEqual(expected);
    }
  });
});
