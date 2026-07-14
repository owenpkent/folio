# Folio Chrome extension (preview)

Open PDFs in Folio from the browser, two ways:

- **In-browser viewer (B):** PDF page navigations are redirected to Folio's own
  viewer (the bundled web build), replacing Chrome's built-in PDF reader.
- **Desktop hand-off (A):** right-click a PDF link or the PDF page, or click the
  toolbar icon, to **Open in Folio (desktop)** via the `folio://` deep link the
  desktop app registers.

## Build & load

```bash
node extensions/chrome/build.mjs      # builds Folio's web app into dist/, copies the icon
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `extensions/chrome`.

For the desktop hand-off (A) to work, install the Folio desktop app first (it
registers the `folio://` scheme).

## How it works

| Piece | File |
| --- | --- |
| Context menus + toolbar → `folio://open?url=…` | `background.js` |
| PDF → in-browser viewer redirect (dynamic `declarativeNetRequest`) | `background.js` |
| The in-browser viewer (Folio web build, loads `#file=<url>`) | `dist/` (generated) + `src/core/document/openFromQuery.ts` |

## Status & known limits

This is a **preview** and needs a manual Chrome load-test:

- **Authenticated PDFs:** the in-browser viewer (B) fetches with the extension's
  host permissions, so cookie-gated PDFs generally work. The desktop hand-off
  (A) passes only the *URL* to the app, which re-fetches server-side — that works
  for public URLs but not cookie-gated ones (a true byte hand-off would need
  native messaging).
- **Default handler:** Chrome/Windows won't let the extension silently become the
  default; the user confirms via Chrome's prompts / Settings.
- The `regexFilter` matches `*.pdf` URLs; PDFs served without a `.pdf` path
  (content-type only) aren't caught yet.
