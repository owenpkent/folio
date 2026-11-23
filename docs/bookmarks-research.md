# Bookmarks: research notes

Collected 2026-11-23 to inform [bookmarks.md](bookmarks.md). Each claim is
marked by where it came from:

- **verified**: checked against the source linked.
- **snippet**: seen only in search-result text, page not read in full.
- **unverified**: from memory, or not found. Check it before relying on it.

## 1. Products

### Adobe Acrobat (writes `/Outlines`)

- The Bookmarks panel edits the document outline directly, so changes are saved in the file. (snippet)
- If text is selected when you add a bookmark, that text becomes the title, and the title stays editable. (snippet)
- The destination is the view on screen when the bookmark is made (page and zoom), not just the page. The options menu has "Set Bookmark Destination" to re-point an existing one. (snippet)
- User reports, as UX hazards to avoid:
  - Ctrl+B sometimes produces "Untitled" instead of using the selection.
  - "Set Destination" can be missing until the file is saved and reopened.
  (snippet)
- "Wrap long bookmarks" and tagged bookmarks (generated from the structure tree): unverified. The search only surfaced a "Text Size" option.

### PDF-XChange Editor (writes `/Outlines`)

- It has the settings "Use Selected Text as Title" and "Use Selected Region as Destination". (snippet)
- Add Bookmark is Ctrl+Shift+B in v11. It was Ctrl+1 in v7. (verified, keyboard shortcut page)
- It can generate bookmarks from page text. (snippet)

### Foxit PDF Reader / Editor

- Nothing found. (unverified)

### macOS Preview (in the file, non-standard)

- Tools > Add Bookmark. Cmd+D according to one source. Bookmarked pages show a red corner marker, and there is a Bookmarks sidebar. (snippet)
- A 2018 post (mjtsai) says Preview stores bookmarks as a private XML stream inside the PDF, not in `/Outlines`. Other viewers therefore don't show them. Apple does not document this. (snippet)
- There are user reports of bookmarks jumping to the wrong page. (snippet)

### Okular (app-local, separate from the TOC)

- Per-user bookmarks are kept apart from the PDF's table of contents. They live in one per-user `bookmarks.xml`, keyed by absolute path, so a moved or renamed PDF loses them. (snippet)
- Annotations and view state go in separate per-document `docdata` files. (snippet)
- A 2015 patch (KDE bug 342258) proposed splitting bookmarks per document. Whether it shipped is unverified.
- Since Okular 1.1, a bookmark can be created from a TOC entry. (snippet)
- KDE bug 377454 asked to edit the PDF outline. It was closed as intentional on 2026-04-09, with "we are not a PDF editor". (verified)
- An "export bookmarks to PDF" feature was not found. (unverified)

### SumatraPDF (app-local)

- "Favorites" are stored in `SumatraPDF-settings.txt`, under each file's `FileStates` entry (`FilePath`, then `Favorites` with `Name` and `PageNo`). (verified, "How we store settings")
- They are keyed by path. Moving the file breaks them, and a settings reset wipes them. (verified)
- There is a `SortFavoritesByName` option. (verified)
- The shortcut is unverified.

### Skim, macOS (file attributes or a sidecar)

- Notes and highlights live in the file's extended attributes, not in the PDF. They are lost when the file is copied to a filesystem without xattrs, or emailed. (snippet)
- It can export a "PDF with embedded notes", or save a separate `.skim` file. This is the closest example found of offering both storage models. (snippet)
- "Add Setup Bookmark" is ⌥⇧⌘D. Skim's own bookmarks are an app-level list. (unverified)

### Zathura (app-local)

- Commands are `:bmark`, `:bdelete` and `:blist`. (verified, man page)
- There is a plain-file backend and an sqlite backend, under `~/.local/share/zathura`. The exact file names are unverified.
- Bookmarks are disabled in sandbox mode. (verified, man page)

### Browser viewers

- pdf.js (Firefox) shows the outline read-only. (verified)
- No open pdf.js issue asks for outline editing. The editing meta bug, 1774350, covers forms, ink and text, not outlines. (verified)
- Mozilla Connect has an "Edit PDF outline" idea with no response. (verified)
- A Zotero developer described the pdf.js viewer as "just a viewer". (snippet)
- Chrome's PDF viewer also shows the outline read-only. No plans were found. (unverified)

### Libraries and other tools that write outlines

- PyMuPDF `set_toc([[level, title, page], ...])` followed by `save`. The input is flat and level-based, so it drops destination position and zoom, colour and style. (verified, Artifex blog)
- pikepdf was suggested in the KDE thread as a way to edit outlines. (verified)
- PDF4QT, Stirling-PDF, pdftk, qpdf, jPDF Tweak and Master PDF Editor were not researched.

### Zotero

- There is a long-standing feature request for reader bookmarks and outline editing. Nothing has shipped. (snippet)

## 2. PDF spec essentials (ISO 32000-2 §12.3.3)

This section is from memory (unverified). Re-check it against the spec before
writing the serializer.

### The tree structure

- The catalog's `/Outlines` entry points to the outline root, which has `/First`, `/Last` and `/Count`.
- Each item links to its neighbours through `/Parent`, `/Prev`, `/Next`, `/First` and `/Last`, forming a doubly linked list per level.

### Fields of an item

