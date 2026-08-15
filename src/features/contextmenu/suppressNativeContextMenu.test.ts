import { afterEach, describe, expect, it } from 'vitest';

import { suppressNativeContextMenu } from './suppressNativeContextMenu';

/** Toggle the marker `isTauri()` checks for (jsdom has no Tauri shell). */
function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Render a fixture and hand back the element marked as the right-click target. */
function mount(html: string): Element {
  document.body.innerHTML = html;
  const el = document.body.querySelector('[data-target]');
  if (!el) throw new Error('fixture has no [data-target]');
  return el;
}

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('suppressNativeContextMenu', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    setTauri(false);
    document.body.innerHTML = '';
  });

  it('suppresses the webview menu on the chrome around the document', () => {
    // The sidebar, the toolbar, the splash screen: right-clicking any of them
    // used to bring up Back / Reload / Save as / Inspect, which is the browser
    // Folio runs inside showing through the application.
    setTauri(true);
    stop = suppressNativeContextMenu();

    const button = mount(
      '<div class="folio-thumbnails-panel"><button data-target>Combine</button></div>',
    );

    expect(rightClick(button).defaultPrevented).toBe(true);
  });

  it('leaves text fields their own menu, so cut, copy, and paste survive', () => {
    setTauri(true);
    stop = suppressNativeContextMenu();

    for (const html of [
      '<input data-target />',
      '<textarea data-target></textarea>',
      // Nested, because the right-click lands on whatever is inside the field.
      '<div contenteditable="true"><span data-target>note</span></div>',
      '<div data-context-native><span data-target>opted out</span></div>',
    ]) {
      expect(rightClick(mount(html)).defaultPrevented).toBe(false);
    }
  });

  it('leaves an event the document has already claimed alone', () => {
    // PdfViewer prevents the default before opening Folio's own menu; this must
    // not treat that as its own doing, nor undo it.
    setTauri(true);
    stop = suppressNativeContextMenu();
    const el = mount('<div class="folio-page"><span data-target>page text</span></div>');
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    expect(rightClick(el).defaultPrevented).toBe(true);
  });

  it('does nothing in the browser build', () => {
    // There the surrounding page really is a page in a tab, and its own menu is
    // the reader's, not Folio's to take away.
    setTauri(false);
    stop = suppressNativeContextMenu();

    expect(rightClick(mount('<button data-target>Combine</button>')).defaultPrevented).toBe(false);
  });

  it('stops suppressing once detached', () => {
    setTauri(true);
    suppressNativeContextMenu()();

    expect(rightClick(mount('<button data-target>Combine</button>')).defaultPrevented).toBe(false);
  });
});
