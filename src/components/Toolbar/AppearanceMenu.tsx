import { useEffect, useId, useRef, useState } from 'react';

import { announce } from '@/a11y/announcer';
import { Icon, IconButton } from '@/components/common';
import type { IconName } from '@/components/common';
import {
  DARK_SCHEME_LABELS,
  DARK_SCHEME_TINT,
  THEME_LABELS,
  useThemeStore,
  type DarkScheme,
  type UiTheme,
} from '@/theme/themeStore';

const SCHEMES: DarkScheme[] = ['night', 'green', 'amber'];

// Icons are this menu's own business; the names come from the shared table so
// the row, the trigger's label, and the announcement all say the same word.
const MODES: { value: UiTheme; icon: IconName }[] = [
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
  { value: 'system', icon: 'contrast' },
];

const inkColor = (scheme: DarkScheme): string => {
  const tint = DARK_SCHEME_TINT[scheme];
  return tint ? `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})` : '#ffffff';
};

/**
 * The single viewing-mode control: light/dark/system plus the dark reading
 * colour, in one menu. These used to be two adjacent toolbar buttons (a
 * light/dark toggle and a separate scheme dropdown), which made the toggle the
 * only way to reach `system`: it wasn't reachable at all.
 */
export function AppearanceMenu() {
  const theme = useThemeStore((s) => s.theme);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const darkScheme = useThemeStore((s) => s.darkScheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setDarkScheme = useThemeStore((s) => s.setDarkScheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The two captions name their own radio set through aria-labelledby, so the
  // ids have to be unique per instance rather than hard-coded.
  const modeGroupId = useId();
  const schemeGroupId = useId();

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

  const modeLabel = THEME_LABELS[theme];

  return (
    <div className="folio-dropdown" ref={ref}>
      <IconButton
        // The trigger reports the mode in effect rather than the one a click
        // would switch to: it opens a menu now, so it is a state, not a verb.
        // Ctrl/Cmd + Shift + L still flips light/dark without opening anything,
        // so the hint stays on the control that owns appearance in the bar.
        icon={resolvedTheme === 'dark' ? 'moon' : 'sun'}
        label={`Appearance: ${modeLabel} (Ctrl/Cmd + Shift + L toggles light / dark)`}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        // IconButton emits aria-pressed from `active`, which would announce a
        // menu trigger as a toggle button whose pressed state tracks whether
        // the popup is showing. aria-expanded already says that, so drop it
        // here (rest wins over IconButton's own attribute) and keep `active`
        // purely for the pressed-looking styling.
        aria-pressed={undefined}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="folio-dropdown__menu" role="menu" aria-label="Appearance">
          {/* Two independent radio sets in one menu: without the groups a
              screen reader reads all six rows as a single set, with two of
              them checked at once (a mode and a colour). */}
          <div role="group" aria-labelledby={modeGroupId}>
            <div className="folio-dropdown__group-label" id={modeGroupId}>
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
                  // Picking a mode used to run theme.toggle, which announced for
                  // itself; setting the store directly has to say so too. It is
                  // the chosen mode rather than the resolved one, since `system`
                  // resolves from the media query a tick later.
                  announce(`Viewing mode ${THEME_LABELS[mode.value]}`);
                  setOpen(false);
                }}
              >
                <Icon name={mode.icon} size={16} />
                <span className="folio-dropdown__label">{THEME_LABELS[mode.value]}</span>
                {theme === mode.value && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>

          <div className="folio-dropdown__sep" role="separator" />

          <div role="group" aria-labelledby={schemeGroupId}>
            <div className="folio-dropdown__group-label" id={schemeGroupId}>
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
                  announce(`Dark reading color ${DARK_SCHEME_LABELS[scheme]}`);
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
        </div>
      )}
    </div>
  );
}
