import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { announce } from '@/a11y/announcer';
import { Icon } from '@/components/common/Icon';
import {
  AUTO_SCROLL_MAX,
  AUTO_SCROLL_MIN,
  describeAutoScrollSpeed,
  stepAutoScrollSpeed,
  useViewerStore,
} from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { type AutoScrollLayout, readLayout, SIZES, writeLayout } from './autoScrollLayout';

// One press of − or +: the same step as the arrow keys while scrolling.
const SPEED_STEP = 1.3;
// Holding − or + steps again after HOLD_DELAY, then every HOLD_INTERVAL. Slow
// on purpose: a press that takes a moment to release should not run away.
export const HOLD_DELAY = 500;
export const HOLD_INTERVAL = 200;

/**
 * What − and + will do from this speed (signed: negative scrolls up). − moves
 * toward scrolling up and + toward scrolling down, through zero, so each name
 * says what the next press does.
 */
function speedLabels(speed: number): { up: string; down: string } {
  if (speed > 0) {
    return {
      up: speed <= AUTO_SCROLL_MIN ? 'Reverse, scroll up' : 'Slower',
      down: 'Faster',
    };
  }
  return {
    up: 'Faster',
    down: speed >= -AUTO_SCROLL_MIN ? 'Reverse, scroll down' : 'Slower',
  };
}
// Keeps the size menu this far inside the window edges.
const EDGE = 8;

/**
 * The auto-scroll controls shown over the document while auto-scroll is on: a
 * large play/pause puck fixed in the bottom-right corner, with small − and +
 * buttons under it. − slows a downward scroll and, past the slowest speed,
 * scrolls up; + does the reverse. Holding either keeps stepping, but a held
 * press stops at the slowest speed rather than reversing: reversing always
 * takes a fresh press. Esc or the toolbar's auto-scroll button stops
 * it. Right-clicking anywhere on the controls
 * (or Shift+F10 / the Menu key on one of them) opens a menu to pick their
 * size. Sized as pointer targets, not toolbar icons, so the whole feature can
 * be driven by mouse. Nothing opens on hover or closes on a timer.
 */
export function AutoScrollControls() {
  const hasDoc = useDocumentStore((s) => s.status === 'ready');
  const autoScroll = useViewerStore((s) => s.autoScroll);
  if (!hasDoc || !autoScroll) return null;
  return <AutoScrollBar />;
}

