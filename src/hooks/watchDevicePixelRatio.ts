/**
 * Fire a callback when `window.devicePixelRatio` changes, which happens with no
 * resize event when a window is dragged between monitors on different scale
 * factors. The viewer uses it to re-rasterise visible pages at the new density.
 *
 * The usual trick is a `matchMedia('(resolution: Xdppx)')` query built from the
 * current ratio: it evaluates true now, so any change to the ratio flips it
 * false and fires `change`. That trick has a trap, which is what issue #30
 * reported. `devicePixelRatio` is frequently fractional -- Windows at 133%
 * scaling reports 1.3333333333333333 -- and an exact-equality query built by
 * interpolating that float may not evaluate true for the resolution it came
 * from. A query that starts false stays false when the ratio changes to some
 * other value, so `change` never fires and the whole feature silently does
 * nothing, on exactly the fractional-scaling displays it exists for.
 *
 * So this uses a *range* query bracketing the current ratio instead. It is true
 * now by construction, whatever the float, and goes false as soon as the ratio
 * moves outside the bracket. The bracket is far tighter than any real change in
 * scale factor (the smallest common step, 100% to 125%, moves the ratio by
 * 0.25), so no genuine change is missed.
 *
 * A poll is kept as a backstop for the case where even the range query does not
 * match -- an engine quirk this cannot anticipate -- rather than trusting the
 * query and failing silently a second time. It is only armed when the query
 * fails, so the normal path costs nothing.
 */

/**
 * Half-width of the bracket around the current ratio, in dppx. Comfortably
 * larger than float error, comfortably smaller than the 0.25 between adjacent
 * Windows scale factors.
 */
const BRACKET_DPPX = 0.02;

/** How often the backstop samples the ratio, when it is armed at all. */
const POLL_MS = 2000;

/**
 * A media query that is true for `dpr` and false once the ratio moves off it.
 * Exported for tests: the whole point of the fix is which query gets built.
 */
export function resolutionBracketQuery(dpr: number): string {
  const lo = Math.max(0.01, dpr - BRACKET_DPPX);
  const hi = dpr + BRACKET_DPPX;
  return `(min-resolution: ${lo}dppx) and (max-resolution: ${hi}dppx)`;
}

/**
 * Call `onChange` whenever the device pixel ratio changes. Returns a teardown.
 *
 * Safe where `matchMedia` is unavailable (jsdom): falls back to the poll.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let mql: MediaQueryList | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeen = window.devicePixelRatio || 1;
  let stopped = false;

  const detach = () => {
    mql?.removeEventListener('change', handleChange);
    mql = null;
  };

  const stopPoll = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  };

  /** The backstop: only armed when the query could not be trusted to fire. */
  const startPoll = () => {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      const now = window.devicePixelRatio || 1;
      if (now !== lastSeen) {
        lastSeen = now;
        onChange();
        // A fresh ratio may well be one the query engine handles, so try to get
        // back onto the cheap path rather than polling forever.
        stopPoll();
        subscribe();
      }
    }, POLL_MS);
  };

  function handleChange() {
    if (stopped) return;
    lastSeen = window.devicePixelRatio || 1;
    onChange();
    // The listener is registered `once`, and the old query is now false
    // forever, so re-bracket around the new ratio.
    subscribe();
  }

  function subscribe() {
    if (stopped) return;
    detach();
    lastSeen = window.devicePixelRatio || 1;

    if (typeof window.matchMedia !== 'function') {
      startPoll();
      return;
    }

    mql = window.matchMedia(resolutionBracketQuery(lastSeen));
    // The invariant the whole approach rests on. If it does not hold, the query
    // can never flip, so do not pretend it will.
    if (!mql.matches) {
      detach();
      startPoll();
      return;
    }
    stopPoll();
    mql.addEventListener('change', handleChange, { once: true });
  }

  subscribe();

  return () => {
    stopped = true;
    detach();
    stopPoll();
  };
}
