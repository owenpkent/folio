// Opt-in robustness harness: round-trips a corpus of real-world PDFs through
// Folio's real export path (`exportDocument` in features/export/saveDocument.ts)
// and checks the output. Run with `npm run test:corpus`; see docs/testing.md.
//
// Pass 1 ("save"): load with the real PdfJsEngine and call exportDocument with
//   no edits staged, i.e. Save on an untouched document (PDF.js writes the
//   bytes). The output must reopen in PDF.js with the same page count and the
//   same text.
// Pass 2 ("bake"): reload the pass 1 output in pdf-lib, then stage one text box
//   and one highlight in the real stores and call exportDocument again, which
//   takes the pdf-lib stamping path (stampEdits + stampAnnotations).
//
// Corpus files are untrusted input: they are parsed, never executed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { isRegression, mergeBaseline, type Baseline, type Status } from './baseline';

const require = createRequire(import.meta.url);
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));
const dirUrl = (...p: string[]) => pathToFileURL(join(pdfjsDir, ...p)).href + '/';

// The real setupWorker needs Vite's ?url import and a document; in Node PDF.js
// runs its fake worker on its own. Everything else in the engine is real.
vi.mock('@/core/pdf/setupWorker', () => ({
  ensureWorker: () => {},
  pdfWasmUrl: () =>
    pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'wasm')).href + '/',
}));

import { getEngine } from '@/core/pdf';
import { useAnnotationStore } from '@/features/annotations';
import { useEditStore } from '@/features/editing';
import { exportDocument } from '@/features/export/saveDocument';
import { useOcrStore } from '@/features/ocr';
import { useSignatureStore } from '@/features/signatures';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CACHE_DIR = join(REPO_ROOT, '.corpus');
const CORPUS_DIR = process.env.FOLIO_CORPUS_DIR
  ? resolve(process.env.FOLIO_CORPUS_DIR)
  : join(CACHE_DIR, 'pdfjs');
const TIMEOUT_MS = Number(process.env.FOLIO_CORPUS_TIMEOUT_MS ?? 60_000);
const TEXT_PAGES = Number(process.env.FOLIO_CORPUS_TEXT_PAGES ?? 5);
const FILTER = process.env.FOLIO_CORPUS_FILTER;
const LIMIT = Number(process.env.FOLIO_CORPUS_LIMIT ?? Infinity);
// The committed baseline: filename to status only, no PDF content.
const BASELINE = process.env.FOLIO_CORPUS_BASELINE ?? join(import.meta.dirname, 'baseline.json');
// Written by corpus:fetch once every file is in place; see that script.
const FETCH_MARKER = join(CORPUS_DIR, '.complete');

interface FileResult {
  file: string;
  bytes: number;
  pages: number | null;
  status: Status;
  error?: string;
  /** Error message with numbers stripped, for grouping. */
  cluster?: string;
  ms: number;
}

