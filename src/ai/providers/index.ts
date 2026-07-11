import type { AIProvider } from '../types';
import { ClaudeProvider } from './ClaudeProvider';

export const claudeProvider = new ClaudeProvider();

const providers = new Map<string, AIProvider>([[claudeProvider.id, claudeProvider]]);

export function getProvider(id: string): AIProvider | undefined {
  return providers.get(id);
}

export function listProviders(): AIProvider[] {
  return [...providers.values()];
}

/** Register an additional provider (e.g. a local model). */
export function registerProvider(provider: AIProvider): void {
  providers.set(provider.id, provider);
}

export { ClaudeProvider } from './ClaudeProvider';
