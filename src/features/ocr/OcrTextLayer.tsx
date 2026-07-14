import { useEffect, useRef, useState } from 'react';

import { useOcrStore } from './store';

/**
 * A transparent, selectable text overlay for a recognized (scanned) page, so
 * users can select and copy OCR text on screen. Words are positioned as page
 * fractions; font size is derived from the layer's measured pixel height so it
 * tracks zoom. Baked into the PDF separately (see bake.ts).
 */
export function OcrTextLayer({ pageNumber }: { pageNumber: number }) {
  const page = useOcrStore((s) => s.pages[pageNumber]);
  const ref = useRef<HTMLDivElement>(null);
  const [heightPx, setHeightPx] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeightPx(el.clientHeight));
    observer.observe(el);
    setHeightPx(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  if (!page || page.words.length === 0) return null;

  return (
    <div ref={ref} className="folio-ocr-layer">
      {page.words.map((w, i) => (
        <span
          key={i}
          className="folio-ocr-word"
          style={{
            left: `${w.rect.x * 100}%`,
            top: `${w.rect.y * 100}%`,
            width: `${w.rect.width * 100}%`,
            height: `${w.rect.height * 100}%`,
            fontSize: `${Math.max(6, w.rect.height * heightPx * 0.9)}px`,
          }}
        >
          {w.text}
        </span>
      ))}
    </div>
  );
}
