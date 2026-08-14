/**
 * A short id for client-only state (list items, staged entries). Not a
 * document identifier and never persisted across app versions, so
 * `crypto.randomUUID()` is enough; the fallback only matters in the rare
 * environment without it.
 */
export function uid(prefix: string): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}
