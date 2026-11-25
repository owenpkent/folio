import { useId, useState } from 'react';
import type { CSSProperties } from 'react';

import { announce } from '@/a11y/announcer';
import { Icon } from '@/components/common/Icon';
import { AUTO_SCROLL_MAX, AUTO_SCROLL_MIN, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { type AutoScrollLayout, readLayout, SIZES, writeLayout } from './autoScrollLayout';

// One press of slower/faster: the same step as the arrow keys while scrolling.
const SPEED_STEP = 1.3;

/**
 * The auto-scroll controls shown over the document while auto-scroll is on: a
 * large play/pause puck fixed in the bottom-right corner, and a chevron that
 * opens a panel above them with slower, faster, stop and the control size.
 * Sized as pointer targets, not toolbar icons, so the whole feature can be
 * driven by mouse. The panel opens and closes only on a click: no hover, no
 * timer, so nothing moves under a pointer that is hard to hold steady.
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
  const panelId = useId();

  const commit = (next: AutoScrollLayout) => {
    setLayout(next);
    writeLayout(next);
  };

  const store = () => useViewerStore.getState();
  const adjust = (factor: number) => {
    store().adjustAutoScrollSpeed(factor);
    announce(`Auto-scroll speed ${store().autoScrollSpeed} pixels per second`);
  };

  const s = layout.scale;
  const { expanded } = layout;

  return (
    <div
      className="folio-autoscroll"
      role="toolbar"
      aria-label="Auto-scroll controls"
      style={{ '--folio-as-scale': s } as CSSProperties}
    >
      {expanded && (
        <div className="folio-autoscroll__panel" id={panelId}>
          <div className="folio-autoscroll__row">
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
            <span className="folio-autoscroll__speed" aria-hidden="true">
              {speed}
              <small>px/s</small>
            </span>
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
          </div>
          <div className="folio-autoscroll__row" role="group" aria-label="Size">
            {SIZES.map((size) => (
              <button
                key={size.label}
                type="button"
                className="folio-autoscroll__size"
                aria-label={size.label}
                title={size.label}
                aria-pressed={s === size.scale}
                onClick={() => {
                  commit({ ...layout, scale: size.scale });
                  announce(`Auto-scroll controls ${size.label}`);
                }}
              >
                {size.short}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="folio-autoscroll__base">
        <button
          type="button"
          className="folio-autoscroll__btn folio-autoscroll__toggle"
          aria-label={expanded ? 'Fewer auto-scroll controls' : 'More auto-scroll controls'}
          title={expanded ? 'Fewer auto-scroll controls' : 'More auto-scroll controls'}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => commit({ ...layout, expanded: !expanded })}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={Math.round(24 * s)} />
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
          <Icon name={paused ? 'play' : 'pause'} size={Math.round(40 * s)} />
        </button>
      </div>
    </div>
  );
}
