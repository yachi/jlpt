import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// sql.js's engine, resolved from this package so the version is the pinned one.
const SQL_WASM = fileURLToPath(new URL("./node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));

/**
 * Ship sql-wasm.wasm at a FIXED path next to index.html, in dev and in build.
 *
 * The app has no network, so the engine must be inside dist/ (Capacitor copies
 * dist/ into the APK and serves it from https://localhost). A fixed, unhashed
 * name means the platform code is just `locateFile: () => SQL_WASM_URL` with no
 * bundler-specific import, and the dist test can check for the file by name.
 */
function sqlWasm(): Plugin {
  return {
    name: "jlpt-sql-wasm",
    configureServer(server) {
      server.middlewares.use("/sql-wasm.wasm", (_req, res) => {
        res.setHeader("Content-Type", "application/wasm");
        res.end(readFileSync(SQL_WASM));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sql-wasm.wasm", source: readFileSync(SQL_WASM) });
    },
  };
}

export default defineConfig({
  // Relative asset URLs: the WebView loads index.html from the app bundle, not
  // from a server root, so absolute "/assets/..." paths would not resolve.
  base: "./",
  plugins: [sqlWasm()],
  // sql.js ships only a CommonJS/UMD build. Excluding it from pre-bundling makes
  // `vite dev` serve it raw ("does not provide an export named 'default'"), so it
  // must be pre-bundled; the wasm is located via locateFile, not the bundler.
  optimizeDeps: { include: ["sql.js"] },
  // The core logic lives in ../src and the word lists in ../data; both are
  // imported directly (data as `?raw`), never copied, so CLI and app share one source.
  server: { fs: { allow: [".."] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Android System WebView is evergreen on minSdk 23+ devices with Play updates.
    target: "es2022",
  },
});
