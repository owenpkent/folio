import { Buffer as BufferPolyfill } from 'buffer';

/**
 * The signing stack (@signpdf, node-forge) is written for Node and expects a
 * global `Buffer` (and probes for `process`). The desktop WebView and browser
 * do not provide these, so we install lightweight polyfills. Imported first in
 * main.tsx, before any signing code can run.
 */
const g = globalThis as unknown as Record<string, unknown>;

if (g.Buffer === undefined) g.Buffer = BufferPolyfill;
if (g.process === undefined) g.process = { env: {}, browser: true };
