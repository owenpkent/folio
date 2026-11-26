import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTO_SCROLL_MAX,
  AUTO_SCROLL_MIN,
  describeAutoScrollSpeed,
  stepAutoScrollSpeed,
  useViewerStore,
} from './viewerStore';

const UP = 1 / 1.3;
const DOWN = 1.3;

describe('stepAutoScrollSpeed', () => {
  it('speeds up and slows down in the current direction', () => {
    expect(stepAutoScrollSpeed(12, DOWN)).toBe(16);
    expect(stepAutoScrollSpeed(12, UP)).toBe(9);
    expect(stepAutoScrollSpeed(-12, UP)).toBe(-16);
    expect(stepAutoScrollSpeed(-12, DOWN)).toBe(-9);
  });

  it('crosses zero from the slowest speed to the slowest speed the other way', () => {
    expect(stepAutoScrollSpeed(AUTO_SCROLL_MIN, UP)).toBe(-AUTO_SCROLL_MIN);
    expect(stepAutoScrollSpeed(-AUTO_SCROLL_MIN, DOWN)).toBe(AUTO_SCROLL_MIN);
    // A step that would land below the slowest speed stops there first.
    expect(stepAutoScrollSpeed(5, UP)).toBe(AUTO_SCROLL_MIN);
    expect(stepAutoScrollSpeed(-5, DOWN)).toBe(-AUTO_SCROLL_MIN);
  });

  it('holds at full speed either way', () => {
    expect(stepAutoScrollSpeed(AUTO_SCROLL_MAX, DOWN)).toBe(AUTO_SCROLL_MAX);
    expect(stepAutoScrollSpeed(-AUTO_SCROLL_MAX, UP)).toBe(-AUTO_SCROLL_MAX);
  });

  it('walks from full speed down to full speed up and back without getting stuck', () => {
    let speed = AUTO_SCROLL_MAX;
    for (let i = 0; i < 60 && speed !== -AUTO_SCROLL_MAX; i++)
      speed = stepAutoScrollSpeed(speed, UP);
    expect(speed).toBe(-AUTO_SCROLL_MAX);
    for (let i = 0; i < 60 && speed !== AUTO_SCROLL_MAX; i++)
      speed = stepAutoScrollSpeed(speed, DOWN);
    expect(speed).toBe(AUTO_SCROLL_MAX);
  });

  it('ignores a factor that is not a step', () => {
    expect(stepAutoScrollSpeed(12, 1)).toBe(12);
    expect(stepAutoScrollSpeed(-12, Number.NaN)).toBe(-12);
  });
});

describe('auto-scroll speed in the store', () => {
  afterEach(() => useViewerStore.getState().reset());

  it('keeps the direction when setting, and clamps the size', () => {
    const { setAutoScrollSpeed } = useViewerStore.getState();
    setAutoScrollSpeed(-500);
    expect(useViewerStore.getState().autoScrollSpeed).toBe(-AUTO_SCROLL_MAX);
    setAutoScrollSpeed(-1);
    expect(useViewerStore.getState().autoScrollSpeed).toBe(-AUTO_SCROLL_MIN);
    setAutoScrollSpeed(0);
    expect(useViewerStore.getState().autoScrollSpeed).toBe(AUTO_SCROLL_MIN);
    setAutoScrollSpeed(500);
    expect(useViewerStore.getState().autoScrollSpeed).toBe(AUTO_SCROLL_MAX);
  });

  it('steps through zero with adjustAutoScrollSpeed', () => {
    const store = useViewerStore.getState();
    store.setAutoScrollSpeed(AUTO_SCROLL_MIN);
    store.adjustAutoScrollSpeed(UP);
    expect(useViewerStore.getState().autoScrollSpeed).toBe(-AUTO_SCROLL_MIN);
  });

  it('describes the speed with its direction', () => {
    expect(describeAutoScrollSpeed(12)).toBe('12 pixels per second, down');
    expect(describeAutoScrollSpeed(-12)).toBe('12 pixels per second, up');
  });
});
