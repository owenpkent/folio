import { useEffect, useMemo, useRef, type PointerEvent } from 'react';

import { useNudgeKeys } from '@/a11y/useNudgeKeys';
import { Icon } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { useEditStore } from './store';
import {
  FONT_CSS,
  FONT_LABELS,
  MARK_GLYPH_PATHS,
  MARK_GLYPH_STROKE_WIDTH,
  type FontFamily,
  type ImageEdit,
  type MarkEdit,
  type TextEdit,
} from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const pageRectFrom = (el: Element | null) =>
  el?.closest('.folio-page')?.getBoundingClientRect() ?? null;

const FONT_FAMILIES: FontFamily[] = ['Helvetica', 'Times', 'Courier'];

/**
 * How far the pointer must travel before a press on a text box counts as a
 * drag rather than a click. Below it, the press places the caret / selects.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * Track a pointer drag on `window` until it ends, detaching either way.
 *
 * pointercancel matters as much as pointerup: an interrupted touch (a system
 * gesture taking over, the pointer leaving the window during a capture) fires
 * only the former, so listening for pointerup alone leaves the move listener
 * attached and the item still following the pointer until the next press.
 *
 * `onRelease` runs only on a genuine pointerup, never on a cancel: every drag
 * below moves the item through the store on each pointermove, so there is
 * nothing to commit at the end, and the one caller that passes it is deciding
 * whether the press was a click rather than a drag -- which an interrupted
 * gesture has not earned.
 */
function trackPointerDrag(
  onMove: (ev: globalThis.PointerEvent) => void,
  onRelease?: () => void,
): void {
  const detach = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', detach);
  };
  const release = () => {
    detach();
    onRelease?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', detach);
}

const MARK_GLYPH_LABEL: Record<MarkEdit['glyph'], string> = {
  check: 'Check mark',
  cross: 'Cross mark',
};

/** Overlay of placed text boxes, images, and check marks for a page. */
export function EditLayer({ pageNumber }: { pageNumber: number }) {
  const all = useEditStore((s) => s.edits);
  const items = useMemo(() => all.filter((e) => e.pageNumber === pageNumber), [all, pageNumber]);

  if (items.length === 0) return null;

  return (
    <div className="folio-edit-layer" data-pan-exclude>
      {items.map((item) => {
        if (item.kind === 'text') return <TextItem key={item.id} item={item} />;
        if (item.kind === 'mark') return <MarkItem key={item.id} item={item} />;
        return <ImageItem key={item.id} item={item} />;
      })}
    </div>
  );
}

