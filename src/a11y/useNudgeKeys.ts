import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

import { announce } from './announcer';

/**
 * Keyboard move and resize for a placed overlay item, so every overlay Folio
 * lets you drag can also be positioned without a pointer (WCAG 2.1.1).
 *
 * Dragging and the corner handle were the only way to move or resize a text
 * box, a placed image, a check mark, a signature, or an embedded image. Each
 * layer implements its own pointer gestures against the same normalized rect,
 * so the keyboard equivalent lives here once rather than five times.
 *
 * The bindings avoid every modifier the browser or OS already claims, notably
 * Alt+Arrow (back/forward in a browser build):
 *
 * | Key | Effect |
 * | --- | --- |
 * | Arrow | move one screen pixel |
 * | Shift + Arrow | move ten |
 * | `+` / `-` | grow / shrink by one screen pixel |
 * | Shift + `+` / `-` | grow / shrink by ten |
 * | Delete / Backspace | remove the item |
 *
 * Steps are screen pixels of the rendered page rather than PDF points, for the
 * same reason the drag handlers work that way: it is the space the user is
 * looking at, it stays predictable at any zoom, and zooming in is then how you
 * get finer control.
 */

export interface NudgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NudgeKeysOptions {
  /** The item's current rect, as fractions (0..1) of the page. */
  rect: NudgeRect;
  /** Names the item in announcements, e.g. "Text box". */
  label: string;
  /**
   * Apply a new rect. Called at most once per keystroke.
   *
   * Return `false` when the change was refused (a layer whose commit path is
   * blocked by another feature's in-flight document mutation does exactly
   * that); anything else, `undefined` included, counts as applied. This
   * matters because the announcement below is the only feedback a screen
   * reader user gets: a layer that silently declined the change while this
   * hook went on to announce a new position told them the item had moved when
   * it had not.
   */
  onChange(rect: NudgeRect): boolean | void;
  /** Remove the item, for Delete / Backspace. Omit to leave those keys alone.
   *  Reports a refusal the same way {@link NudgeKeysOptions.onChange} does. */
  onDelete?(): boolean | void;
  /**
   * Keep the displayed pixel aspect ratio constant while resizing, mirroring
   * each layer's own pointer resize: images, check marks, and signatures lock
   * it, text boxes do not.
   */
  aspectLocked?: boolean;
  /** Smallest normalized width/height, matching each layer's pointer-resize floor. */
  minWidth?: number;
  minHeight?: number;
}

/** Screen pixels moved or resized per keystroke, and with Shift held. */
const STEP_PX = 1;
const COARSE_STEP_PX = 10;

/**
 * How long after the last keystroke before the result is announced. A live
 * region firing on every key would flood a screen reader during a run of
 * presses and drown the value it is trying to convey; one announcement once the
 * user pauses says where the item actually ended up.
 */
const ANNOUNCE_DELAY_MS = 500;

const DEFAULT_MIN_WIDTH = 0.02;
const DEFAULT_MIN_HEIGHT = 0.01;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;

const GROW_KEYS = ['+', '='];
const SHRINK_KEYS = ['-', '_'];

