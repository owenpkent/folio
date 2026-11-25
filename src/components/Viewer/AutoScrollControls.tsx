import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';

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
// The size menu opens upward unless the bar sits closer than this to the top.
const MENU_ROOM = 220;

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
  const [menu, setMenu] = useState<'up' | 'down' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  // The latest layout, for saving once a drag ends.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  const areaOf = (bar: HTMLElement | null) => bar?.offsetParent as HTMLElement | null | undefined;

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
    window.addEventListener('resize', fitIntoArea);
    return () => window.removeEventListener('resize', fitIntoArea);
  }, [fitIntoArea]);

  // Close the size menu on a press outside it, or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!sizeRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape here closes the menu only; it must not also stop auto-scroll.
      e.stopImmediatePropagation();
      e.preventDefault();
      setMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

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
    if (menu) {
      setMenu(null);
      return;
    }
    const bar = barRef.current;
    const area = areaOf(bar);
    const top = bar && area ? barInArea(bar, area).y : Infinity;
    setMenu(top < MENU_ROOM ? 'down' : 'up');
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
    ...(placed ? { left: layout.x, top: layout.y, bottom: 'auto', transform: 'none' } : {}),
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
          type="button"
          className="folio-autoscroll__btn"
          aria-label="Size"
          title="Size of these controls"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={toggleMenu}
        >
          <Icon name="resize" size={Math.round(20 * s)} />
        </button>
        {menu && (
          <div
            className={`folio-dropdown__menu folio-autoscroll__menu is-${menu}`}
            role="menu"
            aria-label="Size"
          >
            {SIZES.map((size) => (
              <button
                key={size.label}
                type="button"
                role="menuitemradio"
                aria-checked={s === size.scale}
                className="folio-dropdown__item"
                onClick={() => {
                  commit({ ...layout, scale: size.scale });
                  announce(`Auto-scroll controls ${size.label}`);
                  setMenu(null);
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
