import { create } from 'zustand';

import type { AddressHit } from './copyTarget';

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
    const current = get().hit;
    // Moving within the same address must not undo a dismissal, or Escape
    // would only hold until the next mouse tremor.
    const same = current?.target.value === hit.target.value;
    set({ hit, box, dismissed: same ? get().dismissed : false });
  },

  clear: () => {
    if (!get().hit) return;
    set({ hit: null, box: null, dismissed: false });
  },

  dismiss: () => set({ dismissed: true }),
}));
