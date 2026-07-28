import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNudgeKeys, type NudgeRect } from './useNudgeKeys';

/**
 * A page-sized ancestor is required: the hook derives its step from the rendered
 * `.folio-page` box so a keystroke moves a predictable number of screen pixels
 * at any zoom. jsdom gives every element a zero-size rect, so stub the lookup.
 */
const PAGE = { width: 100, height: 200 };

function stubPageBox() {
  Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('folio-page')) {
      return { ...PAGE, x: 0, y: 0, top: 0, left: 0, right: PAGE.width, bottom: PAGE.height } as DOMRect;
    }
    return { width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect;
  };
}

interface HarnessProps {
  rect: NudgeRect;
  onChange?: (r: NudgeRect) => void;
  onDelete?: () => void;
  aspectLocked?: boolean;
  minWidth?: number;
}

/** The wiring every layer uses: a focusable wrapper owning the handler. */
function Harness({ rect, onChange = () => {}, onDelete, aspectLocked, minWidth }: HarnessProps) {
  const onKeyDown = useNudgeKeys({
    rect,
    label: 'Text box',
    onChange,
    onDelete,
    aspectLocked,
    minWidth,
  });
  return (
    <div className="folio-page">
      <div
        data-testid="item"
        role="group"
        aria-label="Text box"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <button type="button">Delete</button>
      </div>
    </div>
  );
}

const RECT: NudgeRect = { x: 0.5, y: 0.5, width: 0.2, height: 0.1 };

describe('useNudgeKeys', () => {
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    vi.useFakeTimers();
    stubPageBox();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Element.prototype.getBoundingClientRect = originalRect;
  });

  it('moves by one screen pixel per arrow press, in page fractions', () => {
    const onChange = vi.fn();
    render(<Harness rect={RECT} onChange={onChange} />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: 'ArrowRight' });
    // 1px of a 100px-wide page is 0.01 of its width.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 0.51, y: 0.5 }));

    fireEvent.keyDown(screen.getByTestId('item'), { key: 'ArrowDown' });
    // ...and 1px of a 200px-tall page is 0.005 of its height, so the step is
    // per-axis rather than one shared fraction.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0.5, y: 0.505 }));
  });

  it('moves ten times as far with Shift held', () => {
    const onChange = vi.fn();
    render(<Harness rect={RECT} onChange={onChange} />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 0.4 }));
  });

  it('claims the key, so a handled arrow does not also page the document', () => {
    render(<Harness rect={RECT} />);
    const item = screen.getByTestId('item');

    // jsdom reports defaultPrevented from fireEvent's return value.
    expect(fireEvent.keyDown(item, { key: 'ArrowRight' })).toBe(false);
    // An unhandled key is left entirely alone for the global shortcut layer.
    expect(fireEvent.keyDown(item, { key: 'PageDown' })).toBe(true);
  });

  it('clamps at the page edge and says so instead of reporting a move', () => {
    const onChange = vi.fn();
    render(<Harness rect={{ x: 0, y: 0, width: 0.2, height: 0.1 }} onChange={onChange} />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('grows and shrinks on + and -, treating = as +', () => {
    const onChange = vi.fn();
    render(<Harness rect={RECT} onChange={onChange} />);
    const item = screen.getByTestId('item');

    const widthOfLastCall = () => (onChange.mock.lastCall![0] as NudgeRect).width;

    fireEvent.keyDown(item, { key: '+' });
    expect(widthOfLastCall()).toBeCloseTo(0.21, 6);

    // '=' is the unshifted key '+' sits on, so it must grow too: Shift is the
    // coarse-step modifier here, not part of reaching the key.
    fireEvent.keyDown(item, { key: '=' });
    expect(widthOfLastCall()).toBeCloseTo(0.21, 6);

    fireEvent.keyDown(item, { key: '-' });
    expect(widthOfLastCall()).toBeCloseTo(0.19, 6);
  });

  it('holds the displayed aspect ratio when locked', () => {
    const onChange = vi.fn();
    // 0.2 x 0.1 on a 100x200 page is 20x20 display pixels: square on screen.
    render(<Harness rect={RECT} onChange={onChange} aspectLocked />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: '+' });
    const next = onChange.mock.calls[0][0] as NudgeRect;
    // Still square on screen after growing by a pixel: 21 x 21.
    expect(next.width * PAGE.width).toBeCloseTo(21, 6);
    expect(next.height * PAGE.height).toBeCloseTo(21, 6);
  });

  it('resizes both axes independently when not locked', () => {
    const onChange = vi.fn();
    render(<Harness rect={RECT} onChange={onChange} />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: '+' });
    const next = onChange.mock.calls[0][0] as NudgeRect;
    expect(next.width * PAGE.width).toBeCloseTo(21, 6);
    expect(next.height * PAGE.height).toBeCloseTo(21, 6);
    // Independent per-axis steps, so a non-square box does not become square.
    expect(next.height).toBeCloseTo(0.105, 6);
  });

  it('refuses to shrink below the minimum width', () => {
    const onChange = vi.fn();
    render(<Harness rect={{ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }} onChange={onChange} minWidth={0.05} />);

    fireEvent.keyDown(screen.getByTestId('item'), { key: '-' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes on Delete and Backspace, and leaves them alone with no handler', () => {
    const onDelete = vi.fn();
    const { unmount } = render(<Harness rect={RECT} onDelete={onDelete} />);
    fireEvent.keyDown(screen.getByTestId('item'), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('item'), { key: 'Backspace' });
    expect(onDelete).toHaveBeenCalledTimes(2);
    unmount();

    // Without onDelete the key is not claimed, so Backspace keeps whatever
    // meaning the surrounding app gives it.
    render(<Harness rect={RECT} />);
    expect(fireEvent.keyDown(screen.getByTestId('item'), { key: 'Backspace' })).toBe(true);
  });

  it('ignores keys bubbling up from a descendant', () => {
    const onChange = vi.fn();
    const onDelete = vi.fn();
    render(<Harness rect={RECT} onChange={onChange} onDelete={onDelete} />);

    // A text box's contentEditable and every layer's delete button are
    // descendants: an arrow there must move the caret, and Backspace must
    // delete a character, not the whole item.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Delete' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Delete' }), { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('announces once after a run of keystrokes settles, not per key', () => {
    // Asserted against the live region the announcer writes to, rather than by
    // spying on the module: what matters is what a screen reader would be
    // handed, and that a run of presses does not flood it.
    let rect = RECT;
    const onChange = (r: NudgeRect) => {
      rect = r;
    };
    const { rerender } = render(<Harness rect={rect} onChange={onChange} />);

    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(screen.getByTestId('item'), { key: 'ArrowRight' });
      rerender(<Harness rect={rect} onChange={onChange} />);
    }
    // Nothing announced yet: the run is still in progress.
    const region = () => document.querySelector('[aria-live]')?.textContent ?? '';
    expect(region()).not.toMatch(/moved to/);

    vi.advanceTimersByTime(600);
    expect(region()).toMatch(/Text box moved to 55% across/);
  });
});
