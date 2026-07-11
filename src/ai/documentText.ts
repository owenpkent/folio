import { getEngine } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';

import type { DocumentText, PageText } from './types';

/**
 * Collect the active document's text for the AI layer. Returns null when no
 * document is open. This is the only data the AI features ever see: extracted
 * plain text, never the raw file.
 */
export async function collectDocumentText(
  maxPages = Number.POSITIVE_INFINITY,
): Promise<DocumentText | null> {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return null;

  const engine = getEngine();
  const pages: PageText[] = [];
  const count = Math.min(info.numPages, maxPages);
  for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
    pages.push({ pageNumber, text: await engine.getPageText(pageNumber) });
  }

  return {
    name: info.name,
    pages,
    fullText: pages.map((p) => p.text).join('\n\n'),
  };
}
