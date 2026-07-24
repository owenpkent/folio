import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { commandRegistry } from '@/commands';
import { Icon, IconButton, type IconName } from '@/components/common';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useContributionStore } from '@/plugins';
import { isTauri } from '@/core/document/openDocument';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';
import { NARROW_VIEWPORT_QUERY } from '@/theme/breakpoints';
import {
  DARK_SCHEME_LABELS,
  DARK_SCHEME_TINT,
  useThemeStore,
  type DarkScheme,
} from '@/theme/themeStore';

/* ---------------------------------------------------------------------------
 * Menu model
 *
 * The bar is data-driven: each top-level entry is a label plus a flat list of
 * rows, and the same list feeds both the desktop menu bar (one dropdown per
 * top-level label) and the narrow-viewport hamburger (all of them flattened
 * into one scrollable dropdown, grouped by heading). Everything executes
 * through the command registry, exactly like the toolbar buttons do.
 * ------------------------------------------------------------------------- */

type MenuItemRole = 'menuitemcheckbox' | 'menuitemradio';

interface MenuItemDef {
  kind: 'item';
  /** Stable key; the owning command id where one exists. */
  id: string;
  label: string;
  icon?: IconName;
  /** Renders the dark-scheme color swatch instead of `icon` (Night/Green/Amber). */
  swatch?: DarkScheme;
  /** Omitted for a plain menuitem; set for the checkable rows. */
  role?: MenuItemRole;
  checked?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /** Preserve the page text selection on click (Comment / Highlight need it). */
  preserveSelection?: boolean;
  onSelect: () => void;
}

interface MenuSeparatorDef {
  kind: 'separator';
  id: string;
}

type MenuEntryDef = MenuItemDef | MenuSeparatorDef;

interface TopMenuDef {
  id: string;
  label: string;
  entries: MenuEntryDef[];
}

const DARK_SCHEMES: DarkScheme[] = ['night', 'green', 'amber'];

const run = (id: string) => commandRegistry.execute(id);

/** The dark-scheme swatch's ink color, derived from the same tint table the
    renderer and DarkSchemeMenu use so the app's two scheme pickers can never
    drift apart. Night has no tint and shows plain white ink. */
function inkColor(scheme: DarkScheme): string {
  const tint = DARK_SCHEME_TINT[scheme];
  return tint ? `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})` : '#ffffff';
}

/** Render a declared "Mod+Shift+X" binding the way the toolbar's own tooltips
    already do, e.g. "Ctrl/Cmd + Shift + S". */
function formatShortcut(keybinding: string | undefined): string | undefined {
  if (!keybinding) return undefined;
  return keybinding
    .split('+')
    .map((part) => {
      if (part === 'Mod') return 'Ctrl/Cmd';
      if (part === 'Shift' || part === 'Alt') return part;
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' + ');
}

/** A command's own shortcut label, if it declares one. Sourced from the
    registry rather than hand-typed, so the menu never drifts from the actual
    binding a command declares. */
function shortcutFor(commandId: string): string | undefined {
  return formatShortcut(commandRegistry.get(commandId)?.keybinding);
}

/** Whether a command can run right now: its own guard if it declares one,
    mirroring the check commandRegistry.execute performs before running it.
    Used for the Tools menu, which is sourced from arbitrary plugin commands
    rather than the fixed set below (those disable from `hasDoc` directly, the
    same signal the toolbar buttons already use). */
function commandEnabled(commandId: string): boolean {
  const command = commandRegistry.get(commandId);
  return !command?.when || command.when();
}

function firstEnabledIndex(entries: MenuEntryDef[]): number {
  return entries.findIndex((e) => e.kind === 'item' && !e.disabled);
}

function lastEnabledIndex(entries: MenuEntryDef[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'item' && !e.disabled) return i;
  }
  return -1;
}

/** Next focusable row from `from` in `dir` (1 or -1), wrapping, skipping
    separators and disabled items. -1 if nothing in the menu can take focus. */
function stepEnabledIndex(entries: MenuEntryDef[], from: number, dir: 1 | -1): number {
  const n = entries.length;
  for (let step = 1; step <= n; step++) {
    const idx = (((from + dir * step) % n) + n) % n;
    const e = entries[idx];
    if (e.kind === 'item' && !e.disabled) return idx;
  }
  return -1;
}

