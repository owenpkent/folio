import { create } from 'zustand';

/**
 * AI configuration. Disabled by default: Folio is local-first, so nothing is
 * ever sent to a provider until the user explicitly turns AI on and configures
 * a provider. See docs/ai.md (Privacy).
 */
interface AiState {
  enabled: boolean;
  providerId: string;
  setEnabled(enabled: boolean): void;
  setProviderId(id: string): void;
}

export const useAiStore = create<AiState>((set) => ({
  enabled: false,
  providerId: 'claude',
  setEnabled: (enabled) => set({ enabled }),
  setProviderId: (providerId) => set({ providerId }),
}));
