// Spec-driven control rows shared by the plugin panels: a section heading,
// a slider for a float property, a slider pair for a float2 property, a
// dropdown for an enum property, and a color picker with an alpha field.
// Each row's setter also takes a value it cannot show, such as a style
// expression: the row then says "expr" until a control sets a literal.
// renderSpecControls, further down, builds a whole panel from a spec.json
// paint table with the same rows.

/** Whether a paint value is a style expression rather than a literal. */
export function isExpression(value: unknown): boolean {
  return Array.isArray(value) && typeof value[0] === "string";
}

import type {
  NumericPaintPropertySpec,
  PaintPropertySpec,
} from "@maplibre-plugins/paint";

import { cssColor } from "./layer-json.ts";

export function section(panel: HTMLElement, title: string): HTMLElement {
  const el = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = title;
  el.append(h);
  panel.append(el);
  return el;
}

export interface NumberRowOptions {
  name: string;
  doc: string;
  initial: number;
  range: [min: number, max: number, step: number];
  onInput(value: number): void;
}

/**
 * Adds a slider row and returns a setter that updates it without firing
 * onInput; null shows that an expression drives the property.
 */
export function numberRow(
  parent: HTMLElement,
  options: NumberRowOptions,
): (value: number | null) => void {
  const [min, max, step] = options.range;
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.textContent = options.name;
  label.title = options.doc;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const output = document.createElement("output");
  const show = (value: number | null) => {
    if (value === null) {
      output.textContent = "expr";
      return;
    }
    input.value = String(value);
    output.textContent = Number.isInteger(step)
      ? String(Math.round(value))
      : value.toFixed(2);
  };
  show(options.initial);
  input.addEventListener("input", () => {
    const value = Number(input.value);
    show(value);
    options.onInput(value);
  });
  row.append(label, input, output);
  parent.append(row);
  return show;
}

type Range = [min: number, max: number, step: number];

export interface PairRowOptions {
  name: string;
  doc: string;
  initial: readonly [number, number];
  /** Labels of the two components, e.g. ["right", "down"]. Defaults to x and y. */
  components?: readonly [string, string];
  /** Both sliders' [min, max, step], or one per component. */
  range: Range | readonly [Range, Range];
  onInput(value: [number, number]): void;
}

/**
 * Adds a row with one labeled slider per component of a float2 property and
 * returns a setter that updates both without firing onInput; null shows
 * that an expression drives the property.
 */
export function pairRow(
  parent: HTMLElement,
  options: PairRowOptions,
): (value: readonly [number, number] | null) => void {
  const row = labeledRow(parent, "row pair", options.name, options.doc);
  const names = options.components ?? ["x", "y"];
  const { range } = options;
  const ranges = isRangePair(range) ? range : [range, range];
  const value: [number, number] = [options.initial[0], options.initial[1]];
  const sliders = ([0, 1] as const).map((i) => {
    const cell = document.createElement("div");
    cell.className = "component";
    const caption = document.createElement("span");
    caption.textContent = names[i];
    const control = slider(ranges[i], "linear", (next) => {
      value[i] = next;
      options.onInput([value[0], value[1]]);
    });
    cell.append(caption, control.output, control.input);
    row.append(cell);
    return control;
  });
  const show = (next: readonly [number, number] | null) => {
    if (next === null) {
      for (const control of sliders) control.output.textContent = "expr";
      return;
    }
    value[0] = next[0];
    value[1] = next[1];
    sliders.forEach((control, i) => control.show(value[i]!));
  };
  show(options.initial);
  return show;
}

function isRangePair(
  range: Range | readonly [Range, Range],
): range is readonly [Range, Range] {
  return Array.isArray(range[0]);
}

export interface SelectRowOptions {
  name: string;
  doc: string;
  values: readonly string[];
  initial: string;
  onInput(value: string): void;
}

/**
 * Adds a dropdown row for an enum property and returns a setter that
 * updates it without firing onInput; null shows that an expression drives
 * the property.
 */