/** The application menu bar: File / Edit / View / Annotate / Sign / Tools /
    Help, rendered above the toolbar. Pure DOM (no native menus), so it works
    identically in the Tauri shell, the browser build, and the VS Code webview. */
export function MenuBar() {
  const hasDoc = useDocumentStore((s) => s.status === 'ready');
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const handMode = useViewerStore((s) => s.handMode);
  const autoScroll = useViewerStore((s) => s.autoScroll);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const darkScheme = useThemeStore((s) => s.darkScheme);
  const setDarkScheme = useThemeStore((s) => s.setDarkScheme);
  const toolbarItems = useContributionStore((s) => s.toolbarItems);
  const isMobile = useMediaQuery(NARROW_VIEWPORT_QUERY);

  // A row backed by a command that requires an open document, e.g. Save.
  const docItem = (commandId: string, label: string, icon: IconName): MenuItemDef => ({
    kind: 'item',
    id: commandId,
    label,
    icon,
    disabled: !hasDoc,
    shortcut: shortcutFor(commandId),
    onSelect: () => run(commandId),
  });

  // A row backed by a command that works with no document open, e.g. Open.
  const freeItem = (commandId: string, label: string, icon?: IconName): MenuItemDef => ({
    kind: 'item',
    id: commandId,
    label,
    icon,
    shortcut: shortcutFor(commandId),
    onSelect: () => run(commandId),
  });

  const checkItem = (
    commandId: string,
    label: string,
    icon: IconName,
    checked: boolean,
    requiresDoc: boolean,
  ): MenuItemDef => ({
    kind: 'item',
    id: commandId,
    label,
    icon,
    role: 'menuitemcheckbox',
    checked,
    disabled: requiresDoc ? !hasDoc : false,
    shortcut: shortcutFor(commandId),
    onSelect: () => run(commandId),
  });

  const sep = (id: string): MenuSeparatorDef => ({ kind: 'separator', id });

  // The Tools menu is entirely plugin-contributed (Word Count today); its
  // enabled state comes from each command's own guard rather than `hasDoc`
  // directly, since a future plugin's command may have a different guard.
  const toolsEntries: MenuItemDef[] = toolbarItems.map(
    (item): MenuItemDef => ({
      kind: 'item',
      id: item.id,
      label: item.title,
      icon: (item.icon as IconName) ?? 'note',
      disabled: !commandEnabled(item.commandId),
      shortcut: shortcutFor(item.commandId),
      onSelect: () => run(item.commandId),
    }),
  );

  const menus: TopMenuDef[] = [
    {
      id: 'file',
      label: 'File',
      entries: [
        freeItem('file.open', 'Open', 'folder-open'),
        sep('file-sep-1'),
        docItem('file.save', 'Save', 'save'),
        docItem('file.saveAs', 'Save a copy', 'download'),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      entries: [
        docItem('textedit.toggle', 'Edit text', 'pencil'),
        docItem('edit.addText', 'Add text box', 'type'),
        docItem('edit.addImage', 'Add image', 'image'),
        docItem('ocr.recognizeDocument', 'Recognize text (OCR)', 'scan'),
        sep('edit-sep-1'),
        docItem('search.toggle', 'Find', 'search'),
      ],
    },
    {
      id: 'view',
      label: 'View',
      entries: [
        docItem('view.zoomIn', 'Zoom in', 'zoom-in'),
        docItem('view.zoomOut', 'Zoom out', 'zoom-out'),
        sep('view-sep-1'),
        docItem('view.fitWidth', 'Fit width', 'fit-width'),
        docItem('view.fitPage', 'Fit page', 'fit-page'),
        sep('view-sep-2'),
        checkItem('view.toggleHandMode', 'Hand tool', 'hand', handMode, true),
        checkItem('view.toggleAutoScroll', 'Auto-scroll', 'auto-scroll', autoScroll, true),
        sep('view-sep-3'),
        checkItem('view.toggleSidebar', 'Sidebar', 'sidebar', sidebarOpen, false),
        sep('view-sep-4'),
        {
          kind: 'item',
          id: 'theme.toggle',
          label: 'Toggle light / dark',
          icon: resolvedTheme === 'dark' ? 'sun' : 'moon',
          shortcut: shortcutFor('theme.toggle'),
          onSelect: () => run('theme.toggle'),
        },
        ...DARK_SCHEMES.map(
          (scheme): MenuItemDef => ({
            kind: 'item',
            id: `view.darkScheme.${scheme}`,
            label: DARK_SCHEME_LABELS[scheme],
            swatch: scheme,
            role: 'menuitemradio',
            checked: darkScheme === scheme,
            onSelect: () => setDarkScheme(scheme),
          }),
        ),
      ],
    },
    {
      id: 'annotate',
      label: 'Annotate',
      entries: [
        // Both read the live text selection on click; see the mousedown
        // preventDefault on menu items and triggers below, without which the
        // click that reaches them would collapse the selection first.
        { ...docItem('annotate.addNote', 'Add comment', 'comment'), preserveSelection: true },
        { ...docItem('annotate.highlight', 'Highlight', 'highlighter'), preserveSelection: true },
      ],
    },
    {
      id: 'sign',
      label: 'Sign',
      entries: [
        docItem('sign.addSignature', 'Add signature', 'signature'),
        docItem('sign.digitallySign', 'Digitally sign', 'shield'),
      ],
    },
    // Hidden entirely rather than shown empty: with no plugin contributing a
    // toolbar item there is nothing for it to hold.
    ...(toolsEntries.length > 0 ? [{ id: 'tools', label: 'Tools', entries: toolsEntries }] : []),
    {
      id: 'help',
      label: 'Help',
      entries: [
        freeItem('help.about', 'About Folio', 'info'),
        // Desktop only: the browser build has no Tauri shell to update.
        ...(isTauri() ? [freeItem('help.checkForUpdates', 'Check for updates')] : []),
      ],
    },
  ];

  /* -------------------------------------------------------------------------
   * Desktop: ARIA APG menu bar pattern (menubar / menuitem, roving tabindex).
   * ---------------------------------------------------------------------- */

  const [openId, setOpenId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>('file');
  const [mobileOpen, setMobileOpen] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Which item to focus once the menu that is about to open has mounted (its
  // items do not exist yet on the tick that opens it).
  const pendingFocusRef = useRef<'first' | 'last' | null>(null);
  // Read inside the layout effect below without adding `menus` (a fresh array
  // every render) to its dependency list.
  const menusRef = useRef(menus);
  menusRef.current = menus;

  // Click outside the bar closes whichever menu is open.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenId(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [openId]);

  // Once a freshly opened menu's rows exist in the DOM, apply the focus move
  // that opened it (first row for ArrowDown/Enter, last for ArrowUp).
  useLayoutEffect(() => {
    const focus = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!openId || !focus) return;
    const menu = menusRef.current.find((m) => m.id === openId);
    if (!menu) return;
    const idx = focus === 'first' ? firstEnabledIndex(menu.entries) : lastEnabledIndex(menu.entries);
    if (idx !== -1) itemRefs.current[idx]?.focus();
  }, [openId]);

  // The mobile hamburger's single dropdown: same outside-click / Escape
  // handling as ToolbarOverflow's "More tools" menu.
  useEffect(() => {
    if (!mobileOpen) return;
    const onDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMobileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen]);

  const focusTrigger = (id: string) => triggerRefs.current.get(id)?.focus();

  /** Open `id`'s menu and focus its first/last enabled row. If it is already
      open (focus can still be on the trigger right after a click), its rows
      already exist, so focus is applied immediately; otherwise the layout
      effect above applies it once the rows mount. */
  const openMenuAndFocus = (id: string, focus: 'first' | 'last') => {
    setActiveId(id);
    if (openId === id) {
      const menu = menus.find((m) => m.id === id);
      const idx = menu
        ? focus === 'first'
          ? firstEnabledIndex(menu.entries)
          : lastEnabledIndex(menu.entries)
        : -1;
      if (idx !== -1) itemRefs.current[idx]?.focus();
      return;
    }
    pendingFocusRef.current = focus;
    setOpenId(id);
  };

  /** Move the roving tab stop to `id`'s trigger. If a menu was already open,
      the open menu follows the moving focus (closing the old one, opening the
      new one) while focus itself stays on the trigger row, not its items —
      the "arrow across the bar while previewing each menu" behavior. */
  const moveTrigger = (id: string) => {
    setActiveId(id);
    focusTrigger(id);
    if (openId) {
      pendingFocusRef.current = null;
      setOpenId(id);
    }
  };

  const activateEntry = (entry: MenuItemDef, triggerId: string) => {
    setOpenId(null);
    entry.onSelect();
    focusTrigger(triggerId);
  };

  const onTriggerClick = (id: string) => {
    setActiveId(id);
    // Focus is applied here explicitly because the trigger's mousedown is
    // preventDefault-ed (see below), so the browser never focuses it itself.
    focusTrigger(id);
    if (openId === id) {
      setOpenId(null);
    } else {
      pendingFocusRef.current = null;
      setOpenId(id);
    }
  };

  // While any menu is open, hovering a different trigger slides the open menu
  // across to it (click-then-slide), matching a native app menu bar.
  const onTriggerMouseEnter = (id: string) => {
    if (openId && openId !== id) {
      pendingFocusRef.current = null;
      setActiveId(id);
      setOpenId(id);
      focusTrigger(id);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = menus.length;
    const menu = menus[index];
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        moveTrigger(menus[(index + 1) % count].id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveTrigger(menus[(index - 1 + count) % count].id);
        break;
      case 'Home':
        e.preventDefault();
        moveTrigger(menus[0].id);
        break;
      case 'End':
        e.preventDefault();
        moveTrigger(menus[count - 1].id);
        break;
      case 'ArrowDown':
        e.preventDefault();
        openMenuAndFocus(menu.id, 'first');
        break;
      case 'ArrowUp':
        e.preventDefault();
        openMenuAndFocus(menu.id, 'last');
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        openMenuAndFocus(menu.id, 'first');
        break;
      case 'Escape':
        if (openId === menu.id) {
          e.preventDefault();
          setOpenId(null);
        }
        break;
      case 'Tab':
        if (openId) setOpenId(null);
        break;
      default:
        break;
    }
  };

  const onItemKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    menu: TopMenuDef,
    menuIndex: number,
    entryIndex: number,
  ) => {
    const { entries } = menu;
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const idx = stepEnabledIndex(entries, entryIndex, 1);
        if (idx !== -1) itemRefs.current[idx]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const idx = stepEnabledIndex(entries, entryIndex, -1);
        if (idx !== -1) itemRefs.current[idx]?.focus();
        break;
      }
      case 'Home': {
        e.preventDefault();
        const idx = firstEnabledIndex(entries);
        if (idx !== -1) itemRefs.current[idx]?.focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        const idx = lastEnabledIndex(entries);
        if (idx !== -1) itemRefs.current[idx]?.focus();
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        const next = menus[(menuIndex + 1) % menus.length];
        openMenuAndFocus(next.id, 'first');
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const prev = menus[(menuIndex - 1 + menus.length) % menus.length];
        openMenuAndFocus(prev.id, 'first');
        break;
      }
      case 'Escape':
        e.preventDefault();
        setOpenId(null);
        focusTrigger(menu.id);
        break;
      case 'Tab':
        // Let focus leave the widget naturally; just don't leave a stray menu open.
        setOpenId(null);
        break;
      default:
        break;
    }
  };

  const renderGlyph = (entry: MenuItemDef) => (
    <span className="folio-menubar__menuitem-icon">
      {entry.swatch ? (
        <span className="folio-swatch" style={{ color: inkColor(entry.swatch) }} aria-hidden="true">
          A
        </span>
      ) : (
        entry.icon && <Icon name={entry.icon} size={16} />
      )}
    </span>
  );

  /* -------------------------------------------------------------------------
   * Mobile (≤640px): one hamburger button, one flat dropdown grouped by menu.
   * ---------------------------------------------------------------------- */
  if (isMobile) {
    return (
      <div className="folio-menubar folio-menubar--mobile" ref={barRef}>
        <div className="folio-dropdown">
          <IconButton
            icon="menu"
            label="Menu"
            active={mobileOpen}
            aria-haspopup="menu"
            aria-expanded={mobileOpen}
            // The hamburger is the only route to Comment / Highlight on
            // narrow viewports; keep the text selection alive on the way in.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMobileOpen((o) => !o)}
          />
          {mobileOpen && (
            <div
              className="folio-dropdown__menu folio-menubar__mobile-menu"
              role="menu"
              aria-label="Menu"
            >
              {menus.map((menu) => (
                <div key={menu.id} role="group" aria-label={menu.label} className="folio-menubar__mobile-group">
                  <div className="folio-menubar__mobile-heading" aria-hidden="true">
                    {menu.label}
                  </div>
                  {menu.entries
                    .filter((entry): entry is MenuItemDef => entry.kind === 'item')
                    .map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role={entry.role ?? 'menuitem'}
                        aria-checked={entry.role ? entry.checked : undefined}
                        className="folio-dropdown__item"
                        disabled={entry.disabled}
                        onMouseDown={
                          entry.preserveSelection ? (e) => e.preventDefault() : undefined
                        }
                        onClick={() => {
                          setMobileOpen(false);
                          entry.onSelect();
                        }}
                      >
                        {renderGlyph(entry)}
                        <span className="folio-dropdown__label">{entry.label}</span>
                        {entry.shortcut && (
                          <span className="folio-menubar__mobile-shortcut" aria-hidden="true">
                            {entry.shortcut}
                          </span>
                        )}
                        {entry.checked && <Icon name="check" size={16} />}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------------------
   * Desktop: the full seven-menu bar.
   * ---------------------------------------------------------------------- */
  return (
    <div className="folio-menubar" role="menubar" aria-label="Application menu" ref={barRef}>
      {menus.map((menu, menuIndex) => {
        const isOpen = openId === menu.id;
        return (
          <div className="folio-menubar__item" key={menu.id}>
            <button
              type="button"
              role="menuitem"
              className="folio-menubar__trigger"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              tabIndex={activeId === menu.id ? 0 : -1}
              ref={(el) => {
                if (el) triggerRefs.current.set(menu.id, el);
                else triggerRefs.current.delete(menu.id);
              }}
              // Like a native menu bar, opening a menu must not disturb the
              // page text selection: Annotate's Comment / Highlight act on it,
              // and a plain button mousedown would collapse it before the
              // click lands. Focus moves via onTriggerClick instead.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onTriggerClick(menu.id)}
              onKeyDown={(e) => onTriggerKeyDown(e, menuIndex)}
              onMouseEnter={() => onTriggerMouseEnter(menu.id)}
            >
              {menu.label}
            </button>
            {isOpen && (
              <div className="folio-menubar__menu" role="menu" aria-label={menu.label}>
                {menu.entries.map((entry, entryIndex) =>
                  entry.kind === 'separator' ? (
                    <div key={entry.id} role="separator" className="folio-menubar__sep" />
                  ) : (
                    <button
                      key={entry.id}
                      type="button"
                      role={entry.role ?? 'menuitem'}
                      aria-checked={entry.role ? entry.checked : undefined}
                      className="folio-menubar__menuitem"
                      disabled={entry.disabled}
                      ref={(el) => {
                        itemRefs.current[entryIndex] = el;
                      }}
                      onMouseDown={entry.preserveSelection ? (e) => e.preventDefault() : undefined}
                      onClick={() => activateEntry(entry, menu.id)}
                      onKeyDown={(e) => onItemKeyDown(e, menu, menuIndex, entryIndex)}
                    >
                      {renderGlyph(entry)}
                      <span className="folio-menubar__menuitem-label">{entry.label}</span>
                      {entry.shortcut && (
                        <span className="folio-menubar__menuitem-shortcut" aria-hidden="true">
                          {entry.shortcut}
                        </span>
                      )}
                      {entry.checked && (
                        <span className="folio-menubar__menuitem-check">
                          <Icon name="check" size={16} />
                        </span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
