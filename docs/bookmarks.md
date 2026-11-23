# Bookmarks: prior art and design

Status: deferred, 2026-11-23. The actual need was resuming reading, which is
covered by [reading-position.md](reading-position.md). Keep this as the design
for when outline editing is wanted.

Folio already reads and shows a PDF's outline (Acrobat calls it "bookmarks")
in the Outline sidebar tab. This note covers making it editable: add, rename,
delete, reorder, nest.

## Prior art

The full research, with what was checked and what wasn't, is in
[bookmarks-research.md](bookmarks-research.md). Summary:

| Product | Where bookmarks live | Notes |
| --- | --- | --- |
| Adobe Acrobat | In the file (`/Outlines`) | Selected text becomes the title. The destination is the current view (page plus position plus zoom). "Set Destination" re-points one. |
| PDF-XChange Editor | In the file (`/Outlines`) | Has the options "use selected text as title" and "use selected region as destination". Ctrl+Shift+B. Can generate bookmarks from page text. |
| PyMuPDF `set_toc` | In the file | Takes a flat `[level, title, page]` list. It drops position, zoom, colour and style. |
| macOS Preview | In the file, but in a private XML stream | Other viewers can't see them. Cmd+D. |
| Okular | App-local `bookmarks.xml`, keyed by path | Kept separate from the TOC. Refuses outline editing ("not a PDF editor", KDE bug 377454). |
| SumatraPDF | App-local settings file, keyed by path | "Favorites". Lost when the file moves. |
| Zathura | App-local plain file or sqlite | `:bmark` / `:blist`. |
| Skim | File extended attributes or a `.skim` sidecar | Can export a "PDF with embedded notes", the closest example of offering both. |
| pdf.js, Chrome | Read-only outline | There's an "Edit PDF outline" idea on Mozilla Connect, with no work under way. |

There are two schools:

- **Write into the file.** Portable and standard, but it modifies the file. That breaks signatures, and on a protected file it would need decryption.
- **App-local sidecar.** Never touches the file, and works on read-only, signed and protected files. But it isn't shared, and when the key is the path, moving the file loses the bookmarks.

No product found does both well. Folio's existing sidecar keys on a content hash
(`core/document/contentKey.ts`) instead of the path, so a move or rename does not
lose sidecar state. That removes the main weakness of the sidecar school.

## Where it plugs in

- **Read** (`PdfJsEngine.getOutline`, `PdfJsEngine.ts:495`). The `OutlineNode` type keeps only title, page and children. Editing needs a lossless model, or a round trip would silently drop data. The model must keep:
  - the destination's position and zoom
  - `/C` colour
  - `/F` bold and italic
  - the open or closed state (sign of `/Count`)
  - non-GoTo actions (URI, launch, named), carried through untouched.

  pdf.js `getOutline()` already returns most of these fields.
- **Write.** pdf-lib has no outline helper, so we build the tree with `PDFDict` and `PDFName`, as `pageops/mutate.ts:270` does for AcroForm. We have to:
  - keep `/First`, `/Last`, `/Prev`, `/Next` and `/Parent` consistent
  - recompute `/Count`
  - use UTF-16BE (with BOM) titles
  - release replaced items so `gc.ts` sweeps them.
- **Save** (`features/export/saveDocument.ts`). Every save is already a full rewrite that stamps sidecar items (annotations, signatures, OCR, edits) at export. A `stampOutline` step slots in beside `stampAnnotations`, so bookmark edits live as a sidecar draft until the file is saved.
- **Concurrency.** Writes go through `withDocumentMutation`, which needs a new `'bookmarks'` owner in `state/documentMutationStore.ts`.
- **Page ops.** Bookmark destinations follow page refs, so a reorder keeps them. A delete leaves a dangling destination, which gc scrubs. Two fixes are needed:
  - the draft is remapped in `pageops/pageState.ts` (`remapPageState`)
  - `reloadEditedBytes` (`state/actions.ts:246`) must re-read the outline, because today it does not.