export function selectRow(
  parent: HTMLElement,
  options: SelectRowOptions,
): (value: string | null) => void {
  const row = document.createElement("div");
  row.className = "row wide";
  const label = document.createElement("label");
  label.textContent = options.name;
  label.title = options.doc;
  const select = document.createElement("select");
  for (const value of options.values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  let expression: HTMLOptionElement | null = null;
  const show = (value: string | null) => {
    if (value === null) {
      if (!expression) {
        expression = document.createElement("option");
        expression.textContent = "(expression)";
        expression.disabled = true;
        select.prepend(expression);
      }
      expression.selected = true;
      return;
    }
    select.value = value;
  };
  show(options.initial);
  select.addEventListener("change", () => options.onInput(select.value));
  row.append(label, select);
  parent.append(row);
  return show;
}

export interface ColorRowOptions {
  name: string;
  doc: string;
  initial: unknown;
  /** Receives the picked color as a CSS `rgba()` string. */
  onInput(color: string): void;
}

/**
 * Adds a color row and returns a setter that updates it without firing
 * onInput; an expression leaves the alpha field saying "expr". It hands out
 * CSS strings, the only color literal the native host takes (it rejects the
 * whole layer for a float array); the picker is 8-bit anyway.
 */
export function colorRow(
  parent: HTMLElement,
  options: ColorRowOptions,
): (value: unknown) => void {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.textContent = options.name;
  label.title = options.doc;
  const color = document.createElement("input");
  color.type = "color";
  const alpha = document.createElement("input");
  alpha.type = "number";
  alpha.min = "0";
  alpha.max = "1";
  alpha.step = "0.05";
  alpha.title = "alpha";
  alpha.placeholder = "expr";
  const show = (value: unknown) => {
    if (isExpression(value)) {
      alpha.value = "";
      return;
    }
    const rgba = toRgba(value);
    color.value = toHex(rgba);
    alpha.value = rgba[3].toFixed(2);
  };
  show(options.initial);
  const apply = () => {
    const rgb = fromHex(color.value);
    // An emptied alpha field (after an expression) means opaque.
    const a = alpha.value === "" ? 1 : Number(alpha.value);
    alpha.value = a.toFixed(2);
    options.onInput(cssColor([rgb[0], rgb[1], rgb[2], a]));
  };
  color.addEventListener("input", apply);
  alpha.addEventListener("change", apply);
  row.append(label, color, alpha);
  parent.append(row);
  return show;
}

/** The slider range for a float property: the spec's bounds, else a supplied fallback. */
export function sliderRange(
  spec: NumericPaintPropertySpec,
  fallback?: [number, number, number],
): [number, number, number] {
  if (spec.type === "rotation") return [0, 360, 1];
  if (fallback) return fallback;
  return [spec.minimum ?? 0, spec.maximum ?? 1, 0.01];
}

export function toRgba(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4) {
    return [
      Number(value[0]),
      Number(value[1]),
      Number(value[2]),
      Number(value[3]),
    ];
  }
  if (typeof value === "string") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255, a / 255];
  }
  return [0, 0, 0, 1];
}

