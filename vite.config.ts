import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri exposes this when running `tauri dev` on a mobile device / remote host.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/  +  https://v2.tauri.app/develop/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
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
