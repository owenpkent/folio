import { readPkcs12 } from '../../src/features/signing/pkcs12';
import { isExpectedPkcs12Error } from './expected';

// The first input byte picks the passphrase, so seeds can carry the one their
// fixture was written with; the rest is the .p12. Without the right passphrase
// the container MAC fails before any bag is read.
const PASSPHRASES = ['pw', 'legacy-pass', 'päss', ''];

export async function fuzz(data: Buffer): Promise<void> {
  if (data.length < 1) return;
  const passphrase = PASSPHRASES[data[0] % PASSPHRASES.length];
  try {
    await readPkcs12(new Uint8Array(data.subarray(1)), passphrase);
  } catch (err) {
    if (isExpectedPkcs12Error(err)) return;
    throw err;
  }
}