function toHex(rgba: [number, number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.min(Math.max(v, 0), 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgba[0])}${channel(rgba[1])}${channel(rgba[2])}`;
}

function fromHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Rows for the richer spec.json schema of a plugin with several layer types
// (plugins/particles): latitude and longitude fields for a double2, and
// renderSpecControls, which builds every row of one layer type from the spec
// alone, grouped under collapsible headings.

/** A spec.json paint property, including the keys only the gallery and README read. */
export type SpecProperty = PaintPropertySpec & SpecDocs;

/** The keys of a spec.json paint property that only the gallery and README read. */
export interface SpecDocs {
  /** The heading the property is listed under. */
  readonly group?: string;
  readonly units?: string;
  readonly doc?: string;
  /** A float's slider: [min, max, step], and whether it moves on a log scale. */
  readonly ui?: {
    readonly range?: readonly number[];
    readonly scale?: string;
  };
  /** A float2's components: each one's label and slider [min, max, step]. */
  readonly components?: readonly {
    readonly name: string;
    readonly ui?: readonly number[];
  }[];
}

export interface Double2RowOptions {
  name: string;
  doc: string;
  initial: readonly [number, number];
  /** Labels of the two fields. Defaults to latitude and longitude. */
  components?: readonly [string, string];
  onInput(value: [number, number]): void;
}

/**
 * Adds a row of two number fields for a double2 property, such as a
 * [latitude, longitude] position, and returns a setter that updates both
 * without firing onInput.
 */
export function double2Row(
  parent: HTMLElement,
  options: Double2RowOptions,
): (value: readonly [number, number]) => void {
  const row = labeledRow(parent, "row pair double2", options.name, options.doc);
  const components = options.components ?? ["latitude", "longitude"];
  const value: [number, number] = [options.initial[0], options.initial[1]];
  const inputs = ([0, 1] as const).map((i) => {
    const cell = document.createElement("div");
    cell.className = "component";
    const caption = document.createElement("span");
    caption.textContent = components[i];
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.title = components[i];
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (input.value === "" || !Number.isFinite(next)) return;
      value[i] = next;
      options.onInput([value[0], value[1]]);
    });
    cell.append(caption, input);
    row.append(cell);
    return input;
  });
  const show = (next: readonly [number, number]) => {
    value[0] = next[0];
    value[1] = next[1];
    // Five decimals of a degree is about a meter.
    inputs.forEach((input, i) => {
      input.value = String(round(value[i]!, 5));
    });
  };
  show(options.initial);
  return show;
}

export interface SpecControlsOptions {
  /** A spec.json paint table, doc-only keys included. */
  spec: Readonly<Record<string, SpecProperty>>;
  /** The properties to show, in order: one layer type's list. */
  names: readonly string[];
  /** A property's current raw value: a literal or an expression. */
  get(name: string): unknown;
  /** Applies a literal from a control. Throwing marks the row invalid. */
  set(name: string, value: unknown): void;
}

/** Groups the reader collapsed, remembered while the page lives so a rebuild keeps them shut. */
const closedGroups = new Set<string>();

/**
 * Adds one row per property, the right kind for its type, under a
 * collapsible heading per spec `group` in order of first appearance, and
 * returns a function that re-reads every value through `get`.
 *
 * A value that is an expression keeps its row, dimmed, and gets an "expr"
 * badge whose tooltip holds the expression. The row shows the spec default,
 * or "(expression)" in a dropdown. Changing the control replaces the
 * expression with the literal it then shows, and clicking the badge replaces
 * it with the default: a slider or color picker already showing the default
 * fires nothing when set to it again.
 */
export function renderSpecControls(
  parent: HTMLElement,
  options: SpecControlsOptions,
): () => void {
  const groups = new Map<string, HTMLElement>();
  const syncs: Array<() => void> = [];
  for (const name of options.names) {
    const spec = options.spec[name];
    if (!spec) throw new Error(`No spec for paint property ${name}`);
    const group = spec.group ?? "other";
    let body = groups.get(group);
    if (!body) {
      const count = options.names.filter(
        (other) => (options.spec[other]?.group ?? "other") === group,
      ).length;
      body = specGroup(parent, group, count);
      groups.set(group, body);
    }
    const holder = document.createElement("div");
    holder.className = "property";
    holder.dataset.name = name;
    body.append(holder);
    const apply = (value: unknown) => {
      try {
        options.set(name, value);
      } catch (error) {
        holder.classList.add("invalid");
        holder.title = error instanceof Error ? error.message : String(error);
        return;
      }
      holder.classList.remove("invalid");
      holder.removeAttribute("title");
      markExpression(holder, undefined);
    };
    const show = specRow(holder, name, spec, apply);
    const sync = () => {
      const value = options.get(name);
      const literal = isLiteral(spec, value);
      show(literal ? value : undefined);
      markExpression(holder, literal ? undefined : value, useDefault);
    };
    const useDefault = () => {
      apply(defaultLiteral(spec));
      sync();
    };
    sync();
    syncs.push(sync);
  }
  return () => syncs.forEach((sync) => sync());
}

/** A collapsible group heading; returns the element its rows go in. */
function specGroup(
  parent: HTMLElement,
  group: string,
  count: number,
): HTMLElement {
  const details = document.createElement("details");
  details.className = "group";
  details.open = !closedGroups.has(group);
  details.addEventListener("toggle", () => {
    if (details.open) closedGroups.delete(group);
    else closedGroups.add(group);
  });
  const summary = document.createElement("summary");
  summary.textContent = group;
  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);
  summary.append(badge);
  const body = document.createElement("div");
  details.append(summary, body);
  parent.append(details);
  return body;
}

/**
 * Builds the row for one property's type and returns a setter taking a
 * literal, or undefined for an expression: the row then shows the spec
 * default, or "(expression)" in a dropdown.
 */
function specRow(
  parent: HTMLElement,
  name: string,
  spec: SpecProperty,
  apply: (value: unknown) => void,
): (value: unknown) => void {
  const doc = describe(spec);
  const shown = (value: unknown) =>
    value === undefined ? spec.default : value;
  switch (spec.type) {
    case "enum": {
      const show = selectRow(parent, {
        name,
        doc,
        values: spec.values,
        initial: spec.default,
        onInput: apply,
      });
      return (value) => show(typeof value === "string" ? value : null);
    }
    case "float2": {
      const component = (i: 0 | 1) => spec.components?.[i];
      const range = (i: 0 | 1) => toRange(component(i)?.ui, [-100, 100, 0.1]);
      const show = pairRow(parent, {
        name,
        doc,
        initial: pair(spec.default),
        components: [component(0)?.name ?? "x", component(1)?.name ?? "y"],
        range: [range(0), range(1)],
        onInput: apply,
      });
      return (value) => show(pair(shown(value)));
    }
    case "double2": {
      const show = double2Row(parent, {
        name,
        doc,
        initial: pair(spec.default),
        onInput: apply,
      });
      return (value) => show(pair(shown(value)));
    }
    case "color": {
      const show = colorRow(parent, {
        name,
        doc,
        initial: spec.default,
        onInput: apply,
      });
      return (value) => show(shown(value));
    }
    case "float":
    case "rotation": {
      const row = labeledRow(parent, "row", name, doc);
      const control = slider(
        toRange(spec.ui?.range, sliderRange(spec)),
        spec.ui?.scale === "log" ? "log" : "linear",
        apply,
      );
      row.append(control.input, control.output);
      return (value) => control.show(Number(shown(value)));
    }
  }
}

/** The spec default as the literal its row applies: a color as a CSS string. */
function defaultLiteral(spec: SpecProperty): unknown {
  switch (spec.type) {
    case "color":
      return Array.isArray(spec.default)
        ? cssColor(spec.default as readonly number[])
        : spec.default;
    case "float2":
    case "double2":
      return pair(spec.default);
    default:
      return spec.default;
  }
}

/** Whether a raw value is a literal of the property's type rather than an expression. */
function isLiteral(spec: PaintPropertySpec, value: unknown): boolean {
  switch (spec.type) {
    case "enum":
      return typeof value === "string";
    case "color":
      return typeof value === "string" || isNumbers(value, 4);
    case "float2":
    case "double2":
      return isNumbers(value, 2);
    case "float":
    case "rotation":
      return typeof value === "number";
  }
}

function isNumbers(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === "number")
  );
}

/**
 * Shows or clears the "expr" badge of a property's row. Clicking the badge,
 * or Enter or Space on it, calls `replace`.
 */
function markExpression(
  holder: HTMLElement,
  expression: unknown,
  replace?: () => void,
): void {
  const isExpression = expression !== undefined;
  holder.classList.toggle("expr", isExpression);
  let badge = holder.querySelector<HTMLElement>(".badge");
  if (!isExpression) {
    badge?.remove();
    return;
  }
  if (!badge) {
    // A span, not a button: a button inside the label would become its
    // labeled control, and a click on the name would press it.
    badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "expr";
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;
    badge.addEventListener("click", () => replace?.());
    badge.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      replace?.();
    });
    holder.querySelector("label")?.prepend(badge);
  }
  badge.title = `${JSON.stringify(expression)}\nClick to replace it with the default, or change the control.`;
}

/** A row's tooltip: the doc, then the units and the default. */
function describe(spec: SpecProperty): string {
  const lines = [spec.doc ?? ""];
  if (spec.units) lines.push(`Units: ${spec.units}`);
  lines.push(`Default: ${JSON.stringify(spec.default)}`);
  return lines.join("\n");
}

function labeledRow(
  parent: HTMLElement,
  className: string,
  name: string,
  doc: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = className;
  const label = document.createElement("label");
  label.textContent = name;
  label.title = doc;
  row.append(label);
  parent.append(row);
  return row;
}

interface Slider {
  input: HTMLInputElement;
  output: HTMLOutputElement;
  /** Moves the slider to a value and shows it, without firing onInput. */
  show(value: number): void;
}

/** Positions of a log-scale slider. */
const LOG_STEPS = 1000;

/**
 * A range input and its readout. On a log scale the input runs through
 * positions 0..LOG_STEPS while value - min + 1 grows geometrically, so each
 * decade gets the same travel and min itself (often 0) stays reachable.
 */
function slider(
  range: Range,
  scale: "linear" | "log",
  onInput: (value: number) => void,
): Slider {
  const [min, max, step] = range;
  const places = decimals(step);
  const input = document.createElement("input");
  input.type = "range";
  const output = document.createElement("output");
  const span = Math.log(max - min + 1);
  let toValue = (position: number) => position;
  let toPosition = (value: number) => value;
  if (scale === "log") {
    input.min = "0";
    input.max = String(LOG_STEPS);
    input.step = "1";
    toValue = (position) => {
      const value = min + Math.exp((position / LOG_STEPS) * span) - 1;
      return round(Math.min(Math.round(value / step) * step, max), places);
    };
    toPosition = (value) =>
      Math.round((LOG_STEPS * Math.log(Math.max(value - min, 0) + 1)) / span);
  } else {
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
  }
  const readout = (value: number) => {
    output.textContent = value.toFixed(
      Math.max(places, Math.min(3, decimals(value))),
    );
  };
  input.addEventListener("input", () => {
    const value = toValue(Number(input.value));
    readout(value);
    onInput(value);
  });
  return {
    input,
    output,
    show: (value) => {
      input.value = String(toPosition(value));
      readout(value);
    },
  };
}

/** Decimal places a number is written with, e.g. 2 for 0.05. */
function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 || text.includes("e") ? 0 : text.length - dot - 1;
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

function toRange(ui: readonly number[] | undefined, fallback: Range): Range {
  const [min, max, step] = ui ?? [];
  return min !== undefined && max !== undefined && step !== undefined
    ? [min, max, step]
    : fallback;
}

function pair(value: unknown): [number, number] {
  return isNumbers(value, 2)
    ? [(value as number[])[0]!, (value as number[])[1]!]
    : [0, 0];
}
