// How big the auto-scroll controls are and whether their panel is open,
// remembered across sessions. The puck itself is fixed in the corner, so there
// is no position to store.

const STORAGE_KEY = 'folio.autoScrollControls';

/** The size choices: a multiplier on the controls' normal dimensions. */
export const SIZES = [
  { label: 'Small', short: 'S', scale: 0.75 },
  { label: 'Medium', short: 'M', scale: 1 },
  { label: 'Large', short: 'L', scale: 1.5 },
  { label: 'Extra large', short: 'XL', scale: 2 },
] as const;

export type SizeScale = (typeof SIZES)[number]['scale'];
const SCALE_DEFAULT: SizeScale = 1;

export interface AutoScrollLayout {
  scale: SizeScale;
  expanded: boolean;
}

const defaults = (): AutoScrollLayout => ({ scale: SCALE_DEFAULT, expanded: false });

/** The stored layout, or the default for anything missing or not valid. */
export function readLayout(): AutoScrollLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 200) return defaults();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults();
    // Older versions also stored x and y; they are ignored.
    const { scale, expanded } = parsed as Record<string, unknown>;
    return {
      scale: SIZES.find((size) => size.scale === scale)?.scale ?? SCALE_DEFAULT,
      expanded: typeof expanded === 'boolean' ? expanded : false,
    };
  } catch {
    return defaults();
  }
}

export function writeLayout(layout: AutoScrollLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage may be unavailable (private mode); ignore */
  }
}
