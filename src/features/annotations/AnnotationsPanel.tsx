import { announce } from '@/a11y/announcer';
import { IconButton } from '@/components/common/IconButton';
import { useViewerStore } from '@/state/viewerStore';

import { useAnnotationStore } from './store';

/** Sidebar panel listing every annotation in the document. */
export function AnnotationsPanel() {
  const annotations = useAnnotationStore((s) => s.annotations);
  const remove = useAnnotationStore((s) => s.remove);
  const goToPage = useViewerStore((s) => s.goToPage);

  if (annotations.length === 0) {
    return (
      <p className="folio-sidebar__empty">
        No annotations yet. Select text in the document and press{' '}
        <kbd>Ctrl/Cmd&nbsp;+&nbsp;Shift&nbsp;+&nbsp;H</kbd> to add a highlight.
      </p>
    );
  }

  const sorted = [...annotations].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.createdAt - b.createdAt,
  );

  return (
    <ul className="folio-annotations-list">
      {sorted.map((annotation) => (
        <li key={annotation.id} className="folio-annotations-list__item">
          <button
            type="button"
            className="folio-annotations-list__jump"
            onClick={() => goToPage(annotation.pageNumber)}
          >
            <span
              className="folio-annotations-list__swatch"
              style={{ backgroundColor: annotation.color }}
              aria-hidden="true"
            />
            <span className="folio-annotations-list__text">{annotation.text || '(no text)'}</span>
            <span className="folio-annotations-list__page">p.{annotation.pageNumber}</span>
          </button>
          <IconButton
            icon="trash"
            label={`Delete highlight on page ${annotation.pageNumber}`}
            onClick={() => {
              remove(annotation.id);
              announce('Highlight deleted');
            }}
          />
        </li>
      ))}
    </ul>
  );
}
