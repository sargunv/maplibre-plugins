// Dashed strokes (`st.d`, `gs.d`) with any number of dash/gap pairs, as
// Chromium draws lottie-web's SVG `stroke-dasharray` and
// `stroke-dashoffset` (lottie-web's DashProperty.js:35-60 hands them over;
// Skia's SkDashPath dashes them): the pattern restarts on every contour,
// and on a closed contour a dash that runs through the start joins the
// last dash to the first, so the stroke turns the corner there with a
// join instead of two caps. canvaskit's makeDashed takes only one pair, so
// this walks each contour with ContourMeasureIter.getSegment instead.
//
// Callers scale the path to device pixels first: the contour measure
// flattens curves to about half a unit (resScale 1).

import type { CanvasKit, Path } from "canvaskit-wasm";

/** Path commands as Path.toCmds writes them. */
export type Cmds = number[];

/** The on-intervals of a pattern along a contour of `length`. */
export function dashSpans(
  length: number,
  intervals: readonly number[],
  offset: number,
): [number, number][] {
  const period = intervals.reduce((sum, x) => sum + x, 0);
  if (!(period > 0) || !(length > 0)) return [];
  const n = intervals.length;
  // Where the pattern stands at the contour's start.
  let d = -(((offset % period) + period) % period);
  let k = 0;
  // Skia's find_first_interval: skip an interval that ends before the
  // start, or exactly at it unless it is empty. So a zero-length dash at the
  // start stays (a dot), and a dash that ends exactly there does not.
  for (;;) {
    const size = intervals[k % n] as number;
    if (!(d + size < 0 || (d + size === 0 && size > 0))) break;
    d += size;
    k += 1;
  }
  const spans: [number, number][] = [];
  // Bounded by the period: at most length / period + 2 rounds of the list.
  while (d < length) {
    const size = intervals[k % n] as number;
    if (k % 2 === 0) {
      const a = Math.max(0, d);
      const b = Math.min(length, d + size);
      // A zero-length dash is kept too: Skia's getSegment(d, d) emits a
      // zero-length line, which round and square caps turn into a dot, as
      // Chromium draws stroke-dasharray="0 g".
      if (b >= a) spans.push([a, b]);
    }
    d += size;
    k += 1;
  }
  return spans;
}

function segment(
  ck: CanvasKit,
  contour: import("canvaskit-wasm").ContourMeasure,
  a: number,
  b: number,
  moveTo: boolean,
): Cmds {
  const path = contour.getSegment(a, b, moveTo);
  const cmds = Array.from(path.toCmds());
  path.delete();
  // Without the move, getSegment still starts with one; drop it.
  if (!moveTo && cmds[0] === ck.MOVE_VERB) cmds.splice(0, 3);
  return cmds;
}

/**
 * The dashes of `path` (already in device pixels) as open contours, with
 * the intervals and offset in the same units.
 */
export function dashPath(
  ck: CanvasKit,
  path: Path,
  intervals: readonly number[],
  offset: number,
): Cmds {
  const out: Cmds = [];
  const iter = new ck.ContourMeasureIter(path, false, 1);
  for (let contour = iter.next(); contour; contour = iter.next()) {
    const length = contour.length();
    const spans = dashSpans(length, intervals, offset);
    const first = spans[0];
    const last = spans.at(-1);
    const joined =
      contour.isClosed() &&
      spans.length > 1 &&
      first !== undefined &&
      last !== undefined &&
      first[0] === 0 &&
      last[1] === length;
    spans.forEach(([a, b], k) => {
      if (joined && k === 0) return;
      out.push(...segment(ck, contour, a, b, true));
      if (joined && k === spans.length - 1) {
        out.push(
          ...segment(ck, contour, 0, (first as [number, number])[1], false),
        );
      }
    });
    contour.delete();
  }
  iter.delete();
  return out;
}
