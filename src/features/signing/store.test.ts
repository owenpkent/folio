import { beforeEach, describe, expect, it } from 'vitest';

import type { IdentitySummary } from './cert';
import { base64ToBytes, bytesToBase64, useSigningStore } from './store';

const summary: IdentitySummary = {
  commonName: 'Test',
  issuer: 'Test',
  validFrom: '',
  validTo: '',
  serialNumber: '1',
  selfSigned: true,
};

describe('signing store', () => {
  beforeEach(() => {
    localStorage.clear();
    useSigningStore.setState({ identities: [], detected: [], modalOpen: false });
  });

  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 128, 254, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('adds, retrieves, and removes identities', () => {
    const p12 = new Uint8Array([1, 2, 3, 4]);
    const identity = useSigningStore.getState().addIdentity('My cert', p12, summary);

    expect(useSigningStore.getState().identities).toHaveLength(1);
    expect(Array.from(useSigningStore.getState().getP12(identity.id)!)).toEqual([1, 2, 3, 4]);
    expect(localStorage.getItem('folio.signing.identities')).toContain('My cert');

    useSigningStore.getState().removeIdentity(identity.id);
    expect(useSigningStore.getState().identities).toHaveLength(0);
    expect(useSigningStore.getState().getP12(identity.id)).toBeNull();
  });

  it('tracks detected signatures and modal state', () => {
    useSigningStore.getState().setModalOpen(true);
    expect(useSigningStore.getState().modalOpen).toBe(true);

    useSigningStore
      .getState()
      .setDetected([{ signerName: 'A', signingTime: null, coversWholeDocument: true }]);
    expect(useSigningStore.getState().detected).toHaveLength(1);
  });
});
