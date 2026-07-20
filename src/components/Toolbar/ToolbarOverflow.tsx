import { useEffect, useRef, useState } from 'react';

import { Icon, IconButton } from '@/components/common';

import type { OverflowTool } from './toolbarTools';

interface ToolbarOverflowProps {
  items: OverflowTool[];
  /** How many leading items to show inline; the rest collapse into the menu. */
  visibleCount: number;
}

/**
 * Renders the first `visibleCount` toolbar tools inline and collapses the rest
 * into a "More" (⋯) dropdown, so a crowded toolbar never clips its controls off
 * the edge on a narrow window. `visibleCount` is computed by the Toolbar from a
 * width measurement; this component only renders the split.
 */
export function ToolbarOverflow({ items, visibleCount }: ToolbarOverflowProps) {
  const visible = items.slice(0, visibleCount);
  const overflow = items.slice(visibleCount);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // If the window widened enough that nothing overflows anymore, drop the menu.
  useEffect(() => {
    if (overflow.length === 0) setOpen(false);
  }, [overflow.length]);

  return (
    <>
      {visible.map((tool) => (
        <IconButton
          key={tool.id}
          icon={tool.icon}
          label={tool.label}
          active={tool.active}
          disabled={tool.disabled}
          // Comment/Highlight read the live text selection on click; a plain
          // button mousedown would collapse it first.
          onMouseDown={tool.preserveSelection ? (e) => e.preventDefault() : undefined}
          onClick={tool.onClick}
        />
      ))}
      {overflow.length > 0 && (
        <div className="folio-dropdown" ref={ref}>
          <IconButton
            icon="more"
            label="More tools"
            active={open}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          />
          {open && (
            <div className="folio-dropdown__menu" role="menu" aria-label="More tools">
              {overflow.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="menuitem"
                  className="folio-dropdown__item"
                  disabled={tool.disabled}
                  onMouseDown={tool.preserveSelection ? (e) => e.preventDefault() : undefined}
                  onClick={() => {
                    setOpen(false);
                    tool.onClick();
                  }}
                >
                  <Icon name={tool.icon} size={16} />
                  <span className="folio-dropdown__label">{tool.menuLabel}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
