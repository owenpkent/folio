import { useEffect, useRef, useState } from 'react';

import { Icon, IconButton } from '@/components/common';
import {
  DARK_SCHEME_LABELS,
  DARK_SCHEME_TINT,
  useThemeStore,
  type DarkScheme,
} from '@/theme/themeStore';

const SCHEMES: DarkScheme[] = ['night', 'green', 'amber'];

const inkColor = (scheme: DarkScheme): string => {
  const tint = DARK_SCHEME_TINT[scheme];
  return tint ? `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})` : '#ffffff';
};

/** Picks the color scheme the page renders in when dark mode is on. */
export function DarkSchemeMenu() {
  const darkScheme = useThemeStore((s) => s.darkScheme);
  const setDarkScheme = useThemeStore((s) => s.setDarkScheme);
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

  return (
    <div className="folio-dropdown" ref={ref}>
      <IconButton
        icon="contrast"
        label={`Dark reading color: ${DARK_SCHEME_LABELS[darkScheme]}`}
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="folio-dropdown__menu" role="menu" aria-label="Dark reading color">
          {SCHEMES.map((scheme) => (
            <button
              key={scheme}
              type="button"
              role="menuitemradio"
              aria-checked={darkScheme === scheme}
              className="folio-dropdown__item"
              onClick={() => {
                setDarkScheme(scheme);
                setOpen(false);
              }}
            >
              <span
                className="folio-swatch"
                style={{ color: inkColor(scheme) }}
                aria-hidden="true"
              >
                A
              </span>
              <span className="folio-dropdown__label">{DARK_SCHEME_LABELS[scheme]}</span>
              {darkScheme === scheme && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
