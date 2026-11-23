# Reading position: pick up where you left off

Status: merged 2026-11-23 (#171). Not in a release yet.

Folio remembers where you were in each document (the page, and the zoom and
fit mode) and puts you back there when you reopen it. The start screen offers
a **Continue** button for the last document you had open.

This replaced the broader bookmark-editing proposal in [bookmarks.md](bookmarks.md).
The real need was resuming reading, not editing the outline.

## Decisions (2026-11-23)

| Question | Decision |
| --- | --- |
| What is restored | Top of the remembered page, plus zoom and fit mode |
| On launch with no file | A large "Continue: name.pdf, page N" button on the start screen. Nothing opens automatically. |
| Notice on resume | A toast saying "Resumed at page N" with a **Start over** button (goes to page 1). The open announcement gets ", resumed at page N" for screen readers. |
| A file changed by another app | Lookup chain: exact content hash, then the first trailer `/ID`, then the file path. Both fallback keys are stored only as SHA-256 digests, so there is no readable list of files opened. A match whose page is beyond the file's page count is ignored. |

## Storage

- `folio.readingPositions` in localStorage maps a document's content hash to `{ page, scale, fitMode, at, id?, path? }`.
  - `id` is `sha256("id:" + first /ID)` and `path` is `sha256("path:" + normalised path)`. Both are fallback keys for a file changed by another app.
  - It holds at most 200 entries, and the oldest is dropped first.
  - Page 1 at the default zoom deletes the document's own entry, so the map stays small. It never deletes another entry, even one that shares an `id` or `path`: filled copies of one template share an `/ID`, and each has its own place.
  - If another entry does share an `id` or `path`, the own entry is kept as a reset marker (page 1, default zoom) instead of deleted. A lookup that lands on a marker resumes nothing, and because the marker is newer it also stops the fallback keys from resuming the other entry.
  - Everything read back is validated, because localStorage is not a trust boundary.
- `folio.lastDocument` holds one note `{ path, name, page }` for the Continue button. Its path is checked with the same `isResumablePath` rule as resume-after-update: an absolute local `.pdf` path, never UNC.
- Saving in Folio changes the file's hash, so after a successful save the position is also recorded under the hash of the bytes that were written. The position is captured with the exported bytes, under the mutation lock, because the write can finish after another document has been opened. The rest of the session is recorded under the new hash only if the saved document is still the open one.

## How viewers key "last position"

Research done 2026-11-23. Each finding is marked by where it came from:

- **source**: read in the project's source code.
- **docs/forum**: from documentation or forum and community posts.
- **unverified**: not checked.

| Viewer | Key | Re-saved by another app | Moved or renamed | Basis |
| --- | --- | --- | --- | --- |
| Firefox pdf.js (`web/view_history.js`) | First trailer `/ID`, else an MD5 of the first 1 KB | Kept if `/ID[0]` is kept | Kept | source |
| SumatraPDF (`Settings.h`, `FileState`) | File path | Kept | Lost | source |
| Zathura (`database-sqlite.c`) | Path, or a content hash (`file = ? OR hash = ?`) | Kept (by path) | Kept (by hash) | source |
| Okular (`core/document.cpp`) | File size plus file name (`docdata/<size>.<name>.xml`) | Lost if the size changes | Kept, but same-name same-size files collide | source |
| Evince/Papers | GVfs file metadata | Kept | Lost outside GVfs | docs/forum, older sources |
| Adobe Acrobat (`RememberedViews`) | Probably path; registry under `cNoCategoryFiles` | unverified | unverified | docs/forum |
| KOReader (`util.partialMD5`) | MD5 of 1 KB samples at offsets `1024 << 2i` | Kept if the change is only appended data | Kept | source |
| Zotero | The attachment item (`.zotero-reader-state`) | n/a | n/a | docs/forum |

More detail:

- **pdf.js** keeps 20 files, and evicts the oldest inserted rather than the least recently used. For each file it stores the page, zoom, scroll and spread.
- **SumatraPDF** flags a file it can't find as missing and hides it, rather than deleting its entry.
- **KOReader** samples its hash, densely near the start of the file and sparsely near the end, for two reasons: speed on huge files, and because it appends highlights to the PDF, which would change a hash of the whole file.

None of these use a hash of the whole file, which is what Folio uses. They settled on
one fairly stable identifier, either the path (Sumatra, Evince) or the `/ID`
(pdf.js). Zathura is the only one that falls back from one key to another.

### The trailer `/ID` (ISO 32000-2 §14.4)

The `/ID` is two strings:

- The first is the **permanent** ID. It is supposed to survive updates.
- The second **changes** with each revision.

Both are equal when the file is first written. So a match on the first string
means "a version of the same document", which is exactly the re-saved-elsewhere case.

Caveats:

- Many files made from one template, or cloned or saved as a copy, share the first `/ID`. That is why `contentKey.ts` stopped using it for signatures and annotations.
- Files often have no `/ID` at all.
- How reliably real tools keep the first string is unverified. Incremental saves in Acrobat keep it. Ghostscript and browser "print to PDF" usually write a fresh one, or none.

### Why a looser key is fine here

`contentKey.ts` rejects the pdf.js fingerprint because two different files can
share it, and for signatures that would put one person's signature on another
person's copy. For a reading position, the worst a wrong match can do is open
someone else's copy of a form at page 3. Nothing leaks and nothing is written
to the file. The saved page is also ignored if it is beyond the new file's page
count.

### Candidate fallback keys

| Key | Survives a re-save | Survives a move | Notes |
| --- | --- | --- | --- |
| Path | Yes | No | Stores a history of the paths you've opened, unless the path is hashed |
| First `/ID` | Usually | Yes | Can be missing. Template files share it. |
| Path + size + mtime | No | No | Useless for this case |
| Partial hash (KOReader) | Only for appended data | Yes | Breaks on real edits |
| Hash, then `/ID`, then path | Yes | Yes | Zathura-style chain, with a page-count check |

## Sources

- <https://github.com/mozilla/pdf.js/blob/master/web/view_history.js>
- <https://github.com/mozilla/pdf.js/blob/master/src/core/document.js>
- <https://github.com/sumatrapdfreader/sumatrapdf/blob/master/src/Settings.h>
- <https://github.com/KDE/okular/blob/master/core/document.cpp>
- <https://github.com/pwmt/zathura/blob/develop/zathura/database-sqlite.c>
- <https://github.com/koreader/koreader/blob/master/frontend/util.lua>
- <https://lists.gnome.org/archives/evince-list/2007-September/msg00010.html>
- <https://adobe.com/devnet-docs/acrobatetk/tools/PrefRef/Macintosh/RememberedViews.html>
- <https://pdf-issues.pdfa.org/32000-2-2020/clause14.html>
