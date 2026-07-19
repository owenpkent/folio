import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
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

// https://vitejs.dev/config/  +  https://v2.tauri.app/develop/
export default defineConfig({
  plugins: [react()],

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
    minify: 'esbuild',
    sourcemap: true,
  },

  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
