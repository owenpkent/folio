// Shared esbuild step for the Jazzer.js harness: each entry point becomes one
// CommonJS bundle of our own code. node_modules packages stay external, so
// Jazzer.js instruments only src/ and fuzz/ (the --includes filter in run.mjs
// matches the bundle path) and leaves dependencies alone. The package is
// "type": "module", so the output is .cjs. The bundle is needed because src/
// imports through the `@/` alias, which a per-file transpile cannot resolve;
// the alias here mirrors resolve.alias in vite.config.ts.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function bundle(entryPoints, outdir) {
  return build({
    absWorkingDir: root,
    entryPoints,
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    packages: 'external',
    alias: { '@': './src' },
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
  });
}
