import { useEffect } from 'react';

import { Button } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { PAGE_CENTER } from './rect';
import { usePlacementStore } from './store';

/**
 * Banner shown while a placement is armed, so the mode is never invisible.
 * Escape, the Cancel button, or a click anywhere off a page disarms it.
 *
 * Its **Place in the middle** button is what keeps the placing tools keyboard
 * operable (WCAG 2.1.1): clicking a spot on the page is a pointer-only
 * affordance, so the banner offers the pre-click behavior — centered on the
 * page the user is reading — as a focusable control, and takes focus when it
 * opens so it is one key away.
 */
export function PlacementHint() {
  const pending = usePlacementStore((s) => s.pending);
  const cancel = usePlacementStore((s) => s.cancel);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    // A click that is not on a page cannot place anything, so treat it as the
    // user moving on: reaching for the toolbar, the sidebar, or the margin
    // around the pages disarms rather than leaving the mode silently on. The
    // banner is excluded so its own buttons still get their clicks. Capture
    // phase, so a handler that stops propagation cannot strand the mode.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.folio-page, .folio-placement-hint')) return;
      cancel();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pending, cancel]);

  if (!pending) return null;

  const placeInMiddle = () => {
    const { currentPage } = useViewerStore.getState();
    const { place } = pending;
    cancel();
    void place(currentPage, PAGE_CENTER, 'center');
  };

  return (
    <div className="folio-placement-hint">
      {/* The live region is the message alone: a status region holding the
          buttons would re-announce them on every change. */}
      <span role="status">Click on the page to place the {pending.label}.</span>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the banner is a
          transient mode surface, like the search bar; focusing it is what makes
          the mode operable without a pointer. */}
      <Button variant="primary" autoFocus onClick={placeInMiddle}>
        Place in the middle
      </Button>
      <Button onClick={cancel}>Cancel</Button>
    </div>
  );
}
