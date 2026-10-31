/**
 * The one DOM helper the screens share. No framework: the app is four screens
 * of buttons and text, and a framework would be most of the bundle.
 */
type Attr = string | number | boolean | null | undefined | ((ev: Event) => void);
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, Attr> | null = null, ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? String(c) : c);
  }
  return el;
}

/** Replace a container's content in one step, so a re-render never flashes empty. */
export function mount(root: HTMLElement, ...children: (Child | Child[])[]): void {
  root.replaceChildren(...children.flat().filter((c): c is Node | string =>
    c !== null && c !== undefined && c !== false).map((c) => typeof c === "number" ? String(c) : c));
}

/**
 * Split a Question.reveal ("expr【reading】— meaning", maybe followed by
 * sentence lines) into parts for display. The format is built in quiz.ts
 * buildQuestion; falling back to the raw string keeps a future format change
 * legible rather than blank.
 */
export function parseReveal(reveal: string): { expression: string; reading: string; meaning: string; extra: string } | null {
  const [head = "", ...rest] = reveal.split("\n");
  const m = head.match(/^(.+?)【(.+?)】— (.*)$/);
  if (!m) return null;
  return { expression: m[1]!, reading: m[2]!, meaning: m[3]!, extra: rest.map((s) => s.trim()).join("\n") };
}

export function revealBlock(reveal: string): HTMLElement {
  const p = parseReveal(reveal);
  if (!p) return h("div", { class: "reveal" }, h("p", { class: "pre" }, reveal));
  return h("div", { class: "reveal" },
    h("div", { class: "reveal-word", lang: "ja" },
      h("span", { class: "jp-lg" }, p.expression),
      p.reading !== p.expression ? h("span", { class: "jp-reading" }, `【${p.reading}】`) : null),
    h("p", { class: "reveal-meaning" }, p.meaning),
    p.extra ? h("p", { class: "pre jp", lang: "ja" }, p.extra) : null);
}
