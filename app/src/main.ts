/**
 * App entry: open the platform (which seeds when the bundled lists changed, see
 * platform/open.ts), then start the UI.
 * Any startup error is drawn on screen -- on a phone there is no console.
 */
import "./styles.css";
import { initPlatform } from "./platform";
import { makeCtx } from "./ui/context";
import { startApp } from "./ui/app";
import { h, mount } from "./ui/dom";

const root = document.querySelector<HTMLDivElement>("#app")!;

async function start(): Promise<void> {
  mount(root, h("div", { class: "splash" }, h("p", { class: "jp-lg", lang: "ja" }, "日本語"), h("p", { class: "muted" }, "Loading… (the first launch prepares 5,257 cards)")));
  const platform = await initPlatform();
  // Ask once up front so the first listening card is never the one that finds out.
  const audioOk = await platform.canSpeak().catch(() => false);
  startApp(makeCtx(platform, audioOk), root);
}

start().catch((e: unknown) => {
  mount(root, h("div", { class: "splash error", role: "alert" },
    h("h1", null, "Startup failed"),
    h("p", { class: "pre" }, e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e)),
    h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Retry")));
});
