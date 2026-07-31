import { describe, expect, it, vi } from 'vitest';

import { LruMap } from './lru';

describe('LruMap', () => {
  it('evicts the least recently used entry past the limit', () => {
    const evicted: number[] = [];
    const lru = new LruMap<number, string>(3, (_value, key) => evicted.push(key));

    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(3, 'c');
    expect(evicted).toEqual([]);

    lru.set(4, 'd');
    expect(evicted).toEqual([1]);
    expect(lru.get(1)).toBeUndefined();
    expect(lru.size).toBe(3);
  });

  it('a read counts as use, so the read entry survives the next eviction', () => {
    const evicted: number[] = [];
    const lru = new LruMap<number, string>(2, (_value, key) => evicted.push(key));

    lru.set(1, 'a');
    lru.set(2, 'b');
    expect(lru.get(1)).toBe('a'); // 1 is now the most recently used, 2 the least

    lru.set(3, 'c');
    expect(evicted).toEqual([2]);
    expect(lru.get(1)).toBe('a');
  });

  it('overwriting a key refreshes it without evicting anything', () => {
    const onEvict = vi.fn();
    const lru = new LruMap<number, string>(2, onEvict);

    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(1, 'a2');

    expect(onEvict).not.toHaveBeenCalled();
    expect(lru.get(1)).toBe('a2');
    expect(lru.size).toBe(2);

    // 2 is now the least recently used, so it goes first.
    lru.set(3, 'c');
    expect(onEvict).toHaveBeenCalledWith('b', 2);
  });

  it('hands the evicted value to onEvict so it can be released', () => {
    const released: string[] = [];
    const lru = new LruMap<number, string>(1, (value) => released.push(value));

    lru.set(1, 'first');
    lru.set(2, 'second');
    expect(released).toEqual(['first']);
  });

  it('clear drops everything without running onEvict', () => {
    const onEvict = vi.fn();
    const lru = new LruMap<number, string>(4, onEvict);

    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.clear();

    expect(lru.size).toBe(0);
    expect(lru.get(1)).toBeUndefined();
    expect(onEvict).not.toHaveBeenCalled();
  });

  it('treats a nonsense limit as one rather than evicting forever', () => {
    for (const limit of [0, -5, 0.4, Number.NaN]) {
      const lru = new LruMap<number, string>(limit);
      lru.set(1, 'a');
      lru.set(2, 'b');
      expect(lru.size).toBe(1);
      expect(lru.get(2)).toBe('b');
    }
  });

  it('has() reports membership without disturbing the order', () => {
    const evicted: number[] = [];
    const lru = new LruMap<number, string>(2, (_v, key) => evicted.push(key));

    lru.set(1, 'a');
    lru.set(2, 'b');
    expect(lru.has(1)).toBe(true);
    expect(lru.has(9)).toBe(false);

    // has() did not count as use, so 1 is still the least recently used.
    lru.set(3, 'c');
    expect(evicted).toEqual([1]);
  });
});
