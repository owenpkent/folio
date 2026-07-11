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
 * Global keyboard handler that dispatches to the command registry. Bindings are
 * declared on commands, so plugins that register a command with a keybinding get
 * a shortcut for free. Typing in inputs is never hijacked (except Escape).
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const chord = eventToChord(e);
      const editable = isEditableTarget(e.target);

      for (const command of commandRegistry.all()) {
        if (!command.keybinding) continue;
        if (normalizeBinding(command.keybinding) !== chord) continue;
        // Don't steal keystrokes while the user is typing, apart from Escape.
        if (editable && e.key !== 'Escape') return;
        if (command.when && !command.when()) continue;
        e.preventDefault();
        void commandRegistry.execute(command.id);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
