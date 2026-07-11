import { beforeEach, describe, expect, it } from 'vitest';

import { useSignatureStore } from './store';

const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.1 };
const dataUrl = 'data:image/png;base64,AAAA';

describe('signature store', () => {
  beforeEach(() => {
    localStorage.clear();
    useSignatureStore.getState().reset();
  });

  it('adds, moves, and removes a signature with persistence', () => {
    useSignatureStore.getState().loadForDocument('fpS');
    const s = useSignatureStore.getState().add(3, dataUrl, rect);

    expect(useSignatureStore.getState().signatures).toHaveLength(1);
    expect(s.pageNumber).toBe(3);

    useSignatureStore.getState().move(s.id, { ...rect, x: 0.5 });
    expect(useSignatureStore.getState().signatures[0].rect.x).toBe(0.5);
    expect(localStorage.getItem('folio.signatures.fpS')).toContain('data:image');

    useSignatureStore.getState().remove(s.id);
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
  });

  it('reloads persisted signatures for a fingerprint', () => {
    useSignatureStore.getState().loadForDocument('fpS2');
    useSignatureStore.getState().add(1, dataUrl, rect);

    useSignatureStore.getState().reset();
    useSignatureStore.getState().loadForDocument('fpS2');
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
  });
});