- **Protected and signed files.** Policy (2026-10-07) is that protected PDFs are view, fill and print only, with a planned `canEdit()` gate. That gate does not exist yet: `canEdit` has no hits in `src/`. Redaction already refuses signed documents. A full rewrite invalidates a signature, so signed files need the same rule here.
- **Commands** (`commands/defaultCommands.ts`). `Mod+B` is taken by "Toggle sidebar". `Mod+D` is free, and matches Preview and the browsers.

## Proposed design (hybrid)

1. **One Bookmarks panel.** It replaces the Outline tab, and the README already calls the outline "bookmarks". Edits are a per-document sidecar draft, keyed by content hash. Like annotations, the draft survives a crash or a quit.
2. **On save**, the draft is written into the PDF's `/Outlines`, and the draft is then cleared.
3. **On protected or signed files**, editing still works, but the bookmarks stay app-local. The panel says so in one line: "Saved in Folio only: this file is protected/signed." Nothing in the file changes.
4. **Destination capture.** A new bookmark records the page and the top of the current view, saved as `/XYZ` with `null` zoom so the reader's zoom is kept. Jumping to it then needs a `goToDest(page, top)`, because the viewer is page-level today.
5. **Title.** Uses the selected text if there is any. Otherwise the nearest heading on the page, if the document is tagged. Otherwise "Page N".

### Interaction

The panel becomes a real ARIA tree (`role="tree"`/`treeitem`, `aria-level`,
roving tabindex). That closes the known gap in `docs/accessibility.md` and #93.

| Action | Pointer | Keyboard |
| --- | --- | --- |
| Add bookmark here | `+` button in the panel header, and the page context menu | `Mod+D` |
| Rename | Double-click, or the row menu | `F2` |
| Delete | Row menu | `Delete` (undoable) |
| Move up / down | Drag, or the row menu | `Alt+↑` / `Alt+↓` |
| Indent / outdent | Drag sideways, or the row menu | `Alt+→` / `Alt+←` |
| Re-point to current view | Row menu | none |
| Navigate | Click | `↑ ↓ ← → Home End`, `Enter`, type-ahead |

Every action is in the row's menu, so no feature depends on drag precision.
The APG tree pattern defines no reorder keys. The Alt+arrow scheme is our own
convention, and this document records it.

Undo uses a per-draft stack bound to `Mod+Z`, which clears the other feature
stacks the same way pageops and textedit already do.

## Phases

1. **Tree and lossless read model.** Rewrite `Outline.tsx` as an ARIA tree. Widen `OutlineNode`. Refresh the outline on `reloadEditedBytes`. No editing yet. This can ship alone because it fixes the accessibility gap.
2. **Editing as a sidecar draft.** Panel UI, commands, undo, and remapping on page ops.
3. **Write to `/Outlines` on save.** Includes round-trip tests over the corpus: an untouched outline must survive byte-for-byte equivalent, and unknown actions must be preserved.
4. **The `canEdit()` gate.** Protected and signed files keep their bookmarks app-local, with the notice.

Later: generate bookmarks from headings or the structure tree, and the MCP
`get_outline` item (ROADMAP:109).

## Sources

- Acrobat: <https://helpx.adobe.com/acrobat/current/page-thumbnails-bookmarks-pdfs.html>
- Preview's storage: <https://mjtsai.com/blog/?p=25086>
- Okular: <https://bugs.kde.org/show_bug.cgi?id=377454>
- SumatraPDF: <https://www.sumatrapdfreader.org/docs/How-we-store-settings>
- PDF-XChange: <https://help.pdf-xchange.com/pdfxp11/keyboard-shortcuts.html>
- Skim: <https://skim-app.sourceforge.io/manual/SkimHelp_39.html>
- Zathura: <https://man.archlinux.org/man/zathura.1>
- pdf.js: <https://connect.mozilla.org/t5/ideas/edit-pdf-outline/idi-p/134798>
- ARIA tree view pattern: <https://www.w3.org/WAI/ARIA/apg/patterns/treeview/>
