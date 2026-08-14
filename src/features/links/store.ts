import { create } from 'zustand';

import type { AddressHit, AddressRegion } from './copyTarget';

/** Where to draw the hint, in CSS pixels relative to the page container. */
export interface HintBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface AddressHoverState {
  hit: AddressHit | null;
  box: HintBox | null;
  /**
   * Set when the reader pressed Escape over this address. WCAG 2.2 SC 1.4.13
   * wants content that appears on hover to be dismissible without moving the
   * pointer, and an address sitting under the hint is exactly the content
   * someone would want out of the way.
   */
  dismissed: boolean;

  show(hit: AddressHit, box: HintBox): void;
  clear(): void;
  dismiss(): void;
}

export const useAddressHover = create<AddressHoverState>((set, get) => ({
  hit: null,
  box: null,
  dismissed: false,

  show: (hit, box) => {
    const current = get();

    // Skip the write when nothing actually changed: AddressHint's Escape
    // effect depends on this object's identity, so an identical write on every
    // animation frame would tear the listener down and re-register it
    // roughly 60 times a second while the pointer sits still.
    if (
      current.hit?.target.value === hit.target.value &&
      current.box != null &&
      sameBox(current.box, box)
    ) {
      return;
    }

    // Moving within the same occurrence must not undo a dismissal, or Escape
    // would only hold until the next mouse tremor. Judged by where the address
    // sits rather than what it says: two occurrences of the same text are
    // different content on the page, and dismissing one must not silence
    // every other one -- a repeated footer URL, say, or a support email
    // repeated down a table. The same occurrence always resolves to the same
    // region, whatever point within it the pointer is on.
    const same = current.hit != null && sameRegion(current.hit.region, hit.region);
    set({ hit, box, dismissed: same ? current.dismissed : false });
  },

  clear: () => {
    if (!get().hit) return;
    set({ hit: null, box: null, dismissed: false });
  },

  dismiss: () => set({ dismissed: true }),
}));

function sameBox(a: HintBox, b: HintBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameRegion(a: AddressRegion, b: AddressRegion): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
