/**
 * PLANNED / EXPERIMENTAL: Folio as a Model Context Protocol server.
 *
 * This would expose Folio's capabilities as MCP tools so an external assistant
 * (e.g. Claude Desktop) can drive the viewer: open documents, search, read the
 * outline, extract text, annotate, and render page images. The tool surface is
 * declared here for docs and design; the server is not implemented yet. See
 * docs/ai.md and ROADMAP.md (v0.5).
 */

export interface McpToolDescriptor {
  name: string;
  description: string;
}

export const FOLIO_MCP_TOOLS: readonly McpToolDescriptor[] = [
  { name: 'open_document', description: 'Open a PDF by path or URL.' },
  { name: 'search', description: 'Search the active document for text.' },
  { name: 'get_outline', description: 'Return the document outline / bookmarks.' },
  { name: 'extract_text', description: 'Extract text from a page or page range.' },
  { name: 'add_annotation', description: 'Add a highlight or note to a page.' },
  { name: 'get_page_image', description: 'Render a page to a PNG image.' },
] as const;

export function startMcpServer(): never {
  throw new Error(
    'The MCP server is planned but not implemented yet. See docs/ai.md and ROADMAP.md.',
  );
}
