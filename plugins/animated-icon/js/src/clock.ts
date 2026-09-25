// The animation clock every layer on the page shares, like the native
// plugin's exported mln_animated_icon_clock_seconds: seconds since page load
// (performance.now), wrapped to [0, 4096) as FORMAT.md "Timing" says, so the
// f32 playhead keeps millisecond steps. Restart an icon by subtracting a
// reading from it, for example as feature-state; never use wall-clock time,
// whose f32 steps are minutes long.

import { wrapClock } from "./catalog.ts";

let override: number | null = null;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** The clock the layers draw with: seconds in [0, 4096), or the override. */
export function clockSeconds(): number {
  return override ?? wrapClock(now() / 1000);
}

/**
 * Pins the clock at `seconds`, wrapped to [0, 4096), for deterministic
 * renders such as tests and screenshots, like the native
 * mln_animated_icon_set_clock; null (or any non-finite value) restores the
 * live clock. The map shows the change on its next repaint.
 */
export function setClockOverride(seconds: number | null): void {
  override =
    seconds === null || !Number.isFinite(seconds) ? null : wrapClock(seconds);
}