/** Deselect the active item on outside-click or Escape (mounted only while selected). */
function useDeselectOnOutside(active: boolean): void {
  const select = useEditStore((s) => s.select);
  useEffect(() => {
    if (!active) return;
    const onDown = (ev: globalThis.PointerEvent) => {
      const t = ev.target as Element | null;
      if (!t?.closest?.('.folio-edit')) select(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') select(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, select]);
}

function positionStyle(rect: { x: number; y: number; width: number; height: number }) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function TextItem({ item }: { item: TextEdit }) {
  const scale = useViewerStore((s) => s.scale);
  const selectedId = useEditStore((s) => s.selectedId);
  const focusId = useEditStore((s) => s.focusId);
  const select = useEditStore((s) => s.select);
  const focus = useEditStore((s) => s.focus);
  const move = useEditStore((s) => s.move);
  const updateText = useEditStore((s) => s.updateText);
  const remove = useEditStore((s) => s.remove);
  const clearFocus = useEditStore((s) => s.clearFocus);
  const isSelected = selectedId === item.id;

  const editableRef = useRef<HTMLDivElement>(null);
  useDeselectOnOutside(isSelected);

  // Keep the (uncontrolled) contentEditable text in sync when not being typed in.
  useEffect(() => {
    const el = editableRef.current;
    if (el && document.activeElement !== el && el.textContent !== item.text) {
      el.textContent = item.text;
    }
  }, [item.text, isSelected]);

  // Focus a freshly-created box so the user can type immediately.
  useEffect(() => {
    if (focusId !== item.id) return;
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    clearFocus();
  }, [focusId, item.id, clearFocus]);

  const commit = () => {
    const el = editableRef.current;
    if (el) updateText(item.id, { text: el.textContent ?? '' });
  };

  // Not aspect-locked: a text box's width and height are independent, and its
  // floors mirror startResize's own clamps below.
  const onKeyDown = useNudgeKeys({
    rect: item.rect,
    label: 'Text box',
    minWidth: 0.05,
    minHeight: 0.02,
    onChange: (rect) => move(item.id, rect),
    onDelete: () => remove(item.id),
  });

  /**
   * Press anywhere on the box to move it: a press that travels turns into a
   * drag, one that does not is a plain click (select the box, or place the
   * caret if it was already selected). No grip to hunt for.
   */
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // The inspector and the handles have their own behavior.
    if (target.closest('.folio-edit__inspector, .folio-edit__delete, .folio-edit__resize')) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;

    const wasSelected = isSelected;
    select(item.id);
    // An unselected box is not editable, so nothing there needs the browser's
    // default press handling, and suppressing it avoids a text-selection drag.
    if (!wasSelected) e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...item.rect };
    let dragging = false;

    const onMove = (ev: globalThis.PointerEvent) => {
      const dxPx = ev.clientX - startX;
      const dyPx = ev.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        // Dragging out of the editable would otherwise select its text.
        editableRef.current?.blur();
        window.getSelection()?.removeAllRanges();
      }
      move(item.id, {
        ...start,
        x: clamp(start.x + dxPx / pageRect.width, 0, 1 - start.width),
        y: clamp(start.y + dyPx / pageRect.height, 0, 1 - start.height),
      });
    };
    trackPointerDrag(onMove, () => {
      // A click, not a drag: start typing. A box that was already selected
      // keeps the caret the browser just placed.
      if (!dragging && !wasSelected) focus(item.id);
    });
  };

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...item.rect };

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      const dy = (ev.clientY - startY) / pageRect.height;
      move(item.id, {
        ...start,
        width: clamp(start.width + dx, 0.05, 1 - start.x),
        height: clamp(start.height + dy, 0.02, 1 - start.y),
      });
    };
    trackPointerDrag(onMove);
  };

  return (
    <div
      className={`folio-edit folio-edit--text${isSelected ? ' is-selected' : ''}`}
      style={positionStyle(item.rect)}
      onPointerDown={startDrag}
      // Tab reaches the box, and focusing it selects it so the inspector opens
      // and the keys below have something to act on. The nudge handler ignores
      // events from descendants, so arrows inside the contentEditable still
      // move the caret rather than the box.
      tabIndex={0}
      role="group"
      aria-label="Text box. Arrow keys move it, plus and minus resize it, Delete removes it."
      onFocus={() => select(item.id)}
      onKeyDown={onKeyDown}
    >
      {isSelected && <TextInspector item={item} onChange={(patch) => updateText(item.id, patch)} />}
      <div
        ref={editableRef}
        className="folio-edit__text"
        contentEditable={isSelected}
        suppressContentEditableWarning
        role="textbox"
        aria-label="Text box"
        tabIndex={-1}
        onBlur={commit}
        style={{
          fontFamily: FONT_CSS[item.fontFamily],
          fontSize: `${item.fontSizePt * scale}px`,
          fontWeight: item.bold ? 700 : 400,
          color: item.colorHex,
        }}
      />
      {isSelected && (
        <>
          <button
            type="button"
            className="folio-edit__delete"
            aria-label="Delete text box"
            title="Delete text box"
            onClick={() => remove(item.id)}
          >
            <Icon name="x" size={13} />
          </button>
          <span
            className="folio-edit__resize"
            aria-hidden="true"
            title="Drag to resize"
            onPointerDown={startResize}
          />
        </>
      )}
    </div>
  );
}

