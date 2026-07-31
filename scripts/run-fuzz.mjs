#!/usr/bin/env node
/**
 * Run the property/fuzz tests with a high iteration count.
 *
 * A wrapper rather than an inline `FC_NUM_RUNS=... vitest` in package.json
 * because npm runs scripts through cmd.exe on Windows, where that prefix syntax
 * is not a variable assignment but part of the command name. This project is
 * developed on Windows, so the inline form would only work in CI.
 *
 * Iterations and seed can still be overridden from the environment:
 *   FC_NUM_RUNS=200000 npm run test:fuzz
 *   FC_SEED=42 npm run test:fuzz     # reproduce a specific run
 *
 * Any extra arguments are forwarded to vitest, so a single file can be targeted:
 *   npm run test:fuzz -- src/features/signing/verify.fuzz.test.ts
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNS = '20000';

const args = process.argv.slice(2);
// Vitest's positional arguments are substring filters against the test file
// path, not globs, so this selects every *.fuzz.test.ts.
//
// Only a path-shaped argument replaces it. Handing everything over as soon as
// any argument appeared meant `-- --reporter=verbose` silently dropped the
// filter and ran the whole unit suite at 20,000 iterations. A flag is not a
// filter, and neither is the value of a space-separated one
// (`--reporter verbose`), which is why a bare word does not count: keeping the
// filter is the safe way to be wrong about an argument.
const looksLikePath = (a) => /[\\/]/.test(a) || /\.(test|spec)\./.test(a) || a.endsWith('.ts');
const hasFilter = args.some((a) => !a.startsWith('-') && looksLikePath(a));
const target = hasFilter ? args : [...args, '.fuzz.test.'];

// Run vitest's own entry point with this node binary rather than going through
// `npx` under a shell: passing an argument array with `shell: true`
// concatenates without escaping (Node DEP0190). The path is built from the repo
// layout because vitest does not export this subpath for `require.resolve`.
const vitestBin = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(vitestBin)) {
  console.error(`Could not find vitest at ${vitestBin}. Run \`npm install\` first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [vitestBin, 'run', ...target], {
  stdio: 'inherit',
  env: {
    ...process.env,
    FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? DEFAULT_RUNS,
  },
});

child.on('exit', (code, signal) => {
  // Preserve the child's exit status so CI fails on a failing property.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
