import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useOcrStore } from './store';

/**
 * A transparent, selectable text overlay for a recognized (scanned) page, so
 * users can select and copy OCR text on screen. Baked into the PDF separately
 * (see bake.ts).
 *
 * Each word is placed by its recognized box, but the glyphs inside it are the
 * browser's, not the page's. Those two widths do not match on their own: the
 * overlay renders "Congratulations," in a generic sans-serif at whatever size
 * the box's height implies, and the raster underneath drew it in the document's
 * own font. What the user actually sees when they drag across the page is the
 * selection highlight, and a highlight tracks the text it is painted behind --
 * not the box we positioned. So a word whose substitute glyphs come out narrower
 * than the real ones highlights as a stubby bar sitting to the left of the word
 * it belongs to, and the error grows across a line.
 *
 * The fix is the one PDF.js's own text layer uses: measure each word as the
 * browser actually laid it out, then scale it horizontally onto the box it is
 * supposed to fill. See the layout effect below.
 */
export function OcrTextLayer({ pageNumber }: { pageNumber: number }) {
  const page = useOcrStore((s) => s.pages[pageNumber]);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  const words = page?.words;
  // Whether anything is rendered at all: see the early return below.
  const rendered = words != null && words.length > 0;

  // The layer is sized by the page (inset: 0), so its pixel box is the page's,
  // and every fraction above turns into pixels through it. Re-measured on zoom
  // rather than derived from the scale, which this component is not given.
  //
  // Keyed on `rendered`, not []: this component is mounted for every page as
  // soon as a document opens, but renders nothing until that page has been
  // recognized, so on the ordinary path (open, then run OCR) `ref.current` is
  // null the first time round and nothing remounts it afterwards -- the Page
  // key is per document and page, not per OCR result. With an empty dep list
  // the observer was never attached, `box` stayed 0x0 for good, and every word
  // was left at the 1px floor and unscaled.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      // Same values, same object: ResizeObserver fires on sub-pixel changes
      // (fractional DPI scaling, an ancestor's scrollbar, a window drag) that
      // these rounded integers do not see, and a fresh object would re-render
      // every word span and re-run the two-reflow pass below for a box that
      // did not move.
      setBox((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [rendered]);

  // Stretch each word onto its recognized width.
  //
  // Split into three passes on purpose. Clearing every transform, then reading
  // every natural width, then writing every scale costs two reflows for the
  // whole page; interleaving read and write per word costs two per word, which
  // on a dense scan is hundreds of forced synchronous layouts on every zoom
  // step.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !words || box.width === 0) return;
    const spans = Array.from(el.querySelectorAll<HTMLElement>('.folio-ocr-word'));

    // Clearing the clamp along with the transform matters: a span left clamped
    // from a previous pass would measure as its clamped width below, and the
    // scale computed from that would be wrong rather than merely unscaled.
    for (const span of spans) {
      span.style.transform = 'none';
      span.style.maxWidth = '';
      span.style.overflow = '';
    }
    // getBoundingClientRect over offsetWidth: it is fractional, and a word
    // rounded to whole pixels before scaling drifts visibly on a long line.
    const natural = spans.map((span) => span.getBoundingClientRect().width);

    spans.forEach((span, i) => {
      const target = (words[i]?.rect.width ?? 0) * box.width;
      const measured = natural[i];
      if (measured > 0 && target > 0) {
        span.style.transform = `scaleX(${target / measured})`;
        return;
      }
      // A zero-width measurement means the span has not been laid out yet (or
      // the word is whitespace); leaving it unscaled is better than dividing
      // into it and writing a scaleX of Infinity. Unscaled still has to be
      // clamped to the box it was recognized in, though: the glyphs are
      // transparent, but the selection highlight is not, and a word left at
      // its full natural width covers the words after it and takes the drag
      // that belonged to them. A degenerate box (target 0, common for a
      // mis-segmented glyph) collapses to nothing, which is what it should be.
      span.style.transform = 'none';
      span.style.maxWidth = `${target}px`;
      span.style.overflow = 'hidden';
    });
  }, [words, box.width, box.height]);

  if (!words || words.length === 0) return null;

  return (
    <div ref={ref} className="folio-ocr-layer">
      {words.map((w, i) => (
        <span
          key={i}
          className="folio-ocr-word"
          style={{
            left: `${w.rect.x * 100}%`,
            top: `${w.rect.y * 100}%`,
            // The whole box height, not a fraction of it: with line-height 1
            // the line box is exactly the font size, so this makes the
            // highlight cover the word's recognized box top to bottom. The
            // previous 0.9 shaved a tenth off every highlight and left it
            // riding above the glyphs it was meant to cover.
            fontSize: `${Math.max(1, w.rect.height * box.height)}px`,
          }}
        >
          {w.text}
        </span>
      ))}
    </div>
  );
}