function TextInspector({
  item,
  onChange,
}: {
  item: TextEdit;
  onChange: (patch: Partial<TextEdit>) => void;
}) {
  // Keep pointerdown inside the inspector from bubbling to the page/deselect.
  const stop = (e: PointerEvent) => e.stopPropagation();
  return (
    <div className="folio-edit__inspector" onPointerDown={stop}>
      <select
        aria-label="Font"
        title="Font"
        value={item.fontFamily}
        onChange={(e) => onChange({ fontFamily: e.target.value as FontFamily })}
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {FONT_LABELS[f]}
          </option>
        ))}
      </select>
      <input
        type="number"
        aria-label="Font size"
        title="Font size"
        className="folio-edit__size"
        min={6}
        max={96}
        value={item.fontSizePt}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange({ fontSizePt: clamp(n, 6, 96) });
        }}
      />
      <button
        type="button"
        className={`folio-edit__bold${item.bold ? ' is-on' : ''}`}
        aria-label="Bold"
        title="Bold"
        aria-pressed={item.bold}
        onClick={() => onChange({ bold: !item.bold })}
      >
        B
      </button>
      <input
        type="color"
        aria-label="Text color"
        title="Text color"
        value={item.colorHex}
        onChange={(e) => onChange({ colorHex: e.target.value })}
      />
    </div>
  );
}

function ImageItem({ item }: { item: ImageEdit }) {
  const selectedId = useEditStore((s) => s.selectedId);
  const select = useEditStore((s) => s.select);
  const move = useEditStore((s) => s.move);
  const remove = useEditStore((s) => s.remove);
  const isSelected = selectedId === item.id;
  useDeselectOnOutside(isSelected);

  // Aspect-locked, matching startResize below: a placed graphic squashed on one
  // axis is a defect, not a resize.
  const onKeyDown = useNudgeKeys({
    rect: item.rect,
    label: 'Placed image',
    aspectLocked: true,
    minWidth: 0.05,
    onChange: (rect) => move(item.id, rect),
    onDelete: () => remove(item.id),
  });

  const startDrag = (e: PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    select(item.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...item.rect };

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      const dy = (ev.clientY - startY) / pageRect.height;
      move(item.id, {
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height),
      });
    };
    trackPointerDrag(onMove);
  };

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = { ...item.rect };
    // Keep the displayed pixel aspect ratio constant while resizing.
    const aspect = (start.width * pageRect.width) / (start.height * pageRect.height || 1);

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      let width = clamp(start.width + dx, 0.05, 1 - start.x);
      let height = (width * pageRect.width) / aspect / pageRect.height;
      if (start.y + height > 1) {
        height = 1 - start.y;
        width = (height * pageRect.height * aspect) / pageRect.width;
      }
      move(item.id, { ...start, width, height });
    };
    trackPointerDrag(onMove);
  };

  return (
    <div
      className={`folio-edit folio-edit--image${isSelected ? ' is-selected' : ''}`}
      style={positionStyle(item.rect)}
      tabIndex={0}
      role="group"
      aria-label="Placed image. Arrow keys move it, plus and minus resize it, Delete removes it."
      onFocus={() => select(item.id)}
      onKeyDown={onKeyDown}
    >
      <img
        className="folio-edit__img"
        src={item.dataUrl}
        alt="Placed graphic"
        draggable={false}
        onPointerDown={startDrag}
      />
      {isSelected && (
        <>
          <button
            type="button"
            className="folio-edit__delete"
            aria-label="Delete image"
            title="Delete image"
            onClick={() => remove(item.id)}
          >
            <Icon name="x" size={13} />
          </button>
          <span
            className="folio-edit__resize"
            aria-hidden="true"
            title="Drag to resize"
            onPointerDown={startResize}
          />
        </>
      )}
    </div>
  );
}

/**
 * A stamped check/cross mark: for ticking a printed checkbox that has no real
 * form field behind it (see the module doc). Modeled directly on ImageItem
 * above, including its aspect-locked resize (the glyph is placed as a square
 * and stays one, so it never renders squashed).
 */
