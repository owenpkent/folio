import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from '@/components/common/toastStore';
import { useSignatureStore } from '@/features/signatures/store';

import { persistSidecar, resetPersistWarnings } from './persist';

const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.1 };

/** Make every write fail the way a full localStorage does. */
function failWrites(): void {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
}

const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  localStorage.clear();
  resetPersistWarnings();
  useToastStore.setState({ toasts: [] });
  useSignatureStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistSidecar', () => {
  it('writes, and says nothing, when the browser accepts', () => {
    expect(persistSidecar('doc', 'folio.test.doc', [1])).toBe(true);
    expect(localStorage.getItem('folio.test.doc')).toBe('[1]');
    expect(toasts()).toEqual([]);
  });

  it('reports the first refused write for a document, and only the first', () => {
    failWrites();
    expect(persistSidecar('doc', 'folio.test.doc', [1])).toBe(false);
    expect(persistSidecar('doc', 'folio.test.doc', [1, 2])).toBe(false);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatch(/storage is full/);
    expect(useToastStore.getState().toasts[0].kind).toBe('error');
  });

  it('warns again for another document', () => {
    failWrites();
    persistSidecar('doc-a', 'folio.test.a', [1]);
    persistSidecar('doc-b', 'folio.test.b', [1]);
    expect(toasts()).toHaveLength(2);
  });
});

describe('a sidecar store over quota', () => {
  it('keeps the placement on the page and tells the user', () => {
    useSignatureStore.getState().loadForDocument('doc');
    failWrites();

    useSignatureStore.getState().add(1, 'data:image/png;base64,AAAA', rect);
    useSignatureStore.getState().add(1, 'data:image/png;base64,BBBB', rect);

    expect(useSignatureStore.getState().signatures).toHaveLength(2);
    expect(localStorage.getItem('folio.signatures.doc')).toBeNull();
    expect(toasts()).toHaveLength(1);
  });
});
