import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';
import { contentKey } from '@/core/document/contentKey';
import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common/toastStore';
import {
  capturePositionForSave,
  findPosition,
  readLastDocument,
  recordPositionForBytes,
  setReadingPosition,
} from '@/features/readingPosition';

let numPages = 100;
// Null: every file gets its own, as most real PDFs do. Set to share one.
let engineFingerprint: string | null = null;
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({
      loadDocument: async (source: PdfCore.DocumentSource) => ({
        numPages,
        fingerprint: engineFingerprint ?? `engine-${source.name}`,
        name: source.name ?? 'x.pdf',
      }),
      getMetadata: async () => ({ pageCount: numPages }),
      getOutline: async () => [],
      closeDocument: async () => {},
    }),
  };
});
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));
vi.mock('@/components/common/toastStore', () => ({ pushToast: vi.fn() }));

import { useDocumentStore } from './documentStore';
import { useViewerStore } from './viewerStore';
import { closeDocument, loadSource } from './actions';

const POSITIONS = 'folio.readingPositions';
const pdf = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}`);
const keyOf = async (body: string) => (await contentKey({ kind: 'bytes', data: pdf(body) }))!;
const open = (body: string, options?: Parameters<typeof loadSource>[1], path?: string) =>
  loadSource({ kind: 'bytes', data: pdf(body), name: `${body}.pdf`, path }, options);
const scrollTo = (page: number) => useViewerStore.getState().setCurrentPage(page);
const pageOf = async (body: string) =>
  findPosition({ fingerprint: await keyOf(body), idKey: null, pathKey: null }, 1000)?.page ?? null;
const remember = async (body: string, page: number) =>
  setReadingPosition(
    { fingerprint: await keyOf(body), idKey: null, pathKey: null },
    { page, scale: 1.2, fitMode: 'width' },
  );

beforeEach(async () => {
  numPages = 100;
  engineFingerprint = null;
  localStorage.clear();
  await closeDocument();
  useViewerStore.getState().reset();
  vi.useFakeTimers();
  vi.mocked(announce).mockClear();
  vi.mocked(pushToast).mockClear();
});
afterEach(() => vi.useRealTimers());

describe('resuming a remembered page', () => {
  it('jumps there and announces it once, without a toast', async () => {
    await remember('a', 47);
    await open('a');
    expect(useViewerStore.getState().currentPage).toBe(47);
    expect(useViewerStore.getState().pendingScrollPage).toBe(47);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Opened a.pdf, 100 pages, resumed at page 47');
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('lets an explicit page win over the remembered one', async () => {
    await remember('a', 47);
    await open('a', { page: 12 });
    expect(useViewerStore.getState().currentPage).toBe(12);
    expect(announce).toHaveBeenCalledWith('Opened a.pdf, 100 pages');
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('ignores a remembered page past the end', async () => {
    await remember('a', 47);
    numPages = 10;
    await open('a');
    expect(useViewerStore.getState().currentPage).toBe(1);
    expect(announce).toHaveBeenCalledWith('Opened a.pdf, 10 pages');
  });

  it('does not resume a document with no entry', async () => {
    await open('a');
    expect(useViewerStore.getState().currentPage).toBe(1);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('restores a hand-picked zoom along with the page', async () => {
    await open('a');
    useViewerStore.setState({ fitMode: 'custom', scale: 2 });
    scrollTo(5);
    await closeDocument();
    await open('a');
    expect(useViewerStore.getState()).toMatchObject({
      currentPage: 5,
      fitMode: 'custom',
      scale: 2,
    });
  });

  it('restores the zoom alone at page 1, without a resume message', async () => {
    await open('a');
    useViewerStore.setState({ fitMode: 'custom', scale: 3 });
    vi.advanceTimersByTime(500);
    await closeDocument();
    await open('a');
    expect(useViewerStore.getState()).toMatchObject({
      currentPage: 1,
      fitMode: 'custom',
      scale: 3,
    });
    expect(pushToast).not.toHaveBeenCalled();
  });
});

describe('recording the position', () => {
  it('writes after the debounce, not before', async () => {
    await open('a');
    scrollTo(5);
    scrollTo(6);
    vi.advanceTimersByTime(499);
    expect(await pageOf('a')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await pageOf('a')).toBe(6);
  });

  it('does not let the reset to page 1 during a load erase the stored page', async () => {
    await open('a');
    scrollTo(30);
    await open('a');
    expect(useViewerStore.getState().currentPage).toBe(30);
    vi.advanceTimersByTime(1000);
    expect(await pageOf('a')).toBe(30);
  });

  it('flushes on close, before the stores reset', async () => {
    await open('a');
    scrollTo(8);
    await closeDocument();
    expect(await pageOf('a')).toBe(8);
    vi.advanceTimersByTime(1000);
    expect(await pageOf('a')).toBe(8);
  });

  it('flushes the old document when another loads, under the old key', async () => {
    await open('a');
    scrollTo(8);
    await open('b');
    expect(await pageOf('a')).toBe(8);
    expect(await pageOf('b')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(await pageOf('b')).toBeNull();
  });

  it('flushes on pagehide', async () => {
    await open('a');
    scrollTo(21);
    window.dispatchEvent(new Event('pagehide'));
    expect(await pageOf('a')).toBe(21);
  });

  it('forgets the page when the reader scrolls back to the top', async () => {
    await remember('a', 47);
    await open('a');
    scrollTo(1);
    vi.advanceTimersByTime(500);
    expect(await pageOf('a')).toBeNull();
  });

  it('records a zoom change', async () => {
    await open('a');
    useViewerStore.setState({ fitMode: 'page' });
    vi.advanceTimersByTime(500);
    expect(await pageOf('a')).toBe(1);
  });

  it('files the position under the written bytes after a save', async () => {
    await open('a');
    scrollTo(14);
    await recordPositionForBytes(pdf('a, edited'), null, capturePositionForSave());
    expect(await pageOf('a, edited')).toBe(14);
  });

  it('keeps recording under the saved file after a save in place', async () => {
    await open('a');
    scrollTo(14);
    await recordPositionForBytes(pdf('a, saved'), null, capturePositionForSave(), {
      follow: true,
    });
    scrollTo(60);
    await closeDocument();
    // Not the save-time snapshot: the file on disk is now 'a, saved', and the
    // reader stopped at 60.
    expect(await pageOf('a, saved')).toBe(60);
  });

  it('leaves recording on the open file after saving a copy', async () => {
    await open('a');
    scrollTo(14);
    await recordPositionForBytes(pdf('a, copy'), null, capturePositionForSave());
    scrollTo(60);
    await closeDocument();
    expect(await pageOf('a, copy')).toBe(14);
    expect(await pageOf('a')).toBe(60);
  });

  // A save outlives its export: the native write and the hashing are awaited
  // with the lock released, so another document can be the open one before
  // they finish. `saved` is what the export captures while it holds the lock.
  it('files a save that finishes after a switch under the saved document, not the open one', async () => {
    await open('a');
    scrollTo(14);
    const saved = capturePositionForSave();
    await open('b');
    scrollTo(8);
    await recordPositionForBytes(pdf('a, saved'), null, saved, { follow: true });
    scrollTo(25);
    await closeDocument();
    // A's written file is at A's page, not at the page B was on or went to.
    expect(await pageOf('a, saved')).toBe(14);
    expect(await pageOf('a')).toBe(14);
    // And B went on being recorded as B: following the save would have filed
    // the rest of its session under A's hash.
    expect(await pageOf('b')).toBe(25);
  });

  it('files a copy that is written after a switch at the saved document page', async () => {
    await open('a');
    scrollTo(14);
    const saved = capturePositionForSave();
    await open('b');
    scrollTo(31);
    await recordPositionForBytes(pdf('a, copy'), null, saved);
    await closeDocument();
    expect(await pageOf('a, copy')).toBe(14);
    expect(await pageOf('b')).toBe(31);
  });

  it('files the page the reader has reached when the saved document is still open', async () => {
    await open('a');
    scrollTo(14);
    const saved = capturePositionForSave();
    // Read on while the write is in flight.
    scrollTo(20);
    await recordPositionForBytes(pdf('a, saved'), null, saved, { follow: true });
    expect(await pageOf('a, saved')).toBe(20);
  });

  it('does not let a returned-to document inherit a save from its earlier session', async () => {
    await open('a');
    scrollTo(14);
    const saved = capturePositionForSave();
    await closeDocument();
    await open('a');
    scrollTo(40);
    await recordPositionForBytes(pdf('a, saved'), null, saved, { follow: true });
    scrollTo(50);
    await closeDocument();
    // The same file reopened is a new session: its bytes are whatever was on
    // disk when it was read, so it keeps recording under its own hash.
    expect(await pageOf('a, saved')).toBe(14);
    expect(await pageOf('a')).toBe(50);
  });
});

describe('finding a document whose bytes changed', () => {
  it('resumes a re-saved file (new hash, same trailer id)', async () => {
    engineFingerprint = 'ID-ONE';
    await open('a');
    scrollTo(30);
    await closeDocument();

    await open('a, re-saved by another program');
    expect(useViewerStore.getState().currentPage).toBe(30);
    expect(announce).toHaveBeenLastCalledWith(
      'Opened a, re-saved by another program.pdf, 100 pages, resumed at page 30',
    );
    // Filed under the new hash too, so the next open is an exact match.
    expect(await pageOf('a, re-saved by another program')).toBe(30);
  });

  it('resumes a replaced file (new id, same path), ignoring Windows case and slashes', async () => {
    engineFingerprint = 'ID-ONE';
    await open('a', undefined, 'C:\\Docs\\Report.pdf');
    scrollTo(30);
    await closeDocument();

    engineFingerprint = 'ID-TWO';
    await open('b', undefined, 'c:/docs/report.pdf');
    expect(useViewerStore.getState().currentPage).toBe(30);
  });

  it('does not resume an unrelated file at another path', async () => {
    engineFingerprint = 'ID-ONE';
    await open('a', undefined, 'C:\\Docs\\Report.pdf');
    scrollTo(30);
    await closeDocument();

    engineFingerprint = 'ID-TWO';
    await open('b', undefined, 'C:\\Docs\\Other.pdf');
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('ignores a fallback page past the end of the new file', async () => {
    engineFingerprint = 'ID-ONE';
    await open('a');
    scrollTo(60);
    await closeDocument();

    numPages = 20;
    await open('a, shorter');
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('never stores a path or file name in the position list', async () => {
    const path = 'C:\\Users\\someone\\Secret Plans\\budget.pdf';
    await open('a', undefined, path);
    scrollTo(30);
    await closeDocument();
    await recordPositionForBytes(pdf('a, saved'), path, capturePositionForSave());

    const raw = localStorage.getItem(POSITIONS)!;
    expect(raw).toBeTruthy();
    for (const text of [path, path.replace(/\\/g, '/'), 'Secret Plans', 'budget', 'someone']) {
      expect(raw.toLowerCase()).not.toContain(text.toLowerCase());
    }
  });
});

describe('the last document note', () => {
  const path = 'C:\\docs\\statement.pdf';

  it('is written on open and kept when the document is closed', async () => {
    await open('statement', undefined, path);
    expect(readLastDocument()).toEqual({ path, name: 'statement.pdf', page: 1 });
    scrollTo(12);
    await closeDocument();
    expect(readLastDocument()).toEqual({ path, name: 'statement.pdf', page: 12 });
  });

  it('is not written for a document without a path', async () => {
    await open('a');
    scrollTo(4);
    await closeDocument();
    expect(readLastDocument()).toBeNull();
    expect(useDocumentStore.getState().sourcePath).toBeNull();
  });
});
