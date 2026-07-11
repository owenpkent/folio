import { useMemo } from 'react';

import { useAnnotationStore } from './store';

/**
 * Renders a page's highlights as an overlay above the text layer. Normalized
 * rects are scaled to the current page box, so highlights track zoom without
 * being re-computed.
 */
export function AnnotationLayer({ pageNumber }: { pageNumber: number }) {
  const all = useAnnotationStore((s) => s.annotations);
  const annotations = useMemo(
    () => all.filter((a) => a.pageNumber === pageNumber),
    [all, pageNumber],
  );

  if (annotations.length === 0) return null;

  return (
    <div className="folio-annotation-layer" aria-hidden="true">
      {annotations.flatMap((annotation) =>
        annotation.rects.map((rect, index) => (
          <div
            key={`${annotation.id}-${index}`}
            className="folio-annotation folio-annotation--highlight"
            title={annotation.text}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              backgroundColor: annotation.color,
            }}
          />
        )),
      )}
    </div>
  );
}
