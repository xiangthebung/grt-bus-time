/** Small DOM helpers shared by the popup. */

export function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Popup markup is missing ${selector}.`);
  return element;
}

export function queryAll<T extends Element>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

interface ElementOptions {
  className?: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  dataset?: Record<string, string>;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: ElementOptions = {},
  children: (Node | string | undefined | false)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);
  for (const [key, value] of Object.entries(options.dataset ?? {})) {
    node.dataset[key] = value;
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(
  className: string,
  options: ElementOptions & { onClick?: () => void } = {},
  children: (Node | string | undefined | false)[] = [],
): HTMLButtonElement {
  const node = element("button", { ...options, className }, children);
  node.type = "button";
  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

/** Inline icon from a path definition, sized by CSS. */
export function icon(path: string, filled = false): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  node.setAttribute("fill", filled ? "currentColor" : "none");
  if (!filled) {
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", "1.7");
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
  }
  svg.append(node);
  return svg;
}

export const ICONS = {
  bell: "M12 4a5 5 0 0 0-5 5v3.5L5.5 15.5h13L17 12.5V9a5 5 0 0 0-5-5Zm-2 13a2 2 0 0 0 4 0",
  bellOff:
    "M12 4a5 5 0 0 0-5 5v3.5L5.5 15.5h13L17 12.5V9a5 5 0 0 0-5-5Zm-2 13a2 2 0 0 0 4 0M4 4l16 16",
  close: "M6 6l12 12M18 6L6 18",
} as const;
