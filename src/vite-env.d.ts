/// <reference types="vite/client" />

// Build metadata injected by Vite's `define` (see vite.config.ts).
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __COMMIT_HASH__: string;

/**
 * Whether the self-hosted OCR runtime ships in this build. False for the Chrome
 * extension package, which leaves it out; see vite.config.ts.
 */
declare const __OCR_BUNDLED__: boolean;