- **`/Count`** (on an item): the number of descendants that are visible. Positive means the item is open. Negative means it is closed, and the absolute value is the count that would show if it were opened. Zero or absent means it has no children.
- **`/Title`**: a text string, in PDFDocEncoding or UTF-16BE with the BOM `FE FF`. Anything outside Latin-1 needs UTF-16BE.
- **`/Dest`**: an explicit destination array, or a name or string that is looked up in `/Dests` or the `/Names` tree. Alternatively the item has an **`/A`** action (`GoTo`, `URI`, `Launch`, `Named`, `GoToR` and so on). An item has `/Dest` or `/A`, never both.
- **Explicit destinations**:
  - `[page /XYZ left top zoom]`. A `null` in any slot means "keep the current value".
  - `[page /Fit]`, `/FitH top`, `/FitV left`, `/FitR l b r t`, `/FitB`, `/FitBH`, `/FitBV`.
  - In a local document, `page` is an indirect reference to a page object. Only `GoToR` uses an integer page index.
- **`/C`**: an RGB array, components 0 to 1.
- **`/F`**: flags, where bit 1 is italic and bit 2 is bold.
- **`/SE`**: an indirect reference to a structure element. This links the bookmark to a heading in a tagged document.

### Pitfalls when writing outlines

- Wrong `/Count` signs or totals. Viewers then render the tree wrongly, or open everything.
- `/Prev`, `/Next` or `/Parent` links that are broken or form a cycle. Some viewers hang on a cycle, so the reader must guard against cycles too.
- Destinations that still point at deleted pages.
- Old items left orphaned after the tree is rebuilt.
- Dropping `/A` actions, `/SE`, `/C` or `/F` on a round trip, because the read model kept only the title and page.
- Named destinations: a rewrite must keep the `/Dests` or `/Names` entry they resolve through.
- Saving:
  - An incremental update keeps the original bytes, and with them a signature, but only if DocMDP permissions allow the change.
  - A full rewrite, which is what Folio does, invalidates every signature.
  - An encrypted file would have to be decrypted and re-encrypted. Folio refuses to do this by policy.

## 3. Accessibility

### Bookmarks in the document

- Neither WCAG 2.4.5 (Multiple Ways) nor PDF/UA sets a page-count threshold for bookmarks. A reply on the W3C WAI-IG list (Oct to Dec 2024) says it is a judgement call. (verified)
- The "documents over 20 pages need bookmarks" rule is a common rule of thumb. It appears in some organisations' own guidance, Visa's for example, but not in any standard. (snippet)
- Common guidance is that bookmarks should mirror the heading structure, linked through `/SE` in tagged documents. (snippet)
- The Matterhorn Protocol's bookmark checkpoints are unverified.

### The editable tree in the UI

Keyboard conventions from the WAI-ARIA APG tree view pattern (verified):

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move focus to the previous or next visible node |
| → | Open a closed node. On an open node, move to its first child |
| ← | Close an open node. On a closed node or a leaf, move to its parent |
| Home / End | First or last visible node |
| Enter | Activate the node |
| Type-ahead | Focus the next node whose name starts with the typed characters (recommended) |

- Parent nodes carry `aria-expanded`.
- When not every node is in the DOM (virtualised trees), use `aria-level`, `aria-setsize` and `aria-posinset`.
- **The APG defines no reorder or drag conventions.** An editable tree needs its own accessible alternative to drag. The `Alt+arrow` scheme in [bookmarks.md](bookmarks.md) is our own convention, not a standard.

## 4. The two design schools

| | Write into the PDF | App-local sidecar |
| --- | --- | --- |
| Who does it | Acrobat, PDF-XChange, PyMuPDF, Preview (non-standard) | Okular, SumatraPDF, Zathura, Skim |
| Portable to other viewers | Yes | No |
| Modifies the file | Yes | No |
| Works on protected or signed files | No: needs decryption, or breaks the signature | Yes |
| Survives a move or rename | Yes | Not when keyed by path (all four products above) |
| Shared with others | Yes | No |

- Offering both in one product: none found with a clean model. Skim's export comes closest.
- Folio-specific point: Folio keys sidecar state on a SHA-256 of the file's contents, not on its path. That removes the move and rename weakness of the sidecar column. The remaining loss case is the file being changed and re-saved by another program.

## Sources

- <https://helpx.adobe.com/acrobat/current/page-thumbnails-bookmarks-pdfs.html>
- <https://support.apple.com/guide/preview/prvw1087/mac>
- <https://mjtsai.com/blog/?p=25086>
- <https://bugs.kde.org/show_bug.cgi?id=377454>
- <https://bugs.kde.org/show_bug.cgi?id=342258>
- <https://bugs.kde.org/show_bug.cgi?id=457017>
- <https://www.sumatrapdfreader.org/docs/How-we-store-settings>
- <https://help.pdf-xchange.com/pdfxp11/keyboard-shortcuts.html>
- <https://skim-app.sourceforge.io/manual/SkimHelp_39.html>
- <https://man.archlinux.org/man/zathura.1>
- <https://bugzilla.mozilla.org/show_bug.cgi?id=1774350>
- <https://connect.mozilla.org/t5/ideas/edit-pdf-outline/idi-p/134798>
- <https://www.w3.org/WAI/ARIA/apg/patterns/treeview/>
- <https://lists.w3.org/Archives/Public/w3c-wai-ig/2024OctDec/0004.html>
- <https://artifex.com/blog/mastering-metadata-and-table-of-contents-manipulation-with-pymupdf>
