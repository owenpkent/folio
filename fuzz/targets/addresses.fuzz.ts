import { addressAt, findAddresses } from '../../src/features/links/detect';

// Link and email detection over text extracted from a PDF: regex-heavy, so the
// per-input timeout catches catastrophic backtracking. Total by design.
export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  const found = findAddresses(text);
  for (const a of found) {
    if (a.start < 0 || a.end > text.length || a.start >= a.end) {
      throw new Error(`address out of range: ${a.start}-${a.end} of ${text.length}`);
    }
  }
  addressAt(text, data.length > 0 ? data[0] : 0);
}
