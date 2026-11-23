// Bundles fuzz/targets/*.fuzz.ts to out/fuzz/<target>.fuzz.cjs (out/ is gitignored).
import { globSync } from 'node:fs';

import { bundle } from './bundle.mjs';

bundle(globSync('fuzz/targets/*.fuzz.ts'), 'out/fuzz').catch(() => process.exit(1));
