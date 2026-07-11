import type { CreatedSignature } from './types';

/** Render typed text to a transparent PNG signature. */
export function renderTypedSignature(text: string, font: string): CreatedSignature | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fontSize = 72;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  measure.font = `${fontSize}px ${font}`;
  const width = Math.ceil(measure.measureText(trimmed).width) + 48;
  const height = Math.ceil(fontSize * 1.7);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${fontSize}px ${font}`;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(trimmed, width / 2, height / 2);

  return { dataUrl: canvas.toDataURL('image/png'), aspect: width / height };
}

/** Load an uploaded image file as a signature (keeps its natural aspect ratio). */
export function loadImageFile(file: File): Promise<CreatedSignature> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file'));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () =>
        resolve({ dataUrl, aspect: img.naturalWidth / (img.naturalHeight || 1) });
      img.onerror = () => reject(new Error('Could not decode the image'));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
