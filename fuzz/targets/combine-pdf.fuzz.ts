import { stagePdf } from '../../src/features/combine/combineDocuments';
import { isExpectedStageError } from './expected';

// Opening an arbitrary file in the combine dialog: the header sniff, then
// pdf-lib's parser, with its failures wrapped in an error that names the file.
const NAME = 'fuzz.pdf';

export async function fuzz(data: Buffer): Promise<void> {
  try {
    await stagePdf(new Uint8Array(data), NAME);
  } catch (err) {
    if (isExpectedStageError(err, NAME)) return;
    throw err;
  }
}
