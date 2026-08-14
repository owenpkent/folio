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
      /**
       * A second line under the label, for showing exactly what an item will
       * act on. The copy-address rows use it so the target is visible before it
       * is copied, which matters when a document's link points somewhere its
       * visible text does not admit to.
       */
      detail?: string;
      onSelect: () => void;
    };

const run = (id: string) => commandRegistry.execute(id);

/**
 * Copy text to the clipboard, falling back to execCommand for older webviews.
 * `what` names the thing in the announcement, since the menu now copies
 * addresses as well as the selection.
 */
async function copyText(text: string, what = 'selection'): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    announce(`Copied ${what}`);
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
  announce(ok ? `Copied ${what}` : 'Copy failed');
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
  const target = useContextMenu((s) => s.target);
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
    // Only present when the right-click landed on one, so the menu stays the
    // length it was everywhere else. Guarded on a non-empty value too: an
    // address that resolved to nothing worth copying would otherwise show a
    // row that silently does nothing and announces nothing when activated.
    ...(target?.value
      ? [
          {
            kind: 'item' as const,
            label: target.kind === 'email' ? 'Copy email address' : 'Copy link address',
            icon: 'copy' as IconName,
            // The target is shown rather than trusted: a document's link is
            // free to point somewhere its visible text does not admit to, and
            // this is the moment the user can see the difference.
            detail: target.value,
            onSelect: () =>
              void copyText(
                target.value,
                target.kind === 'email' ? 'email address' : 'link address',
              ),
          },
        ]
      : []),
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
      label: 'Add check mark',
      icon: 'check',
      disabled: !hasDoc,
      onSelect: () => run('edit.addCheckmark'),
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
      label: 'Save',
      icon: 'save',
      disabled: !hasDoc,
      onSelect: () => run('file.save'),
    },
    {
      kind: 'item',
      label: 'Save a copy',
      icon: 'download',
      disabled: !hasDoc,
      onSelect: () => run('file.saveAs'),
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
              // The detail line describes what the row acts on; it is not part
              // of the row's name. Left in the label's text content, it would
              // fold into the accessible name computed from that content, so a
              // screen reader would read the full address as the NAME on every
              // focus move rather than as a description of the action. It is
              // still AT-reachable -- aria-describedby reads a referenced
              // node's text even while that node is itself aria-hidden below.
              aria-describedby={entry.detail ? `folio-context-menu-detail-${i}` : undefined}
              // Preserve the text selection: a plain mousedown moves focus and
              // collapses it before Highlight/Comment can read it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => activate(entry)}
            >
              <span className="folio-context-menu__icon">
                {entry.icon && <Icon name={entry.icon} size={16} />}
              </span>
              <span className="folio-context-menu__label">
                {entry.label}
                {entry.detail && (
                  <span
                    id={`folio-context-menu-detail-${i}`}
                    className="folio-context-menu__detail"
                    title={entry.detail}
                    aria-hidden="true"
                  >
                    {entry.detail}
                  </span>
                )}
              </span>
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
