// A census worker (census.ts): bakes one Lottie file per message, in
// memory, at the census's frame rate and default limits, and posts back
// how it went.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parentPort } from "node:worker_threads";

import { bakeAnimation, packAnimations } from "./bake.ts";
import {
  type BakeResult,
  CENSUS_DISPLAY_PX,
  CENSUS_FPS,
  outcomeOf,
} from "./census.ts";

async function bakeOne(path: string): Promise<BakeResult> {
  try {
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    const baked = await bakeAnimation(
      { name: "census", file: basename(path), displayPx: CENSUS_DISPLAY_PX },
      json,
      { fps: CENSUS_FPS },
    );
    const [report] = packAnimations([baked]).animations;
    return {
      outcome: "baked",
      fallbacks: baked.stats.fallbacks.length,
      ...(report ? { visits: report.visits, bytes: report.bytes } : {}),
    };
  } catch (error) {
    return { ...outcomeOf(error), fallbacks: 0 };
  }
}

parentPort?.on("message", (message: { index: number; path: string }) => {
  void bakeOne(message.path).then((result) => {
    parentPort?.postMessage({ index: message.index, result });
  });
});
