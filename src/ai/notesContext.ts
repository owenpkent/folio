import { useAnnotationStore } from '@/features/annotations';

import type { NoteAnchor } from './types';

/**
 * Resolve the active document's sticky notes into AI-locatable anchors: page,
 * position, comment, and the nearby page text captured at placement. This is
 * what lets an assistant tell *where* each note applies when the document is
 * fed back to it for comments and feedback.
 */
export function collectNoteAnchors(): NoteAnchor[] {
  return useAnnotationStore
    .getState()
    .annotations.filter((a) => a.type === 'note')
    .map((a) => ({
      page: a.pageNumber,
      x: Number((a.anchor?.x ?? 0).toFixed(4)),
      y: Number((a.anchor?.y ?? 0).toFixed(4)),
      comment: a.note ?? '',
      nearText: a.text ?? '',
    }))
    .sort((a, b) => a.page - b.page || a.y - b.y);
}

/**
 * Render notes as a plain-text block to append to the AI context, so any
 * provider (or an external assistant the user pastes into) knows each note's
 * location and the passage it refers to.
 */
export function formatNotesForAi(notes: NoteAnchor[]): string {
  if (notes.length === 0) return '';
  const lines = notes.map((n, i) => {
    const pos = `page ${n.page}, at ${Math.round(n.x * 100)}% across / ${Math.round(n.y * 100)}% down`;
    const near = n.nearText ? `\n   near text: "${n.nearText}"` : '';
    const comment = n.comment ? `"${n.comment}"` : '(no comment yet)';
    return `${i + 1}. [${pos}] ${comment}${near}`;
  });
  return `REVIEWER NOTES (sticky notes placed on the document; each lists where it sits and the text it is next to):\n${lines.join('\n')}`;
}
