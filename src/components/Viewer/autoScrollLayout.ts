// Where the auto-scroll transport sits and how big it is, remembered across
// sessions. Position is the bar's top-left corner in the document area's own
// pixels; null means the default spot (bottom centre).

const STORAGE_KEY = 'folio.autoScrollControls';

/** The Size menu's choices: a multiplier on the bar's normal dimensions. */
export const SIZES = [
  { label: 'Small', scale: 0.75 },
  { label: 'Medium', scale: 1 },
  { label: 'Large', scale: 1.5 },
  { label: 'Extra large', scale: 2 },
] as const;

export type SizeScale = (typeof SIZES)[number]['scale'];
const SCALE_DEFAULT: SizeScale = 1;

export interface AutoScrollLayout {
  x: number | null;
  y: number | null;
  scale: SizeScale;
}

export const DEFAULT_LAYOUT: AutoScrollLayout = { x: null, y: null, scale: SCALE_DEFAULT };

/** The menu size closest to s, so a stored value is always one of the choices. */
export const nearestSize = (s: number): SizeScale =>
  SIZES.reduce<SizeScale>(
    (best, size) => (Math.abs(size.scale - s) < Math.abs(best - s) ? size.scale : best),
    SIZES[0].scale,
  );

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The stored layout, or the default if none is stored or it does not parse. */
export function readLayout(): AutoScrollLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 200) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_LAYOUT;
    const { x, y, scale } = parsed as Record<string, unknown>;
    const px = finiteOrNull(x);
    const py = finiteOrNull(y);
    const s = finiteOrNull(scale);
    return {
      // A position is all or nothing: half of one would pin the bar oddly.
      x: px !== null && py !== null ? px : null,
      y: px !== null && py !== null ? py : null,
      scale: s === null ? SCALE_DEFAULT : nearestSize(s),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function writeLayout(layout: AutoScrollLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage may be unavailable (private mode); ignore */
  }
}

/** Keep a box of size w×h fully inside an area of size areaW×areaH. */
export function clampPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  areaW: number,
  areaH: number,
): { x: number; y: number } {
  return {
    x: Math.round(Math.min(Math.max(0, x), Math.max(0, areaW - w))),
    y: Math.round(Math.min(Math.max(0, y), Math.max(0, areaH - h))),
  };
}