class Stage extends Error {
  constructor(
    readonly status: Status,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

async function openForRead(data: Uint8Array) {
  const task = pdfjsLib.getDocument({
    data: data.slice(),
    wasmUrl: dirUrl('wasm'),
    cMapUrl: dirUrl('cmaps'),
    standardFontDataUrl: dirUrl('standard_fonts'),
    verbosity: 0,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

async function pageTexts(doc: Awaited<ReturnType<typeof openForRead>>['doc'], n: number) {
  const out: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, n); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(
      normalize(
        content.items.map((it) => ('str' in it ? (it as { str: string }).str : '')).join(' '),
      ),
    );
    page.cleanup();
  }
  return out;
}

function resetStores() {
  useEditStore.setState({ edits: [] });
  useAnnotationStore.setState({ annotations: [] });
  useSignatureStore.setState({ signatures: [] });
  useOcrStore.setState({ pages: {} });
}

async function roundTrip(bytes: Uint8Array): Promise<{ pages: number }> {
  const engine = getEngine();
  let numPages: number;
  let origText: string[];
  // Original must be readable by PDF.js at all; otherwise there is nothing to
  // compare and the file is skipped.
  {
    let reader;
    try {
      reader = await openForRead(bytes);
      numPages = reader.doc.numPages;
      origText = await pageTexts(reader.doc, TEXT_PAGES);
    } catch (e) {
      const name = (e as { name?: string }).name;
      throw new Stage(name === 'PasswordException' ? 'skip-encrypted' : 'skip-unreadable', e);
    } finally {
      await reader?.close();
    }
  }

  let saved: Uint8Array;
  try {
    resetStores();
    await engine.loadDocument({ kind: 'bytes', data: bytes.slice(), name: 'corpus.pdf' });
    saved = await exportDocument();
  } catch (e) {
    throw new Stage('save-threw', e);
  } finally {
    await engine.closeDocument();
  }

  // Pass 1 verification.
  {
    let reader;
    try {
      reader = await openForRead(saved);
    } catch (e) {
      throw new Stage('reopen-failed', e);
    }
    try {
      if (reader.doc.numPages !== numPages) {
        throw new Stage('page-count-changed', `${numPages} pages became ${reader.doc.numPages}`);
      }
      const newText = await pageTexts(reader.doc, TEXT_PAGES);
      const bad = newText.findIndex((t, i) => t !== origText[i]);
      if (bad >= 0) {
        throw new Stage(
          'text-changed',
          `page ${bad + 1}: ${origText[bad].length} chars became ${newText[bad].length}`,
        );
      }
    } finally {
      await reader.close();
    }
  }

  // Pass 2: the pdf-lib bake path.
  try {
    await PDFDocument.load(saved);
  } catch (e) {
    throw new Stage('pdflib-load-failed', e);
  }
  let baked: Uint8Array;
  try {
    resetStores();
    await engine.loadDocument({ kind: 'bytes', data: saved.slice(), name: 'corpus.pdf' });
    const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.05 };
    useEditStore.setState({
      edits: [
        {
          id: 'corpus-text',
          kind: 'text',
          pageNumber: 1,
          rect,
          createdAt: 0,
          text: 'Folio corpus check',
          fontFamily: 'Helvetica',
          bold: false,
          fontSizePt: 12,
          colorHex: '#111111',
        },
      ],
    });
    useAnnotationStore.setState({
      annotations: [
        {
          id: 'corpus-hl',
          type: 'highlight',
          pageNumber: 1,
          color: 'rgba(255, 214, 10, 0.45)',
          rects: [{ x: 0.1, y: 0.3, width: 0.4, height: 0.03 }],
          text: 'x',
          createdAt: 0,
        },
      ],
    });
    baked = await exportDocument();
  } catch (e) {
    throw new Stage('bake-threw', e);
  } finally {
    resetStores();
    await engine.closeDocument();
  }
  let reader;
  try {
    reader = await openForRead(baked);
  } catch (e) {
    throw new Stage('bake-reopen-failed', e);
  }
  try {
    if (reader.doc.numPages !== numPages) {
      throw new Stage('bake-page-count-changed', `${numPages} pages became ${reader.doc.numPages}`);
    }
  } finally {
    await reader.close();
  }
  return { pages: numPages };
}

async function runOne(dir: string, file: string): Promise<FileResult> {
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const t0 = Date.now();
  const base = { file, bytes: bytes.length, pages: null as number | null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      roundTrip(bytes),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Stage('timeout', `no result after ${TIMEOUT_MS} ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
    return { ...base, pages: r.pages, status: 'ok', ms: Date.now() - t0 };
  } catch (e) {
    let status: Status = e instanceof Stage ? e.status : 'save-threw';
    // A typed refusal is the app declining to write an unsafe file, with a
    // message for the user: acceptable, unlike a crash or a bad output.
    if (e instanceof Error && TYPED_ERRORS.has(e.name) && status.endsWith('threw')) {
      status = 'refused';
    }
    const msg = e instanceof Error ? e.message : String(e);
    const first = (e instanceof Error && e.name && e.name !== 'Error' ? `${e.name}: ` : '') + msg;
    if (status === 'timeout') {
      resetStores();
      await getEngine()
        .closeDocument()
        .catch(() => {});
    }
    return {
      ...base,
      status,
      error: first.slice(0, 500),
      cluster: first.split('\n')[0].replace(/\d+/g, 'N').slice(0, 120),
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Errors Folio raises on purpose to refuse an unsafe save; see core/pdf/errors.ts. */
const TYPED_ERRORS = new Set(['PageCountMismatchError', 'UnsafeOutputError', 'MissingPageError']);

function summarize(results: FileResult[], regressions: string[]) {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const clusters = new Map<string, FileResult[]>();
  for (const r of results) {
    if (r.status === 'ok' || r.status === 'skip-encrypted') continue;
    const key = `${r.status} | ${r.cluster ?? ''}`;
    (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(r);
  }
  const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  const eligible = results.filter((r) => !r.status.startsWith('skip')).length;
  const lines = [
    '# Folio corpus run',
    '',
    `Corpus: ${CORPUS_DIR}`,
    `Files: ${results.length}, eligible (readable, not encrypted): ${eligible}, ok: ${counts.ok ?? 0}`,
    '',
    '| Status | Files |',
    '| --- | ---: |',
    ...Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `| ${s} | ${n} |`),
    '',
    '## Failure clusters',
    '',
    ...sorted.flatMap(([key, rs]) => [
      `- ${rs.length}x ${key} (e.g. ${rs
        .slice(0, 3)
        .map((r) => r.file)
        .join(', ')})`,
    ]),
  ];
  if (regressions.length > 0) {
    lines.push('', '## Regressions vs baseline', '', ...regressions.map((f) => `- ${f}`));
  }
  return { counts, text: lines.join('\n') + '\n' };
}

describe('corpus round trip', () => {
  const results: FileResult[] = [];
  const present = existsSync(CORPUS_DIR);

  it.skipIf(!present)(
    'round-trips every PDF through exportDocument',
    async () => {
      // The fetched corpus is only trusted once corpus:fetch finished copying
      // it; a partial directory would pass with most of the baseline untested.
      // A directory the user pointed at directly is theirs to vouch for.
      if (!process.env.FOLIO_CORPUS_DIR && !existsSync(FETCH_MARKER)) {
        throw new Error(
          `${CORPUS_DIR} is incomplete (no ${FETCH_MARKER}); run \`npm run corpus:fetch\``,
        );
      }
      const all = readdirSync(CORPUS_DIR)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .sort();
      const files = all.filter((f) => !FILTER || f.includes(FILTER)).slice(0, LIMIT);
      const partial = files.length < all.length;
      mkdirSync(CACHE_DIR, { recursive: true });
      for (const [i, file] of files.entries()) {
        const r = await runOne(CORPUS_DIR, file);
        results.push(r);
        process.stdout.write(`[${i + 1}/${files.length}] ${r.status} ${file} (${r.ms} ms)\n`);
      }

      let regressions: string[] = [];
      const base: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
      if (existsSync(BASELINE)) {
        regressions = results
          .filter((r) => isRegression(base[r.file], r.status))
          .map((r) => `${r.file}: ${base[r.file]} -> ${r.status} (${r.error ?? ''})`);
      }
      const { counts, text } = summarize(results, regressions);
      const reportPath = join(CACHE_DIR, 'report.json');
      writeFileSync(
        reportPath,
        JSON.stringify(
          { corpus: CORPUS_DIR, date: new Date().toISOString(), counts, results },
          null,
          2,
        ),
      );
      writeFileSync(join(CACHE_DIR, 'summary.md'), text);
      process.stdout.write('\n' + text);
      if (process.env.FOLIO_CORPUS_UPDATE_BASELINE === '1') {
        // Nothing but filename and status, so no PDF content can leak into the
        // repo. A filtered or limited run only updates the files it tested.
        const next = mergeBaseline(base, results, { partial });
        writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
        if (partial) {
          process.stdout.write(
            `Baseline updated for ${results.length} of ${all.length} files; the rest kept.\n`,
          );
        }
      }

      expect(regressions, 'files that passed in the baseline now fail').toEqual([]);
    },
    // Vitest's own cap is disabled in the config; per-file timeouts are above.
    0,
  );
});
