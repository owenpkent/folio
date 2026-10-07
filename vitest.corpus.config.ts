import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the corpus harness is opt-in
// (`npm run test:corpus`) and must never be picked up by `npm test` or CI,
// whose include glob is src/** only. See docs/testing.md.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify('corpus'),
    __BUILD_DATE__: JSON.stringify(''),
    __COMMIT_HASH__: JSON.stringify('corpus'),
    __OCR_BUNDLED__: JSON.stringify(false),
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['scripts/corpus/**/*.harness.test.ts'],
    // The harness enforces its own per-file timeout; the run as a whole is
    // allowed to take as long as the corpus needs.
    testTimeout: 0,
    hookTimeout: 0,
    server: {
      deps: {
        // Copied from vite.config.ts: undici 8 dies in Vitest's module runner.
        external: [/undici/],
      },
    },
  },
});
