import { useEffect } from 'react';

import { commandRegistry } from '@/commands';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Canonical chord string for a keyboard event, e.g. "Mod+Shift+f". */
function eventToChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/** Normalize a declared binding ("Cmd+O", "Mod+Shift+L") into chord form. */
function normalizeBinding(binding: string): string {
  const mods = new Set<string>();
  let key = '';
  for (const raw of binding.split('+')) {
    const part = raw.trim();
    if (part === 'Mod' || part === 'Ctrl' || part === 'Cmd' || part === 'Meta') mods.add('Mod');
    else if (part === 'Alt' || part === 'Option') mods.add('Alt');
    else if (part === 'Shift') mods.add('Shift');
    else key = part.length === 1 ? part.toLowerCase() : part;
  }
  const ordered: string[] = [];
  if (mods.has('Mod')) ordered.push('Mod');
  if (mods.has('Alt')) ordered.push('Alt');
  if (mods.has('Shift')) ordered.push('Shift');
  ordered.push(key);
  return ordered.join('+');
}

/**
 * Keys whose commands are meant to fire again while the key is held: scrolling
 * and paging through a document. Every other command is a one-shot action, and
 * OS key repeat on a held chord dispatches it about thirty times a second.
 */
const REPEATABLE_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/**
 * Chords that keep working while the caret is in a text field, in normalized
 * form. Print is here because falling through to the browser's own Ctrl+P
 * prints the app's DOM instead of the document, which is never what the
 * shortcut means in a PDF viewer: clicking the page-number or find box and
 * pressing Ctrl+P used to do exactly that. Escape is handled separately.
 */
const CHORDS_ACTIVE_WHILE_TYPING = new Set(['Mod+p']);

/**
 * Global keyboard handler that dispatches to the command registry. Bindings are
 * declared on commands, so plugins that register a command with a keybinding get
 * a shortcut for free. Typing in inputs is never hijacked (except Escape and the
 * chords in CHORDS_ACTIVE_WHILE_TYPING).
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const chord = eventToChord(e);
      const editable = isEditableTarget(e.target);

      for (const command of commandRegistry.all()) {
        if (!command.keybinding) continue;
        const binding = normalizeBinding(command.keybinding);
        if (binding !== chord) continue;
        // Don't steal keystrokes while the user is typing, apart from Escape and
        // the few chords that mean the same thing wherever the caret is.
        if (editable && e.key !== 'Escape' && !CHORDS_ACTIVE_WHILE_TYPING.has(binding)) return;
        if (command.when && !command.when()) continue;
        // Swallow a held key rather than letting it fall through: the browser
        // acting on a repeated Ctrl+P is the native dialog we are replacing.
        if (e.repeat && !REPEATABLE_KEYS.has(e.key)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        void commandRegistry.execute(command.id);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