/** The `.folio-page` box the item is positioned within, in CSS pixels. */
function pageBoxOf(el: Element): { width: number; height: number } | null {
  const rect = el.closest('.folio-page')?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

/**
 * A keydown handler for the focusable element that represents the item. It
 * deliberately ignores events bubbling up from descendants: see the target
 * check below.
 */
export function useNudgeKeys(options: NudgeKeysOptions): (e: KeyboardEvent<HTMLElement>) => void {
  // Everything is read through this ref, so the returned handler is stable
  // across the rect changing on every keystroke.
  const latest = useRef(options);
  latest.current = options;

  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (announceTimer.current) clearTimeout(announceTimer.current);
    },
    [],
  );

  const announceLater = useCallback((message: string) => {
    if (announceTimer.current) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => announce(message), ANNOUNCE_DELAY_MS);
  }, []);

  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      // Only when the wrapper itself holds focus. A text box's contentEditable
      // and every layer's delete button are descendants, and their keys must
      // stay theirs: arrows have to move the caret inside the editable, not the
      // box around it.
      if (e.target !== e.currentTarget) return;

      const {
        rect: current,
        label,
        onChange,
        onDelete,
        aspectLocked = false,
        minWidth = DEFAULT_MIN_WIDTH,
        minHeight = DEFAULT_MIN_HEIGHT,
      } = latest.current;

      /** Claim the key: a handled one must not also page the document. */
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!onDelete) return;
        claim();
        if (onDelete() === false) {
          announceLater(`${label} cannot be deleted right now`);
          return;
        }
        // Immediate, not deferred: the item is gone, so there is nothing left
        // for a later keystroke to coalesce with.
        announce(`${label} deleted`);
        return;
      }

      const isArrow = e.key.startsWith('Arrow');
      const grow = GROW_KEYS.includes(e.key);
      const shrink = SHRINK_KEYS.includes(e.key);
      if (!isArrow && !grow && !shrink) return;

      const page = pageBoxOf(e.currentTarget);
      if (!page) return;
      const step = e.shiftKey ? COARSE_STEP_PX : STEP_PX;
      const dxFrac = step / page.width;
      const dyFrac = step / page.height;

      if (isArrow) {
        const dx = e.key === 'ArrowLeft' ? -dxFrac : e.key === 'ArrowRight' ? dxFrac : 0;
        const dy = e.key === 'ArrowUp' ? -dyFrac : e.key === 'ArrowDown' ? dyFrac : 0;
        if (!dx && !dy) return; // some other Arrow* key

        const next = {
          ...current,
          x: clamp(current.x + dx, 0, 1 - current.width),
          y: clamp(current.y + dy, 0, 1 - current.height),
        };
        claim();
        if (next.x === current.x && next.y === current.y) {
          // Already flush against the edge it is being pushed toward. Say so
          // rather than reporting a move that did not happen.
          announceLater(`${label} is at the edge of the page`);
          return;
        }
        if (onChange(next) === false) {
          // Deferred like the success case, so a held arrow key against a
          // blocked layer produces one announcement rather than one per repeat.
          announceLater(`${label} cannot be moved right now`);
          return;
        }
        announceLater(`${label} moved to ${pct(next.x)} across, ${pct(next.y)} down the page`);
        return;
      }

      let width = clamp(current.width + (grow ? dxFrac : -dxFrac), minWidth, 1 - current.x);
      let height: number;
      // Whether either axis refused to move in the requested direction. A
      // resize is all-or-nothing rather than per-axis: letting the height carry
      // on shrinking after the width has bottomed out would silently reshape
      // the item, which is not what one keypress on `-` should mean.
      let blocked = width === current.width;

      if (aspectLocked) {
        // Same construction the pointer resizes use: hold the *displayed* pixel
        // aspect ratio, which is the rect's aspect scaled by the page's, so a
        // square on screen stays square.
        const aspect = (current.width * page.width) / (current.height * page.height || 1) || 1;
        height = (width * page.width) / aspect / page.height;
        if (current.y + height > 1) {
          height = 1 - current.y;
          width = (height * page.height * aspect) / page.width;
          blocked = width === current.width;
        }
      } else {
        height = clamp(current.height + (grow ? dyFrac : -dyFrac), minHeight, 1 - current.y);
        blocked = blocked || height === current.height;
      }

      claim();
      if (blocked) {
        announceLater(
          grow ? `${label} cannot grow any further on this page` : `${label} is at its smallest`,
        );
        return;
      }
      if (onChange({ ...current, width, height }) === false) {
        announceLater(`${label} cannot be resized right now`);
        return;
      }
      announceLater(`${label} resized to ${pct(width)} of the page width`);
    },
    [announceLater],
  );
}
