import { useEffect, useMemo, useRef, type PointerEvent } from 'react';

import { Icon } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { useEditStore } from './store';
import { FONT_CSS, FONT_LABELS, type FontFamily, type ImageEdit, type TextEdit } from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const pageRectFrom = (el: Element | null) =>
  el?.closest('.folio-page')?.getBoundingClientRect() ?? null;

const FONT_FAMILIES: FontFamily[] = ['Helvetica', 'Times', 'Courier'];

/** Overlay of placed text boxes and images for a page. */
export function EditLayer({ pageNumber }: { pageNumber: number }) {
  const all = useEditStore((s) => s.edits);
  const items = useMemo(() => all.filter((e) => e.pageNumber === pageNumber), [all, pageNumber]);

  if (items.length === 0) return null;

  return (
    <div className="folio-edit-layer" data-pan-exclude>
      {items.map((item) =>
        item.kind === 'text' ? (
          <TextItem key={item.id} item={item} />
        ) : (
          <ImageItem key={item.id} item={item} />
        ),
      )}
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

  const startDrag = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={`folio-edit folio-edit--text${isSelected ? ' is-selected' : ''}`}
      style={positionStyle(item.rect)}
      onPointerDown={() => select(item.id)}
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
          <span
            className="folio-edit__grip"
            aria-hidden="true"
            title="Drag to move"
            onPointerDown={startDrag}
          />
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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={`folio-edit folio-edit--image${isSelected ? ' is-selected' : ''}`}
      style={positionStyle(item.rect)}
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
