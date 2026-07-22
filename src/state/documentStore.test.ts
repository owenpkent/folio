import { beforeEach, describe, expect, it } from 'vitest';

import type { PdfDocumentInfo, PdfMetadata } from '@/core/pdf';

import { useDocumentStore } from './documentStore';

const info: PdfDocumentInfo = { numPages: 5, fingerprint: 'fp1', name: 'a.pdf' };
const meta: PdfMetadata = { pageCount: 5 };

describe('documentStore', () => {
  beforeEach(() => useDocumentStore.getState().reset());

  it('starts empty', () => {
    const s = useDocumentStore.getState();
    expect(s.status).toBe('empty');
    expect(s.info).toBeNull();
    expect(s.outline).toEqual([]);
  });

  it('setLoaded populates state and marks it ready', () => {
    useDocumentStore.getState().setLoaded(info, meta, []);
    const s = useDocumentStore.getState();
    expect(s.status).toBe('ready');
    expect(s.info?.fingerprint).toBe('fp1');
    expect(s.metadata?.pageCount).toBe(5);
    expect(s.error).toBeNull();
  });

  it('setError records the message and error status', () => {
    useDocumentStore.getState().setError('boom');
    const s = useDocumentStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
  });

  it('reset clears everything back to empty', () => {
    useDocumentStore.getState().setLoaded(info, meta, []);
    useDocumentStore.getState().reset();
    const s = useDocumentStore.getState();
    expect(s.status).toBe('empty');
    expect(s.info).toBeNull();
    expect(s.metadata).toBeNull();
  });

  it('setSourcePath stores the on-disk origin and reset clears it', () => {
    useDocumentStore.getState().setSourcePath('C:/docs/a.pdf');
    expect(useDocumentStore.getState().sourcePath).toBe('C:/docs/a.pdf');
    useDocumentStore.getState().reset();
    expect(useDocumentStore.getState().sourcePath).toBeNull();
  });

  it('setBooted clears the booting gate', () => {
    useDocumentStore.setState({ booting: true });
    useDocumentStore.getState().setBooted();
    expect(useDocumentStore.getState().booting).toBe(false);
  });
});
