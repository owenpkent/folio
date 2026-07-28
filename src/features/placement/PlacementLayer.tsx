import type { MouseEvent } from 'react';

import { formWidgetAt } from '@/state/formsLayer';

import { PAGE_CENTER } from './rect';
import { usePlacementStore } from './store';

/**
 * Full-page click catcher, mounted per page while a placement is armed and
 * above the other overlays: wherever the user clicks is where the item goes.
 */
export function PlacementLayer({ pageNumber }: { pageNumber: number }) {
  const pending = usePlacementStore((s) => s.pending);

  if (!pending) return null;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // detail === 0 is the standard signal for a non-pointer activation
    // (Enter/Space on the focused catcher), where clientX/clientY are 0 rather
    // than a page position. Placing at the page's top-left corner is not what
    // that means, so it falls back to the middle -- the same spot the hint
    // banner's own keyboard path uses, and centered rather than hung off it.
    if (e.detail === 0) {
      usePlacementStore.getState().cancel();
      void pending.place(pageNumber, PAGE_CENTER, 'center');
      return;
    }

    // Only the check-mark tool opts into this; see PendingPlacement for why the
    // other tools should swallow a click over a field rather than forward it.
    if (pending.deferToFormWidget) {
      const widget = formWidgetAt(e.clientX, e.clientY);
      if (widget) {
        // The catcher already consumed the original click, so replay it on the
        // widget: one click in, one toggle out. Left armed deliberately, so the
        // next click can still place a mark somewhere the widget is not.
        widget.focus();
        widget.click();
        return;
      }
    }

    const point = {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
    // Disarm before placing: `place` is async, and a second click landing
    // before it resolves would otherwise place a duplicate.
    usePlacementStore.getState().cancel();
    void pending.place(pageNumber, point);
  };

  return (
    <button
      type="button"
      className="folio-placement-hit"
      data-pan-exclude
      aria-label={`Click where the ${pending.label} should go`}
      onClick={onClick}
    />
  );
}
