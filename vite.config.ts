import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Tauri exposes this when running `tauri dev` on a mobile device / remote host.
const host = process.env.TAURI_DEV_HOST;

// Build metadata surfaced in the About dialog. Read at config time so the values
// are baked into the bundle. Git may be unavailable (tarball builds), so the
// commit hash falls back to "unknown".
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };
let commitHash = 'unknown';
try {
  commitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout; leave "unknown" */
}
const buildDate = new Date().toISOString();

// Must match PDFJS_WASM_PATH in src/core/pdf/setupWorker.ts, which is what gets
// handed to getDocument as `wasmUrl`.
const PDFJS_WASM_PATH = 'pdfjs-wasm/';

/**
 * Serve and emit PDF.js's WebAssembly decoders (JBIG2, JPEG2000, the ICC
 * transform) under a stable, unhashed directory.
 *
 * PDF.js 6 fetches these at run time by appending a filename to the `wasmUrl`
 * directory it was given, so unlike the worker they cannot ride along as a
 * `?url` import: an emitted asset gets a content hash, and the pure-JS
 * fallbacks are loaded from the same base by dynamic `import()`. Copying the
 * directory verbatim is the only shape that satisfies both.
 */
function pdfjsWasmAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('pdfjs-dist/package.json')), 'wasm');
  // The fetched files only. The LICENSE_* siblings are never requested, and
  // quickjs-eval.* (475 kB) is loaded solely by pdf.sandbox.mjs, the embedded-
  // JavaScript sandbox, which Folio does not ship: every render passes
  // enableScripting: false. Revisit this filter if that ever changes.
  const files = readdirSync(dir).filter(
    (f) => /\.(wasm|js)$/.test(f) && !f.startsWith('quickjs-eval'),
  );

  return {
    name: 'folio-pdfjs-wasm',

    // Dev has no bundle to emit into, so serve them straight from the package.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith(`/${PDFJS_WASM_PATH}`)) return next();
        // Matched against the real directory listing rather than sanitised, so
        // a crafted request cannot walk out of it.
        const name = path.slice(PDFJS_WASM_PATH.length + 1);
        if (!files.includes(name)) return next();
        // The .js fallbacks are ES modules loaded by import(); both types have
        // to be exact or the browser refuses them.
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.end(readFileSync(join(dir, name)));
      });
    },

    generateBundle() {
      for (const name of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_WASM_PATH}${name}`,
          source: readFileSync(join(dir, name)),
        });
      }
    },
  };
}

// https://vitejs.dev/config/  +  https://v2.tauri.app/develop/
export default defineConfig({
  plugins: [react(), pdfjsWasmAssets()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Build metadata for the About dialog (compile-time constants).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },

  // Prevent Vite from obscuring Rust errors during `tauri dev`.
  clearScreen: false,

  server: {
    // Tauri expects a fixed port and fails if it is not available.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // Don't reload when the Rust side changes.
    watch: { ignored: ['**/src-tauri/**'] },
  },

  // Only env vars prefixed with these are exposed to the client.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    target: 'es2021',
    // Vite 8 is rolldown-based: 'oxc' is the built-in minifier and the default.
    // 'esbuild' still works but routes chunks through the deprecated
    // `transformWithEsbuild` path, which needs esbuild installed as an optional
    // peer that Vite no longer pulls in. Downlevelling to `target` is done by
    // rolldown either way, so oxc costs nothing and keeps the build self-contained.
    minify: 'oxc',
    sourcemap: true,
  },

  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    // Comfortably above the 30s `interruptAfterTimeLimit` the fast-check setup
    // uses as its DoS backstop. At vitest's 5s default the test was killed
    // first, so the interrupt never fired and a long fuzz run reported a
    // timeout that read like a property failure. Nothing here legitimately
    // takes this long: a 20,000-iteration fuzz pass is a few seconds.
    testTimeout: 60_000,
  },
});
