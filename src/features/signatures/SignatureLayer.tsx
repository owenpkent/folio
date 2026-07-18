import { useMemo, type PointerEvent } from 'react';

import { Icon } from '@/components/common';

import { useSignatureStore } from './store';
import type { Signature } from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Overlay of placed signatures for a page. Each is draggable and resizable. */
export function SignatureLayer({ pageNumber }: { pageNumber: number }) {
  const all = useSignatureStore((s) => s.signatures);
  const items = useMemo(() => all.filter((s) => s.pageNumber === pageNumber), [all, pageNumber]);

  if (items.length === 0) return null;

  return (
    <div className="folio-signature-layer" data-pan-exclude>
      {items.map((sig) => (
        <SignatureItem key={sig.id} sig={sig} />
      ))}
    </div>
  );
}

function SignatureItem({ sig }: { sig: Signature }) {
  const move = useSignatureStore((s) => s.move);
  const remove = useSignatureStore((s) => s.remove);

  const pageRectFrom = (el: Element | null) =>
    el?.closest('.folio-page')?.getBoundingClientRect() ?? null;

  const startDrag = (e: PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...sig.rect };

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      const dy = (ev.clientY - startY) / pageRect.height;
      move(sig.id, {
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
    const start = { ...sig.rect };
    // Displayed pixel aspect ratio, kept constant while resizing.
    const aspect = (start.width * pageRect.width) / (start.height * pageRect.height || 1);

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - startX) / pageRect.width;
      let width = clamp(start.width + dx, 0.05, 1 - start.x);
      let height = (width * pageRect.width) / aspect / pageRect.height;
      if (start.y + height > 1) {
        height = 1 - start.y;
        width = (height * pageRect.height * aspect) / pageRect.width;
      }
      move(sig.id, { ...start, width, height });
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
      className="folio-signature"
      style={{
        left: `${sig.rect.x * 100}%`,
        top: `${sig.rect.y * 100}%`,
        width: `${sig.rect.width * 100}%`,
        height: `${sig.rect.height * 100}%`,
      }}
    >
      <img
        className="folio-signature__img"
        src={sig.dataUrl}
        alt="Signature"
        draggable={false}
        onPointerDown={startDrag}
      />
      <button
        type="button"
        className="folio-signature__delete"
        aria-label="Delete signature"
        title="Delete signature"
        onClick={() => remove(sig.id)}
      >
        <Icon name="x" size={13} />
      </button>
      <span
        className="folio-signature__resize"
        aria-hidden="true"
        title="Drag to resize"
        onPointerDown={startResize}
      />
    </div>
  );
}
