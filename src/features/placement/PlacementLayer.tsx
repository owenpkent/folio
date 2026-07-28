import type { MouseEvent } from 'react';

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
