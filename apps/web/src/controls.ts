// Spec-driven control rows shared by the plugin panels: a section heading,
// a slider for a float property, a slider pair for a float2 property, a
// dropdown for an enum property, and a color picker with an alpha field.
// Each row's setter also takes a value it cannot show, such as a style
// expression: the row then says "expr" until a control sets a literal.

/** Whether a paint value is a style expression rather than a literal. */
export function isExpression(value: unknown): boolean {
  return Array.isArray(value) && typeof value[0] === "string";
}

import type { NumericPaintPropertySpec } from "@maplibre-plugins/paint";

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

export interface PairRowOptions {
  name: string;
  doc: string;
  initial: readonly [number, number];
  /** Labels of the two components, e.g. ["right", "down"]. Defaults to x and y. */
  components?: readonly [string, string];
  range: [min: number, max: number, step: number];
  onInput(value: [number, number]): void;
}

/**
 * Adds one slider row per component of a float2 property and returns a
 * setter that updates both without firing onInput; null shows that an
 * expression drives the property.
 */
export function pairRow(
  parent: HTMLElement,
  options: PairRowOptions,
): (value: readonly [number, number] | null) => void {
  const value: [number, number] = [options.initial[0], options.initial[1]];
  const components = options.components ?? ["x", "y"];
  const shows = ([0, 1] as const).map((i) =>
    numberRow(parent, {
      name: `${options.name} ${components[i]}`,
      doc: options.doc,
      initial: value[i],
      range: options.range,
      onInput: (component) => {
        value[i] = component;
        options.onInput([value[0], value[1]]);
      },
    }),
  );
  return (next) => {
    if (next === null) {
      shows.forEach((show) => show(null));
      return;
    }
    value[0] = next[0];
    value[1] = next[1];
    shows.forEach((show, i) => show(value[i]!));
  };
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
  onInput(rgba: [number, number, number, number]): void;
}

/**
 * Adds a color row and returns a setter that updates it without firing
 * onInput; an expression leaves the alpha field saying "expr".
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
    options.onInput([rgb[0], rgb[1], rgb[2], a]);
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
