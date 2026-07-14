import { getEngine, type SearchMatch } from '@/core/pdf';

import { useOcrStore } from './store';

const SNIPPET_RADIUS = 40;

/** Build search hits from a page's OCR text (mirrors the engine's snippet style). */
function ocrMatchesForPage(
  text: string,
  pageNumber: number,
  query: string,
  limit: number,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  while (matches.length < limit) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + needle.length + SNIPPET_RADIUS);
    const snippet =
      (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
    matches.push({ pageNumber, index: idx, snippet });
    from = idx + needle.length;
  }
  return matches;
}

/**
 * Search the document's embedded text (via the engine) and fall back to OCR
 * text for any recognized page that has no embedded match, so scanned PDFs are
 * searchable in-app. Pages with embedded text are left to the engine to avoid
 * double-counting.
 */
export async function searchWithOcr(
  query: string,
  options?: { limit?: number },
): Promise<SearchMatch[]> {
  const limit = options?.limit ?? 100;
  const base = await getEngine().search(query, { limit });

  const pages = useOcrStore.getState().pages;
  const keys = Object.keys(pages);
  if (keys.length === 0 || query.trim().length < 2) return base;

  const pagesWithEmbedded = new Set(base.map((m) => m.pageNumber));
  const extra: SearchMatch[] = [];
  for (const key of keys) {
    const page = pages[Number(key)];
    if (!page || pagesWithEmbedded.has(page.pageNumber)) continue;
    extra.push(...ocrMatchesForPage(page.text, page.pageNumber, query, limit));
    if (base.length + extra.length >= limit) break;
  }
  if (extra.length === 0) return base;

  return [...base, ...extra]
    .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    .slice(0, limit);
}
