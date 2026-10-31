/**
 * The shell: a content area and a bottom tab bar (thumb reach on a phone).
 * Each screen is a function that draws into the content area and returns a
 * cleanup, so switching tabs stops timers, key handlers and pending audio
 * callbacks of the screen being left.
 */
import { h, mount } from "./dom";
import type { Ctx } from "./context";
import { studyScreen } from "./study";
import { statsScreen } from "./stats";
import { examScreen } from "./exam";
import { settingsScreen } from "./settings";

type Screen = (ctx: Ctx, root: HTMLElement) => () => void;
const TABS: { id: string; label: string; icon: string; screen: Screen }[] = [
  { id: "study", label: "Study", icon: "学", screen: studyScreen },
  { id: "stats", label: "Stats", icon: "績", screen: statsScreen },
  { id: "exam", label: "Exam", icon: "試", screen: examScreen },
  { id: "settings", label: "Settings", icon: "設", screen: settingsScreen },
];

export function startApp(ctx: Ctx, root: HTMLElement): void {
  const main = h("main", { class: "content", id: "content" });
  const buttons = new Map<string, HTMLButtonElement>();
  let cleanup: () => void = () => {};

  const show = (id: string) => {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0]!;
    cleanup();
    for (const [tid, b] of buttons) b.setAttribute("aria-current", tid === tab.id ? "page" : "false");
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    cleanup = tab.screen(ctx, main);
  };

  const nav = h("nav", { class: "tabbar", "aria-label": "Sections" }, TABS.map((t) => {
    const b = h("button", { type: "button", class: "tab", onclick: () => show(t.id) },
      h("span", { class: "tab-i", lang: "ja", "aria-hidden": "true" }, t.icon),
      h("span", { class: "tab-l" }, t.label));
    buttons.set(t.id, b);
    return b;
  }));

  mount(root, main, nav);
  show("study");
}
