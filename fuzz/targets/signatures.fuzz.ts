import { detectSignatures } from '../../src/features/signing/verify';

// detectSignatures runs on every open, over the whole file. It is documented
// as total, so no exception is expected: any throw is a finding.
export function fuzz(data: Buffer): void {
  detectSignatures(new Uint8Array(data));
}