function AutoScrollBar() {
  const paused = useViewerStore((s) => s.autoScrollPaused);
  const speed = useViewerStore((s) => s.autoScrollSpeed);
  const [layout, setLayout] = useState<AutoScrollLayout>(readLayout);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [activeItem, setActiveItem] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Whatever had focus when the menu opened, so closing can hand it back.
  const returnFocus = useRef<HTMLElement | null>(null);

  const s = layout.scale;
  const labels = speedLabels(speed);
  const store = () => useViewerStore.getState();
  const adjust = (factor: number) => {
    store().adjustAutoScrollSpeed(factor);
    announce(`Auto-scroll speed ${describeAutoScrollSpeed(store().autoScrollSpeed)}`);
  };

  // Press and hold − or +. The press itself steps on pointerdown, so the click
  // that follows a mouse or touch press is ignored (it has a detail count);
  // a keyboard click (Enter or Space, detail 0) steps through onClick.
  const holdTimer = useRef<number | undefined>(undefined);
  const stopHold = useCallback(() => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  }, []);
  useEffect(() => stopHold, [stopHold]);
  // One held step; false when the hold should end (a limit, or the crossing).
  const heldStep = (factor: number): boolean => {
    const before = store().autoScrollSpeed;
    const next = stepAutoScrollSpeed(before, factor);
    if (next === before || Math.sign(next) !== Math.sign(before)) return false;
    adjust(factor);
    return true;
  };
  const startHold = (e: ReactPointerEvent<HTMLButtonElement>, factor: number) => {
    if (e.button !== 0) return;
    stopHold();
    // Keep receiving pointerup even if the pointer drifts off the button.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    adjust(factor);
    const tick = (delay: number) => {
      holdTimer.current = window.setTimeout(() => {
        if (heldStep(factor)) tick(HOLD_INTERVAL);
        else stopHold();
      }, delay);
    };
    tick(HOLD_DELAY);
  };
  const holdProps = (factor: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => startHold(e, factor),
    onPointerUp: stopHold,
    onPointerCancel: stopHold,
    onLostPointerCapture: stopHold,
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) adjust(factor);
    },
  });

  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(null);
    if (refocus) returnFocus.current?.focus();
  }, []);

  const openMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A keyboard-opened menu (Shift+F10, the Menu key) reports no pointer
    // position: put it at the focused control instead.
    let { clientX: x, clientY: y } = e;
    if (x === 0 && y === 0) {
      const box = (e.target as Element).getBoundingClientRect();
      x = box.left;
      y = box.top;
    }
    const current = SIZES.findIndex((size) => size.scale === s);
    setActiveItem(current < 0 ? 0 : current);
    setMenu({ x, y });
  };

  // Keep the menu inside the window, then focus the current size.
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(EDGE, Math.min(menu.x, window.innerWidth - width - EDGE));
    const y = Math.max(EDGE, Math.min(menu.y, window.innerHeight - height - EDGE));
    if (x !== menu.x || y !== menu.y) setMenu({ x, y });
    itemRefs.current[activeItem]?.focus();
    // Runs on open and after the clamp; activeItem is set before opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // Close on a press outside the menu, on Escape, or when the window changes.
  const isOpen = menu !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape here closes the menu only; it must not also stop auto-scroll.
      e.stopImmediatePropagation();
      e.preventDefault();
      closeMenu(true);
    };
    const onLeave = () => setMenu(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onLeave);
    window.addEventListener('resize', onLeave);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onLeave);
    };
  }, [isOpen, closeMenu]);

  const focusItem = (i: number) => {
    const n = SIZES.length;
    const next = ((i % n) + n) % n;
    setActiveItem(next);
    itemRefs.current[next]?.focus();
  };

  // WAI-ARIA menu keys. They stop here so the viewer's auto-scroll keys
  // (arrows change speed, Space pauses) never see them.
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const at = itemRefs.current.findIndex((el) => el === document.activeElement);
    const here = at < 0 ? activeItem : at;
    switch (e.key) {
      case 'ArrowDown':
        focusItem(here + 1);
        break;
      case 'ArrowUp':
        focusItem(here - 1);
        break;
      case 'Home':
        focusItem(0);
        break;
      case 'End':
        focusItem(SIZES.length - 1);
        break;
      case 'Tab':
        // Focus goes back to where the menu opened from, then Tab moves on.
        closeMenu(true);
        return;
      default:
        // Enter and Space click the focused item; nothing else leaks out.
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="folio-autoscroll"
      role="toolbar"
      aria-label="Auto-scroll controls"
      style={{ '--folio-as-scale': s } as CSSProperties}
      onContextMenu={openMenu}
    >
      <button
        type="button"
        className="folio-autoscroll__btn folio-autoscroll__play"
        aria-label={paused ? 'Play' : 'Pause'}
        title={`${paused ? 'Play' : 'Pause'} (Space). Right-click for size`}
        onClick={() => {
          store().toggleAutoScrollPaused();
          announce(store().autoScrollPaused ? 'Auto-scroll paused' : 'Auto-scroll playing');
        }}
      >
        <Icon name={paused ? 'play' : 'pause'} size={Math.round(40 * s)} />
      </button>
      <div className="folio-autoscroll__speed">
        <button
          type="button"
          className="folio-autoscroll__btn folio-autoscroll__btn--small"
          aria-label={labels.up}
          title={`${labels.up} (↓ or −)`}
          disabled={speed <= -AUTO_SCROLL_MAX}
          {...holdProps(1 / SPEED_STEP)}
        >
          <Icon name="minus" size={Math.round(28 * s)} />
        </button>
        <button
          type="button"
          className="folio-autoscroll__btn folio-autoscroll__btn--small"
          aria-label={labels.down}
          title={`${labels.down} (↑ or +)`}
          disabled={speed >= AUTO_SCROLL_MAX}
          {...holdProps(SPEED_STEP)}
        >
          <Icon name="plus" size={Math.round(28 * s)} />
        </button>
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="folio-dropdown__menu folio-autoscroll__menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          tabIndex={-1}
          aria-label="Size of auto-scroll controls"
          onKeyDown={onMenuKeyDown}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {SIZES.map((size, i) => (
            <button
              key={size.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              tabIndex={i === activeItem ? 0 : -1}
              type="button"
              role="menuitemradio"
              aria-checked={s === size.scale}
              className="folio-dropdown__item"
              onClick={() => {
                const next = { ...layout, scale: size.scale };
                setLayout(next);
                writeLayout(next);
                announce(`Auto-scroll controls ${size.label}`);
                closeMenu(true);
              }}
            >
              <span className="folio-dropdown__label">{size.label}</span>
              {s === size.scale && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
