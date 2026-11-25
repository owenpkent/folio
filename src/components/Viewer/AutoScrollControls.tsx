import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent } from 'react';

import { announce } from '@/a11y/announcer';
import { Icon } from '@/components/common/Icon';
import { AUTO_SCROLL_MAX, AUTO_SCROLL_MIN, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import {
  type AutoScrollLayout,
  clampPosition,
  readLayout,
  SIZES,
  writeLayout,
} from './autoScrollLayout';

// One press of slower/faster: the same step as the arrow keys while scrolling.
const SPEED_STEP = 1.3;
// Gap between the Size button and its menu (matches the CSS offset).
const MENU_GAP = 10;
// Fallback for the menu's height before it has been measured.
const MENU_HEIGHT_GUESS = 190;

interface MenuPlace {
  dir: 'up' | 'down';
  /** Caps the menu to the room on its side so it is never clipped. */
  maxHeight: number | undefined;
}

/**
 * The floating transport shown over the document while auto-scroll is on:
 * a large play/pause button with slower and faster either side, the current
 * speed, and a stop button. Sized as pointer targets, not toolbar icons, so the
 * whole feature can be driven by mouse without hunting for small buttons.
 * Drag any empty part of the bar to move it; the Size menu makes it bigger.
 */
export function AutoScrollControls() {
  const hasDoc = useDocumentStore((s) => s.status === 'ready');
  const autoScroll = useViewerStore((s) => s.autoScroll);
  if (!hasDoc || !autoScroll) return null;
  return <AutoScrollBar />;
}

interface Drag {
  pointerId: number;
  /** Where the pointer grabbed the bar, relative to the bar's top-left. */
  grabX: number;
  grabY: number;
}

// Controls inside the bar keep their own clicks; everything else drags it.
const CONTROL = 'button, [role="menu"]';

/** A point in the document area's own coordinates (its border excluded). */
function pointInArea(area: HTMLElement, clientX: number, clientY: number) {
  const a = area.getBoundingClientRect();
  return { x: clientX - a.left - area.clientLeft, y: clientY - a.top - area.clientTop };
}

/**
 * The bar's top-left in the document area's coordinates. Measured from the
 * rendered box, so it includes the centring transform; offsetLeft does not,
 * which made the bar leap half its width when a drag began.
 */
function barInArea(bar: HTMLElement, area: HTMLElement) {
  const b = bar.getBoundingClientRect();
  return pointInArea(area, b.left, b.top);
}

function AutoScrollBar() {
  const paused = useViewerStore((s) => s.autoScrollPaused);
  const speed = useViewerStore((s) => s.autoScrollSpeed);
  const [layout, setLayout] = useState<AutoScrollLayout>(readLayout);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [place, setPlace] = useState<MenuPlace>({ dir: 'down', maxHeight: undefined });
  const [activeItem, setActiveItem] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const sizeBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<Drag | null>(null);
  // The latest layout, for saving once a drag ends.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  const areaOf = (bar: HTMLElement | null) =>
    (bar?.offsetParent ?? bar?.parentElement) as HTMLElement | null | undefined;

  // Keep a placed bar fully on screen: after a size change, and when the
  // window (and so the document area) shrinks.
  const fitIntoArea = useCallback(() => {
    const bar = barRef.current;
    const area = areaOf(bar);
    if (!bar || !area) return;
    setLayout((l) => {
      if (l.x === null || l.y === null) return l;
      const p = clampPosition(
        l.x,
        l.y,
        bar.offsetWidth,
        bar.offsetHeight,
        area.clientWidth,
        area.clientHeight,
      );
      return p.x === l.x && p.y === l.y ? l : { ...l, ...p };
    });
  }, []);
  useLayoutEffect(fitIntoArea, [fitIntoArea, layout.scale]);
  useEffect(() => {
    // The area can resize with no window resize (the sidebar toggling), so watch
    // the area itself; the window listener covers environments without it.
    window.addEventListener('resize', fitIntoArea);
    const area = areaOf(barRef.current);
    let ro: ResizeObserver | undefined;
    if (area && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fitIntoArea());
      ro.observe(area);
    }
    return () => {
      window.removeEventListener('resize', fitIntoArea);
      ro?.disconnect();
    };
  }, [fitIntoArea]);

  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) sizeBtnRef.current?.focus();
  }, []);

  // Close the size menu on a press outside it, or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!sizeRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape here closes the menu only; it must not also stop auto-scroll.
      e.stopImmediatePropagation();
      e.preventDefault();
      closeMenu(true);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen, closeMenu]);

  // On open, choose the side with room and cap the height to it, measured against
  // the document area, then focus the current size.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const anchor = sizeRef.current;
    const menuEl = menuRef.current;
    const area = areaOf(barRef.current);
    if (anchor && menuEl && area) {
      const a = anchor.getBoundingClientRect();
      const r = area.getBoundingClientRect();
      const below = Math.max(0, r.bottom - a.bottom - MENU_GAP);
      const above = Math.max(0, a.top - r.top - MENU_GAP);
      const need = menuEl.scrollHeight || MENU_HEIGHT_GUESS;
      const dir = below >= need || below >= above ? 'down' : 'up';
      const room = dir === 'down' ? below : above;
      setPlace({ dir, maxHeight: room > 0 && room < need ? Math.floor(room) : undefined });
    }
    itemRefs.current[activeItem]?.focus();
    // Runs once per open; activeItem is set before opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  const commit = (next: AutoScrollLayout) => {
    setLayout(next);
    writeLayout(next);
  };

  // The grab point stays under the pointer for the whole drag.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    const area = areaOf(bar);
    if (e.button !== 0 || !bar || !area) return;
    if ((e.target as Element).closest(CONTROL)) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const at = pointInArea(area, e.clientX, e.clientY);
    const box = barInArea(bar, area);
    dragRef.current = { pointerId: e.pointerId, grabX: at.x - box.x, grabY: at.y - box.y };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const bar = barRef.current;
    const area = areaOf(bar);
    if (!d || e.pointerId !== d.pointerId || !bar || !area) return;
    const at = pointInArea(area, e.clientX, e.clientY);
    const p = clampPosition(
      at.x - d.grabX,
      at.y - d.grabY,
      bar.offsetWidth,
      bar.offsetHeight,
      area.clientWidth,
      area.clientHeight,
    );
    setLayout((l) => ({ ...l, ...p }));
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    writeLayout(layoutRef.current);
  };

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const current = SIZES.findIndex((size) => size.scale === layout.scale);
    setActiveItem(current < 0 ? 0 : current);
    setPlace({ dir: 'down', maxHeight: undefined });
    setMenuOpen(true);
  };

  const focusItem = (i: number) => {
    const n = SIZES.length;
    const next = ((i % n) + n) % n;
    setActiveItem(next);
    itemRefs.current[next]?.focus();
  };

  // WAI-ARIA menu button pattern. These keys stop here so the viewer's
  // auto-scroll handler (arrows change speed) never sees them.
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
        // Focus goes back to the Size button, then Tab moves on from there.
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

  const store = () => useViewerStore.getState();
  const adjust = (factor: number) => {
    store().adjustAutoScrollSpeed(factor);
    announce(`Auto-scroll speed ${store().autoScrollSpeed} pixels per second`);
  };

  const s = layout.scale;
  const placed = layout.x !== null && layout.y !== null;
  const style = {
    '--folio-as-scale': s,
    ...(placed
      ? { left: layout.x, top: layout.y, right: 'auto', bottom: 'auto', marginInline: 0 }
      : {}),
  } as CSSProperties;

  return (
    <div
      ref={barRef}
      className={`folio-autoscroll${dragging ? ' is-dragging' : ''}`}
      role="toolbar"
      aria-label="Auto-scroll controls"
      title="Drag to move. Double-click to put it back at the bottom."
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest(CONTROL)) return;
        commit({ ...layout, x: null, y: null });
      }}
    >
      <button
        type="button"
        className="folio-autoscroll__btn"
        aria-label="Slower"
        title="Slower (↓ or −)"
        disabled={speed <= AUTO_SCROLL_MIN}
        onClick={() => adjust(1 / SPEED_STEP)}
      >
        <Icon name="minus" size={Math.round(26 * s)} />
      </button>
      <button
        type="button"
        className="folio-autoscroll__btn folio-autoscroll__play"
        aria-label={paused ? 'Play' : 'Pause'}
        title={paused ? 'Play (Space)' : 'Pause (Space)'}
        onClick={() => {
          store().toggleAutoScrollPaused();
          announce(store().autoScrollPaused ? 'Auto-scroll paused' : 'Auto-scroll playing');
        }}
      >
        <Icon name={paused ? 'play' : 'pause'} size={Math.round(34 * s)} />
      </button>
      <button
        type="button"
        className="folio-autoscroll__btn"
        aria-label="Faster"
        title="Faster (↑ or +)"
        disabled={speed >= AUTO_SCROLL_MAX}
        onClick={() => adjust(SPEED_STEP)}
      >
        <Icon name="plus" size={Math.round(26 * s)} />
      </button>
      <span className="folio-autoscroll__speed" aria-hidden="true">
        {speed}
        <small>px/s</small>
      </span>
      <button
        type="button"
        className="folio-autoscroll__btn folio-autoscroll__stop"
        aria-label="Stop auto-scroll"
        title="Stop auto-scroll (Esc)"
        onClick={() => {
          store().setAutoScroll(false);
          announce('Auto-scroll off');
        }}
      >
        <Icon name="x" size={Math.round(24 * s)} />
      </button>
      <div className="folio-autoscroll__size" ref={sizeRef}>
        <button
          ref={sizeBtnRef}
          type="button"
          className="folio-autoscroll__btn"
          aria-label="Size"
          title="Size of these controls"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
        >
          <Icon name="resize" size={Math.round(20 * s)} />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            className={`folio-dropdown__menu folio-autoscroll__menu is-${place.dir}`}
            style={place.maxHeight ? { maxHeight: place.maxHeight } : undefined}
            role="menu"
            tabIndex={-1}
            aria-label="Size"
            onKeyDown={onMenuKeyDown}
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
                  commit({ ...layout, scale: size.scale });
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
    </div>
  );
}
