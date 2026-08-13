import { useCallback, useEffect, useRef } from 'react';

import { copyTargetAt } from './copyTarget';
import { useAddressHover } from './hoverStore';

interface Sample {
  clientX: number;
  clientY: number;
  page: HTMLElement;
}

/** Slack around the hint, so the gap between it and its label is not a hole. */
const HINT_PAD = 6;

/**
 * Whether the point is over the hint that is already showing, including its
 * label, which hangs below the address rather than over it.
 *
 * Measured off the rendered elements rather than recomputed, so the gap and the
 * label's size stay a stylesheet concern.
 */
function overHint(x: number, y: number): boolean {
  const hint = document.querySelector('.folio-address-hint');
  if (!hint) return false;

  let { left, right, top, bottom } = hint.getBoundingClientRect();
  for (const child of hint.children) {
    const box = child.getBoundingClientRect();
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }

  return (
    x >= left - HINT_PAD && x <= right + HINT_PAD && y >= top - HINT_PAD && y <= bottom + HINT_PAD
  );
}

/**
 * Watch the pointer for addresses, so one can be seen without right-clicking to
 * find out whether it is there. Acrobat does the same with a hand cursor and a
 * tooltip.
 *
 * Deliberately no cursor change here: in Acrobat a link is left-clickable, so
 * the hand cursor is honest. Folio only offers to copy, from the context menu,
 * so a pointer cursor would promise a click that does nothing. The highlight is
 * the affordance instead.
 */
export function useTrackAddressHover(scale: number, enabled: boolean) {
  const pending = useRef<Sample | null>(null);
  const frame = useRef(0);
  // Bumped on every sample so a slow resolve landing after the pointer has
  // moved on cannot overwrite a newer answer.
  const generation = useRef(0);

  const clear = useAddressHover((s) => s.clear);
  const show = useAddressHover((s) => s.show);

  const sample = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (!next) return;

    // Moving onto the hint keeps it up. WCAG 2.2 SC 1.4.13 asks content shown
    // on hover to be hoverable as well as dismissible, and without this the
    // next sample lands past the address, finds nothing, and takes the hint
    // away as the pointer reaches it.
    if (overHint(next.clientX, next.clientY)) return;

    const pageNumber = Number(next.page.dataset.pageNumber ?? 0);
    if (!pageNumber) {
      clear();
      return;
    }

    const pageBox = next.page.getBoundingClientRect();
    const cssX = next.clientX - pageBox.left;
    const cssY = next.clientY - pageBox.top;

    const mine = (generation.current += 1);
    void copyTargetAt(pageNumber, cssX, cssY, scale).then((hit) => {
      if (mine !== generation.current) return;
      if (!hit) {
        clear();
        return;
      }
      // The region is a fraction of the page, so it survives zoom; turning it
      // into pixels here keeps the hint itself free of geometry. Measured
      // against .folio-pages, which is what the hint renders inside, so it
      // scrolls with the document rather than needing repositioning.
      const containerBox = next.page.closest('.folio-pages')?.getBoundingClientRect();
      show(hit, {
        left: pageBox.left - (containerBox?.left ?? 0) + hit.region.x * pageBox.width,
        top: pageBox.top - (containerBox?.top ?? 0) + hit.region.y * pageBox.height,
        width: hit.region.width * pageBox.width,
        height: hit.region.height * pageBox.height,
      });
    });
  }, [scale, clear, show]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Not while a button is down: that is a text selection, a pan, or a drag,
      // and none of them want a hint following along.
      if (!enabled || event.buttons !== 0) {
        clear();
        return;
      }

      const page = (event.target as Element).closest<HTMLElement>('.folio-page');
      if (!page) {
        clear();
        return;
      }

      pending.current = { clientX: event.clientX, clientY: event.clientY, page };
      // One resolve per frame at most. Everything it reads is cached per page,
      // but a fresh promise per pointermove is still work worth not doing.
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        sample();
      });
    },
    [enabled, clear, sample],
  );

  const onPointerLeave = useCallback(() => {
    pending.current = null;
    generation.current += 1;
    clear();
  }, [clear]);

  // A zoom or a mode change moves or invalidates the box under the pointer.
  useEffect(() => {
    clear();
  }, [scale, enabled, clear]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { onPointerMove, onPointerLeave };
}
