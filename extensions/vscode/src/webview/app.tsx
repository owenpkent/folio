// Webview entry that mounts the REAL Folio React app inside VS Code.
//
// Folio already runs in a plain browser (its native calls are guarded by
// isTauri()), and a webview is a browser context, so <App/> works here with its
// browser fallbacks. This entry adds three webview-specific bridges:
//   1. the PDF.js worker URL comes from a global the extension injected
//      (the desktop build's `?url` import is swapped out at bundle time);
//   2. the PDF.js WASM decoders come from the same global, since they sit
//      behind a vscode-webview URI rather than at the bundle root;
//   3. Folio's theme follows the VS Code color theme.
import '@/shims/node';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import { setPdfWasmUrl } from '@/core/pdf';
import { loadSource } from '@/state/actions';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { useThemeStore } from '@/theme/themeStore';

import '@/theme/tokens.css';
import '@/styles/global.css';

/** Map the VS Code editor theme (body class) onto Folio's light/dark theme. */
function syncThemeFromVsCode(): void {
  const cls = document.body.classList;
  const dark = cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
  useThemeStore.getState().setTheme(dark ? 'dark' : 'light');
}

async function boot(): Promise<void> {
  const assets = (globalThis as { __FOLIO_ASSETS__?: Record<string, string> }).__FOLIO_ASSETS__;
  if (assets?.['pdfjs-wasm']) setPdfWasmUrl(assets['pdfjs-wasm']);

  syncThemeFromVsCode();
  // VS Code toggles the body class when the user switches themes; follow it live.
  new MutationObserver(syncThemeFromVsCode).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  createRoot(rootEl).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );

  // Load the PDF the extension handed us (fetched by URL under the webview CSP,
  // then passed as bytes so signature detection sees the original file).
  const data = document.getElementById('folio-data') as HTMLElement | null;
  const url = data?.dataset.pdf;
  if (!url) return;
  const name = data?.dataset.name || 'document.pdf';
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await loadSource({ kind: 'bytes', data: bytes, name });
  } catch {
    // loadSource surfaces its own error state; nothing to add here.
  }
}

void boot();
