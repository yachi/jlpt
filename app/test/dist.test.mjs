// Checks the BUILT app (run `npm run build` first), because the risks are in
// what Vite emits, not in the source: the wasm must be in dist/ (no network on
// device), and no Bun/Node module may have been pulled into the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(join(dist, "index.html"));
const skip = built ? false : "dist/ not built; run npm run build";

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("sql-wasm.wasm ships at the fixed path and is a valid module", { skip }, async () => {
  const bytes = readFileSync(join(dist, "sql-wasm.wasm"));
  await WebAssembly.compile(bytes);
});

test("no bun: or node: imports leaked into the bundle", { skip }, () => {
  for (const f of files(dist).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /["'](bun|node):[a-z]/, f);
  }
});

test("asset URLs are relative, so the WebView resolves them from the bundle", { skip }, () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/);
});
