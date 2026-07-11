import { create } from 'zustand';

import type { IdentitySummary } from './cert';
import type { DetectedSignature } from './verify';

export interface StoredIdentity {
  id: string;
  label: string;
  /** The passphrase-protected .p12, base64-encoded. The passphrase is never stored. */
  p12Base64: string;
  summary: IdentitySummary;
}

const KEY = 'folio.signing.identities';

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

function load(): StoredIdentity[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity[]) : [];
  } catch {
    return [];
  }
}

function persist(items: StoredIdentity[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable */
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface SigningState {
  /** Saved signing identities (their passphrase-protected .p12 material). */
  identities: StoredIdentity[];
  /** Digital signatures detected in the currently open document. */
  detected: DetectedSignature[];
  modalOpen: boolean;

  addIdentity(label: string, p12: Uint8Array, summary: IdentitySummary): StoredIdentity;
  removeIdentity(id: string): void;
  getP12(id: string): Uint8Array | null;
  setDetected(list: DetectedSignature[]): void;
  setModalOpen(open: boolean): void;
}

export const useSigningStore = create<SigningState>((set, get) => ({
  identities: load(),
  detected: [],
  modalOpen: false,

  addIdentity: (label, p12, summary) => {
    const identity: StoredIdentity = {
      id: uid(),
      label: label || summary.commonName,
      p12Base64: bytesToBase64(p12),
      summary,
    };
    const identities = [...get().identities, identity];
    set({ identities });
    persist(identities);
    return identity;
  },

  removeIdentity: (id) => {
    const identities = get().identities.filter((i) => i.id !== id);
    set({ identities });
    persist(identities);
  },

  getP12: (id) => {
    const found = get().identities.find((i) => i.id === id);
    return found ? base64ToBytes(found.p12Base64) : null;
  },

  setDetected: (detected) => set({ detected }),
  setModalOpen: (modalOpen) => set({ modalOpen }),
}));
