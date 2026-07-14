import type { Worker } from 'tesseract.js';

import type { OcrWord } from './types';

/**
 * tesseract.js recognition, self-hosted and lazy. The library (and its
 * worker/wasm/model) is only loaded the first time OCR runs, so it stays out of
 * the initial bundle. All assets are served from `/tesseract/` (see
 * scripts/setup-ocr-assets.mjs) to satisfy the app's strict CSP -- no CDN.
 */

// A single reused worker. Recognition is sequential (one page at a time), so a
// module-level progress callback is enough to route per-page progress.
let workerPromise: Promise<Worker> | null = null;
let progressCb: ((fraction: number) => void) | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import('tesseract.js');
      return createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: '/tesseract/worker.min.js',
        // A `.js` corePath is used verbatim, pinning the SIMD-LSTM core and
        // skipping tesseract.js's SIMD auto-detection.
        corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
        langPath: '/tesseract/',
        workerBlobURL: false,
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text' && progressCb) progressCb(m.progress);
        },
      });
    })();
  }
  return workerPromise;
}

export interface RecognizedImage {
  words: OcrWord[];
  text: string;
}

/**
 * Recognize a rasterised page image (a PNG data URL of pixel size width×height)
 * and return words with page-normalized rects plus the full page text.
 */
export async function recognizeImage(
  dataUrl: string,
  width: number,
  height: number,
  onProgress?: (fraction: number) => void,
): Promise<RecognizedImage> {
  const worker = await getWorker();
  progressCb = onProgress ?? null;
  try {
    const { data } = await worker.recognize(dataUrl, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const w of line.words) {
            const text = w.text?.trim();
            if (!text || w.confidence < 30) continue; // drop noise
            words.push({
              text,
              rect: {
                x: w.bbox.x0 / width,
                y: w.bbox.y0 / height,
                width: (w.bbox.x1 - w.bbox.x0) / width,
                height: (w.bbox.y1 - w.bbox.y0) / height,
              },
            });
          }
        }
      }
    }
    return { words, text: data.text ?? '' };
  } finally {
    progressCb = null;
  }
}

/** Tear down the worker (frees the wasm heap). Safe to call when idle. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}
