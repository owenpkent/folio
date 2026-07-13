import { randomBytes } from 'node:crypto';

/**
 * HTML/CSP helpers for the webview shell. Kept free of the `vscode` API so the
 * security-relevant escaping can be unit-tested and fuzzed in plain Node.
 */

/**
 * Escape a string for safe interpolation into a double-quoted HTML attribute or
 * element text. Encoding `& < > "` is sufficient for both contexts: inside a
 * double-quoted attribute the value cannot close the attribute (no `"`) or open
 * a new tag (no `<`).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A cryptographically-random CSP nonce (128 bits, hex). Used to lock
 * `script-src` to exactly the scripts this extension emits.
 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex');
}
