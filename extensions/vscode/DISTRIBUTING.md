# Distributing the Folio VS Code extension

Three ways to get the extension onto other machines, cheapest first.

## 0. Prerequisites

The extension is fully **bundled** by esbuild (`out/*` is self-contained), so
packaging must skip `node_modules`. Always pass `--no-dependencies`. Before any
of the paths below:

```bash
# from extensions/vscode/
node build.mjs            # produces out/extension.js, out/app.js, out/app.css, out/pdf.worker.min.mjs
```

`vsce` ships in the `@vscode/vsce` package; run it with `npx @vscode/vsce …` (no
global install needed).

## 1. Share a `.vsix` file (no accounts, works everywhere)

Best for internal use, testing, and early access.

```bash
npx @vscode/vsce package --no-dependencies
# -> folio-vscode-0.0.1.vsix
```

Install it on any machine:

```bash
code --install-extension folio-vscode-0.0.1.vsix
```

…or in the Extensions view: **⋯ menu → Install from VSIX…**. The `.vsix` also
installs in VS Code forks (Cursor, Windsurf, VSCodium) the same way.

## 2. VS Code Marketplace (public, one-click install)

Reaches every VS Code user via the Extensions view.

1. **Create a publisher.** Sign in at
   <https://marketplace.visualstudio.com/manage> and create a publisher id.
2. **Set `publisher`** in [package.json](package.json) to that id (currently the
   placeholder `folio`).
3. **Get a Personal Access Token** from Azure DevOps
   (<https://dev.azure.com>): a token with **Marketplace → Manage** scope.
4. **Authenticate and publish:**
   ```bash
   npx @vscode/vsce login <publisher>
   npx @vscode/vsce publish --no-dependencies
   # or bump + publish in one step: vsce publish minor --no-dependencies
   ```

## 3. Open VSX (for Cursor, VSCodium, Windsurf, Gitpod, …)

Those editors read the Open VSX registry, not the Microsoft Marketplace.

1. Create a namespace + token at <https://open-vsx.org>.
2. ```bash
   npx ovsx create-namespace <publisher> -p <token>   # once
   npx ovsx publish folio-vscode-0.0.1.vsix -p <token>
   ```

## Before a public release (checklist)

Marketplace/Open VSX listings expect more than a `.vsix`:

- [ ] Real `publisher` id (not the `folio` placeholder).
- [ ] `icon` field → a 128×128 PNG (Folio's logo lives at
      [`src/assets/folio-logo.svg`](../../src/assets/folio-logo.svg); export a PNG).
- [ ] `repository`, `bugs`, `homepage` fields (inherit Folio's).
- [ ] A `LICENSE` file in this folder (copy the repo's MIT license).
- [ ] A polished `README.md` — it becomes the Marketplace page.
- [ ] `CHANGELOG.md`.
- [ ] Bump `version` on every publish (Marketplace rejects re-publishing a
      version).
- [ ] Decide on the **save bridge** first: shipping a viewer that can't save
      edits in place should be clearly labeled "preview," which the README does.

## CI note

Packaging and publishing are scriptable in CI (GitHub Actions has a
`HaaLeo/publish-vscode-extension` action, or just call `vsce`/`ovsx` with tokens
from secrets). Gate it on a tag so a release tag cuts a Marketplace + Open VSX
release from the same `.vsix`.
