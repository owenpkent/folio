import { useEffect, useRef, useState } from 'react';

import { Icon, IconButton } from '@/components/common';
import type { IconName } from '@/components/common';
import {
  DARK_SCHEME_LABELS,
  DARK_SCHEME_TINT,
  useThemeStore,
  type DarkScheme,
  type UiTheme,
} from '@/theme/themeStore';

const SCHEMES: DarkScheme[] = ['night', 'green', 'amber'];

const MODES: { value: UiTheme; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'Match system', icon: 'contrast' },
];

const inkColor = (scheme: DarkScheme): string => {
  const tint = DARK_SCHEME_TINT[scheme];
  return tint ? `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})` : '#ffffff';
};

/**
 * The single viewing-mode control: light/dark/system plus the dark reading
 * colour, in one menu. These used to be two adjacent toolbar buttons (a
 * light/dark toggle and a separate scheme dropdown), which made the toggle the
 * only way to reach `system` — it wasn't reachable at all.
 */
export function AppearanceMenu() {
  const theme = useThemeStore((s) => s.theme);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const darkScheme = useThemeStore((s) => s.darkScheme);
  const setTheme = useThemeStore((s) => s.setTheme);
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

  const modeLabel = MODES.find((m) => m.value === theme)?.label ?? 'Light';

  return (
    <div className="folio-dropdown" ref={ref}>
      <IconButton
        // The trigger reports the mode in effect rather than the one a click
        // would switch to: it opens a menu now, so it is a state, not a verb.
        icon={resolvedTheme === 'dark' ? 'moon' : 'sun'}
        label={`Appearance: ${modeLabel}`}
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="folio-dropdown__menu" role="menu" aria-label="Appearance">
          <div className="folio-dropdown__group-label" role="presentation">
            Viewing mode
          </div>
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === mode.value}
              className="folio-dropdown__item"
              onClick={() => {
                setTheme(mode.value);
                setOpen(false);
              }}
            >
              <Icon name={mode.icon} size={16} />
              <span className="folio-dropdown__label">{mode.label}</span>
              {theme === mode.value && <Icon name="check" size={16} />}
            </button>
          ))}

          <div className="folio-dropdown__sep" role="separator" />

          <div className="folio-dropdown__group-label" role="presentation">
            Dark reading color
          </div>
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
              <span className="folio-swatch" style={{ color: inkColor(scheme) }} aria-hidden="true">
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