function MarkItem({ item }: { item: MarkEdit }) {
  const selectedId = useEditStore((s) => s.selectedId);
  const select = useEditStore((s) => s.select);
  const move = useEditStore((s) => s.move);
  const remove = useEditStore((s) => s.remove);
  const updateMark = useEditStore((s) => s.updateMark);
  const isSelected = selectedId === item.id;
  useDeselectOnOutside(isSelected);

  // Aspect-locked: a mark is placed square and stays square, so the glyph never
  // renders stretched (see startResize below and MARK_GLYPH_PATHS' unit box).
  const onKeyDown = useNudgeKeys({
    rect: item.rect,
    label: MARK_GLYPH_LABEL[item.glyph],
    aspectLocked: true,
    minWidth: 0.02,
    onChange: (rect) => move(item.id, rect),
    onDelete: () => remove(item.id),
  });

  const startDrag = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    select(item.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...item.rect };

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      const dy = (ev.clientY - startY) / pageRect.height;
      move(item.id, {
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height),
      });
    };
    trackPointerDrag(onMove);
  };

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = { ...item.rect };
    // Keep the mark square, the same way ImageItem locks its aspect ratio.
    const aspect = (start.width * pageRect.width) / (start.height * pageRect.height || 1);

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      let width = clamp(start.width + dx, 0.02, 1 - start.x);
      let height = (width * pageRect.width) / aspect / pageRect.height;
      if (start.y + height > 1) {
        height = 1 - start.y;
        width = (height * pageRect.height * aspect) / pageRect.width;
      }
      move(item.id, { ...start, width, height });
    };
    trackPointerDrag(onMove);
  };

  return (
    <div
      className={`folio-edit folio-edit--mark${isSelected ? ' is-selected' : ''}`}
      style={positionStyle(item.rect)}
      tabIndex={0}
      role="group"
      aria-label={`${MARK_GLYPH_LABEL[item.glyph]}. Arrow keys move it, plus and minus resize it, Delete removes it.`}
      onFocus={() => select(item.id)}
      onKeyDown={onKeyDown}
    >
      {isSelected && (
        <MarkInspector item={item} onChange={(patch) => updateMark(item.id, patch)} />
      )}
      {/* viewBox matches MARK_GLYPH_PATHS' 0-100 unit square; scales to the
          rect at any zoom instead of rasterising, so it stays crisp. */}
      <svg
        className="folio-edit__mark"
        viewBox="0 0 100 100"
        role="img"
        aria-label={MARK_GLYPH_LABEL[item.glyph]}
        onPointerDown={startDrag}
      >
        <path
          d={MARK_GLYPH_PATHS[item.glyph]}
          fill="none"
          stroke={item.colorHex}
          strokeWidth={MARK_GLYPH_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {isSelected && (
        <>
          <button
            type="button"
            className="folio-edit__delete"
            aria-label={`Delete ${MARK_GLYPH_LABEL[item.glyph].toLowerCase()}`}
            title="Delete check mark"
            onClick={() => remove(item.id)}
          >
            <Icon name="x" size={13} />
          </button>
          <span
            className="folio-edit__resize"
            aria-hidden="true"
            title="Drag to resize"
            onPointerDown={startResize}
          />
        </>
      )}
    </div>
  );
}

/** The inline inspector for a selected mark: switch its glyph between check and cross. */
function MarkInspector({
  item,
  onChange,
}: {
  item: MarkEdit;
  onChange: (patch: Partial<MarkEdit>) => void;
}) {
  // Keep pointerdown inside the inspector from bubbling to the page/deselect,
  // matching TextInspector above.
  const stop = (e: PointerEvent) => e.stopPropagation();
  return (
    <div className="folio-edit__inspector" onPointerDown={stop}>
      <button
        type="button"
        className={`folio-edit__glyph${item.glyph === 'check' ? ' is-on' : ''}`}
        aria-label={MARK_GLYPH_LABEL.check}
        title={MARK_GLYPH_LABEL.check}
        aria-pressed={item.glyph === 'check'}
        onClick={() => onChange({ glyph: 'check' })}
      >
        <Icon name="check" size={14} />
      </button>
      <button
        type="button"
        className={`folio-edit__glyph${item.glyph === 'cross' ? ' is-on' : ''}`}
        aria-label={MARK_GLYPH_LABEL.cross}
        title={MARK_GLYPH_LABEL.cross}
        aria-pressed={item.glyph === 'cross'}
        onClick={() => onChange({ glyph: 'cross' })}
      >
        <Icon name="cross" size={14} />
      </button>
    </div>
  );
}
