import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent } from 'react';

import type { CreatedSignature } from './types';

export interface SignaturePadHandle {
  /** Export the trimmed drawing as a PNG, or null if nothing was drawn. */
  export(): CreatedSignature | null;
  clear(): void;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A canvas the user draws a signature on with mouse, pen, or touch. */
export const SignaturePad = forwardRef<SignaturePadHandle>(function SignaturePad(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const bounds = useRef<Bounds | null>(null);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111111';
    }
  }, []);

  const positionOf = (e: PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const track = (p: { x: number; y: number }) => {
    const b = bounds.current;
    if (!b) bounds.current = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  };

  const onDown = (e: PointerEvent) => {
    drawing.current = true;
    const p = positionOf(e);
    last.current = p;
    track(p);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    if (!drawing.current || !last.current) return;
    const ctx = canvasRef.current!.getContext('2d');
    if (!ctx) return;
    const p = positionOf(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    track(p);
    hasInk.current = true;
  };

  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  useImperativeHandle(ref, () => ({
    export() {
      const canvas = canvasRef.current;
      if (!canvas || !hasInk.current || !bounds.current) return null;
      const dpr = window.devicePixelRatio || 1;
      const pad = 8;
      const b = bounds.current;
      const sx = Math.max(0, (b.minX - pad) * dpr);
      const sy = Math.max(0, (b.minY - pad) * dpr);
      const sw = Math.min(canvas.width, (b.maxX + pad) * dpr) - sx;
      const sh = Math.min(canvas.height, (b.maxY + pad) * dpr) - sy;
      if (sw <= 0 || sh <= 0) return null;

      const out = document.createElement('canvas');
      out.width = sw;
      out.height = sh;
      out.getContext('2d')?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      return { dataUrl: out.toDataURL('image/png'), aspect: sw / sh };
    },
    clear() {
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      bounds.current = null;
      hasInk.current = false;
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="folio-sigpad"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    />
  );
});
