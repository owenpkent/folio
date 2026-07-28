import { create } from 'zustand';

import type { PendingPlacement } from './types';

/**
 * The armed placement, if any (see ./types.ts for the mode this feature
 * implements). Transient UI state: never persisted, and cleared whenever the
 * document changes (see state/actions).
 */

interface PlacementState {
  pending: PendingPlacement | null;
  begin(pending: PendingPlacement): void;
  cancel(): void;
}

export const usePlacementStore = create<PlacementState>((set) => ({
  pending: null,
  begin: (pending) => set({ pending }),
  cancel: () => set({ pending: null }),
}));
