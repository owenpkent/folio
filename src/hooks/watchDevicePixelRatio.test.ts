import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolutionBracketQuery, watchDevicePixelRatio } from './watchDevicePixelRatio';

/**
 * A matchMedia stub that models the failure issue #30 reported.
 *
 * `exactOnly: true` reproduces an engine that answers `(resolution: Xdppx)`
 * false when X is a float that does not round-trip -- the trap the old
 * implementation fell into. Range queries are always evaluated honestly, by
 * parsing the bounds out of the query string, so a test can tell the difference
 * between "the query matched" and "the stub was generous".
 */
function installMatchMedia(opts: { exactOnly?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();

  window.matchMedia = ((query: string) => {
    const dpr = window.devicePixelRatio;
    let matches: boolean;

    const exact = /^\(resolution: ([\d.]+)dppx\)$/.exec(query);
    const range = /^\(min-resolution: ([\d.]+)dppx\) and \(max-resolution: ([\d.]+)dppx\)$/.exec(
      query,
    );

    if (exact) {
      // The bug: a fractional ratio interpolated into an equality query fails
      // to match the very resolution it was read from.
      matches = opts.exactOnly ? false : Number(exact[1]) === dpr;
    } else if (range) {
      matches = dpr >= Number(range[1]) && dpr <= Number(range[2]);
    } else {
      matches = false;
    }

    const mql = {
      media: query,
      matches,
      addEventListener: (_: string, cb: () => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(cb);
      },
      removeEventListener: (_: string, cb: () => void) => listeners.get(query)?.delete(cb),
    };
    return mql as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;

  /** Change the ratio and notify every query that was true and is now false. */
  return function setDpr(next: number) {
    const previous = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: next, configurable: true });
    // Snapshot before dispatching. A listener that re-subscribes (which is the
    // behaviour under test) registers a fresh query mid-dispatch, and a real
    // engine would not notify that new query about a change it was not yet
    // watching for. Map iteration visits entries added during the loop, so
    // without the snapshot the stub would double-fire.
    for (const [query, cbs] of [...listeners]) {
      const range = /^\(min-resolution: ([\d.]+)dppx\) and \(max-resolution: ([\d.]+)dppx\)$/.exec(
        query,
      );
      if (!range) continue;
      const wasTrue = previous >= Number(range[1]) && previous <= Number(range[2]);
      const isTrue = next >= Number(range[1]) && next <= Number(range[2]);
      if (wasTrue !== isTrue) for (const cb of [...cbs]) cb();
    }
  };
}

const setRatio = (v: number) =>
  Object.defineProperty(window, 'devicePixelRatio', { value: v, configurable: true });

describe('resolutionBracketQuery', () => {
  it('brackets the ratio so the query is true for it by construction', () => {
    expect(resolutionBracketQuery(2)).toBe(
      '(min-resolution: 1.98dppx) and (max-resolution: 2.02dppx)',
    );
  });

  it('brackets a fractional ratio without relying on it round-tripping', () => {
    // 1.3333333333333333 is Windows at 133%: the value the old equality query
    // interpolated and then failed to match.
    const q = resolutionBracketQuery(4 / 3);
    const [, lo, hi] = /min-resolution: ([\d.]+)dppx\) and \(max-resolution: ([\d.]+)dppx/.exec(q)!;
    expect(4 / 3).toBeGreaterThan(Number(lo));
    expect(4 / 3).toBeLessThan(Number(hi));
  });

  it('keeps the bracket far tighter than the gap between real scale factors', () => {
    // 100% -> 125% moves the ratio by 0.25. The bracket must not span that, or a
    // genuine change would leave the query still true and never fire.
    const q = resolutionBracketQuery(1);
    const [, lo, hi] = /min-resolution: ([\d.]+)dppx\) and \(max-resolution: ([\d.]+)dppx/.exec(q)!;
    expect(Number(hi) - Number(lo)).toBeLessThan(0.25);
  });

  it('never asks for a non-positive resolution', () => {
    expect(resolutionBracketQuery(0.01)).toContain('min-resolution: 0.01dppx');
  });
});

describe('watchDevicePixelRatio', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    setRatio(1);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it('fires when the ratio changes, and re-arms for the next change', () => {
    const setDpr = installMatchMedia();
    const onChange = vi.fn();
    stop = watchDevicePixelRatio(onChange);

    setDpr(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Re-armed around the new ratio rather than left listening to a query that
    // is now false forever.
    setDpr(1.5);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('fires for a fractional ratio, which the old equality query could not', () => {
    // exactOnly models the reported engine behaviour: `(resolution: Xdppx)` is
    // false even for the ratio X was read from. The range query is unaffected,
    // so this is the regression test for #30.
    const setDpr = installMatchMedia({ exactOnly: true });
    setRatio(4 / 3);
    const onChange = vi.fn();
    stop = watchDevicePixelRatio(onChange);

    setDpr(1.5);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('falls back to polling when even the range query will not match', () => {
    // Belt and braces: if the invariant the approach rests on does not hold,
    // detect it at registration rather than failing silently a second time.
    window.matchMedia = ((query: string) =>
      ({
        media: query,
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;

    const onChange = vi.fn();
    stop = watchDevicePixelRatio(onChange);

    setRatio(2);
    expect(onChange).not.toHaveBeenCalled(); // not yet sampled
    vi.advanceTimersByTime(2500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('polls where matchMedia does not exist at all (jsdom, SSR)', () => {
    // @ts-expect-error deliberately removing it
    delete window.matchMedia;
    const onChange = vi.fn();
    stop = watchDevicePixelRatio(onChange);

    setRatio(3);
    vi.advanceTimersByTime(2500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops firing once torn down', () => {
    const setDpr = installMatchMedia();
    const onChange = vi.fn();
    const teardown = watchDevicePixelRatio(onChange);
    teardown();

    setDpr(2);
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
