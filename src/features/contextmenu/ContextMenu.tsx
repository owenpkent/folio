import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { Icon, type IconName } from '@/components/common';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { useContextMenu } from './store';

type MenuEntry =
  | { kind: 'separator' }
  | {
      kind: 'item';
      label: string;
      icon?: IconName;
      checked?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

const run = (id: string) => commandRegistry.execute(id);

/** Copy text to the clipboard, falling back to execCommand for older webviews. */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied selection');
    return;
  } catch {
    /* fall through to the legacy execCommand path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    /* nothing more we can do */
  }
  document.body.removeChild(ta);
  announce(ok ? 'Copied selection' : 'Copy failed');
}

/**
 * Acrobat-style right-click menu: switch Select/Hand tools, copy the selection,
 * and reach the annotate / edit / sign actions without hunting the toolbar.
 */
export function ContextMenu() {
  const open = useContextMenu((s) => s.open);
  const x = useContextMenu((s) => s.x);
  const y = useContextMenu((s) => s.y);
  const selectionText = useContextMenu((s) => s.selectionText);
  const close = useContextMenu((s) => s.closeMenu);

  const handMode = useViewerStore((s) => s.handMode);
  const setHandMode = useViewerStore((s) => s.setHandMode);
  const hasDoc = useDocumentStore((s) => s.status === 'ready');

  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu on-screen: clamp against its measured size once rendered.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    // Close if the window loses focus or is scrolled underneath the menu.
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (!open) return null;

  const hasSelection = selectionText.trim().length > 0;

  const entries: MenuEntry[] = [
    {
      kind: 'item',
      label: 'Select tool',
      icon: 'cursor',
      checked: !handMode,
      onSelect: () => setHandMode(false),
    },
    {
      kind: 'item',
      label: 'Hand tool',
      icon: 'hand',
      checked: handMode,
      onSelect: () => setHandMode(true),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Copy',
      icon: 'copy',
      disabled: !hasSelection,
      onSelect: () => void copyText(selectionText),
    },
    {
      kind: 'item',
      label: 'Highlight',
      icon: 'highlighter',
      disabled: !hasSelection || !hasDoc,
      onSelect: () => run('annotate.highlight'),
    },
    {
      kind: 'item',
      label: 'Add comment',
      icon: 'comment',
      disabled: !hasDoc,
      onSelect: () => run('annotate.addNote'),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Add text box',
      icon: 'type',
      disabled: !hasDoc,
      onSelect: () => run('edit.addText'),
    },
    {
      kind: 'item',
      label: 'Add image',
      icon: 'image',
      disabled: !hasDoc,
      onSelect: () => run('edit.addImage'),
    },
    {
      kind: 'item',
      label: 'Add signature',
      icon: 'signature',
      disabled: !hasDoc,
      onSelect: () => run('sign.addSignature'),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Find',
      icon: 'search',
      disabled: !hasDoc,
      onSelect: () => run('search.toggle'),
    },
    {
      kind: 'item',
      label: 'Save a copy',
      icon: 'download',
      disabled: !hasDoc,
      onSelect: () => run('file.save'),
    },
  ];

  const activate = (entry: Extract<MenuEntry, { kind: 'item' }>) => {
    if (entry.disabled) return;
    close();
    entry.onSelect();
  };

  return (
    <>
      {/* Catches the click / right-click that dismisses the menu. */}
      <div
        className="folio-context-backdrop"
        onPointerDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={menuRef}
        className="folio-context-menu"
        role="menu"
        aria-label="Document actions"
        style={{ left: pos.x, top: pos.y }}
      >
        {entries.map((entry, i) =>
          entry.kind === 'separator' ? (
            <div key={`sep-${i}`} className="folio-context-menu__sep" role="separator" />
          ) : (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              className="folio-context-menu__item"
              disabled={entry.disabled}
              // Preserve the text selection: a plain mousedown moves focus and
              // collapses it before Highlight/Comment can read it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => activate(entry)}
            >
              <span className="folio-context-menu__icon">
                {entry.icon && <Icon name={entry.icon} size={16} />}
              </span>
              <span className="folio-context-menu__label">{entry.label}</span>
              {entry.checked && (
                <span className="folio-context-menu__check">
                  <Icon name="check" size={16} />
                </span>
              )}
            </button>
          ),
        )}
      </div>
    </>
  );
}
