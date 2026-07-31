import { defineConfig } from '@playwright/test';

import base from './playwright.config';

/**
 * The same suite, run against the **production build** served by `vite preview`
 * rather than the dev server.
 *
 * The two are not interchangeable. The dev server ships each module roughly as
 * authored; the build runs everything through rolldown and its minifier, so
 * anything that depends on how modules are bundled is exercised only here. That
 * gap shipped a real bug: the Vite 8 bump (#62) broke digital signing outright,
 * because rolldown and esbuild disagree about what a default import of a
 * CommonJS module means, and nothing in the repo could see it. tsc reads the
 * .d.ts, vitest runs in Node whose interop matches esbuild, and the dev-server
 * e2e run was the only failing signal, which is a coincidence rather than a
 * design: the dep optimizer happened to make the same choice as the bundler.
 *
 * The build is part of the server command on purpose. A stale `dist/` would
 * serve last week's bytes and pass, which is the same trap as a reused dev
 * server, so this never reuses a running one either.
 */
export default defineConfig({
  ...base,
  // Vite's own preview default, kept clear of the dev server's 1420 so both can
  // be up at once.
  use: { ...base.use, baseURL: 'http://localhost:4173' },
  // A sibling of the dev run's `test-results`, which Playwright wipes on start.
  // Sharing it would delete the exports CI feeds to veraPDF.
  outputDir: 'test-results-preview',
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-preview' }]]
    : [['list']],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    // Covers a cold `tsc --noEmit` plus the bundle, both of which the dev
    // server's 120s never has to pay for.
    timeout: 180_000,
  },
});
