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

> Loading it from the command line with `--load-extension` will *appear* to work
> and silently do nothing: branded Chrome removed that flag in 137. Use the
> Load unpacked button, or Chromium / Chrome for Testing.

For the desktop hand-off (A) to work, install the Folio desktop app first (it
registers the `folio://` scheme).

## How it works

| Piece | File |
| --- | --- |
| Redirect rules (the interception logic) | `rules.js` |
| Rule installation, context menus, toolbar | `background.js` |
| The in-browser viewer (Folio web build, loads `#file=`) | `dist/` (generated) + `src/core/document/openFromQuery.ts` |

### Why there are two redirect rules

They are not interchangeable, and the difference is measurable.

**Rule 1** matches the URL (`…/foo.pdf`) and fires *before the request is sent*.
The origin serves nothing at all. This is the cheap path, so it carries the
higher priority.

**Rule 2** matches the response's `content-type`, so it can only fire once the
response has arrived: the origin serves the whole PDF, Chrome discards it, and
the viewer fetches it again. That double fetch buys the ability to catch PDFs
whose URL gives no hint (`/download?id=123`), which is most PDFs served from
behind an application.

The rules are dynamic rather than a static ruleset because a static rule cannot
interpolate the matched URL into an extension URL: `extensionPath` takes a fixed
path, and `regexSubstitution` needs the absolute `chrome-extension://` origin,
whose id is not known until install.

## Status & known limits

This is a **preview**.

- **`.pdf` links marked as downloads are still opened in the viewer.** A
  `content-disposition: attachment` on a URL ending in `.pdf` is caught by rule 1
  at the URL stage, before any response headers exist. Rule 2 does respect the
  header. Making rule 1 respect it too would move it to the response stage and
  cost every PDF a double fetch, so the viewer offers a download instead.
- **Authenticated PDFs:** the in-browser viewer (B) fetches with the extension's
  host permissions, so cookie-gated PDFs generally work. The desktop hand-off
  (A) passes only the *URL* to the app, which re-fetches server-side — that works
  for public URLs but not cookie-gated ones (a true byte hand-off would need
  native messaging).
- **Default handler:** Chrome/Windows won't let the extension silently become the
  default; the user confirms via Chrome's prompts / Settings.
- **`file://` PDFs are not handled.** Local files need their own interception
  path and their own verification; the viewer refuses the `file:` scheme rather
  than half-supporting it.
- No options page yet, so the redirect cannot be turned off or scoped per-site.
