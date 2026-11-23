// Runs one Jazzer.js target: node fuzz/run.mjs <target> [seconds]
// Minimizes a corpus: node fuzz/run.mjs merge <target> [corpus-dir]  (npm run fuzz:merge)
// A dictionary at fuzz/dict/<target>.dict, when present, is passed with -dict.
// The time budget also comes from FUZZ_SECONDS (default 60). The evolved corpus
// lives in fuzz/.corpus/<target>/ (untracked) and is seeded from the committed
// fuzz/corpus/<target>/; crashing inputs land in fuzz/crashes/<target>/.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dictErrors } from './dict.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const merge = process.argv[2] === 'merge';
const args = merge ? process.argv.slice(3) : process.argv.slice(2);
const target = args[0];
const seconds = merge ? 1 : Number(args[1] ?? process.env.FUZZ_SECONDS ?? 60);
const sourceFile = path.join(root, 'fuzz/targets', `${target}.fuzz.ts`);
const targetFile = path.join(root, 'out/fuzz', `${target}.fuzz.cjs`);
if (!target || !existsSync(sourceFile)) {
  console.error(
    'usage: node fuzz/run.mjs [merge] <target> [seconds|corpus-dir]; targets are fuzz/targets/*.fuzz.ts',
  );
  process.exit(2);
}
// Whole seconds, at least one: libFuzzer reads -max_total_time=0 as no limit
// at all, so a fractional budget rounded down would run forever.
if (!Number.isInteger(seconds) || seconds < 1) {
  console.error(
    `invalid time budget: ${args[1] ?? process.env.FUZZ_SECONDS} (whole seconds, at least 1)`,
  );
  process.exit(2);
}

const build = spawnSync(process.execPath, [path.join(root, 'fuzz/build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const evolved = path.join(root, 'fuzz/.corpus', target);
// An async target must not run in sync mode: Jazzer.js would drop its promises
// unawaited and memory would grow without end.
const isAsync = /export\s+async\s+function\s+fuzz\b/.test(readFileSync(sourceFile, 'utf8'));
const jazzer = require.resolve('@jazzer.js/core/dist/cli.js');
// Instrument only our own bundle (see fuzz/bundle.mjs).
const includes = ['--includes', path.join('out', 'fuzz') + path.sep];

if (merge) {
  // libFuzzer -merge=1 copies into the FIRST directory only the inputs that add
  // coverage over the rest, so the result is a fresh minimized corpus in
  // fuzz/.corpus-min/<target>/ (untracked). The inputs are the committed seeds
  // and the evolved corpus, or the directory given as the last argument (for
  // example a cached nightly corpus downloaded and unpacked).
  const fresh = path.join(root, 'fuzz/.corpus-min', target);
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  const inputs = args[1]
    ? [path.resolve(args[1])]
    : [path.join(root, 'fuzz/corpus', target), evolved].filter((d) => existsSync(d));
  const mergeRun = spawnSync(
    process.execPath,
    [
      jazzer,
      targetFile,
      fresh,
      ...inputs,
      ...(isAsync ? [] : ['--sync']),
      '--timeout=10000',
      ...includes,
      '--',
      '-merge=1',
      '-rss_limit_mb=2048',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (mergeRun.status === 0 && readdirSync(fresh).length === 0) {
    // On Windows libFuzzer may record no coverage features for any input, so it
    // keeps nothing. Do not trust an empty result; run the merge on Linux.
    console.error(
      `merge kept no inputs for ${target}: either the corpus adds no coverage or this platform does not report it`,
    );
    process.exit(3);
  }
  process.exit(mergeRun.status ?? 1);
}

const crashes = path.join(root, 'fuzz/crashes', target);
mkdirSync(evolved, { recursive: true });
mkdirSync(crashes, { recursive: true });
const seeds = path.join(root, 'fuzz/corpus', target);
if (existsSync(seeds)) {
  cpSync(seeds, evolved, { recursive: true, force: false });
}

// A dictionary of format tokens (fuzz/dict/<target>.dict, libFuzzer syntax) lets
// the mutator splice in keywords and magic numbers it would take far longer to
// invent byte by byte. Optional: a target without one runs as before.
const dictFile = path.join(root, 'fuzz/dict', `${target}.dict`);
const hasDict = existsSync(dictFile);
if (hasDict) {
  // libFuzzer gives up on a dictionary it cannot parse, and the process still
  // exits 0. Refuse it here, with the lines named.
  const errors = dictErrors(readFileSync(dictFile, 'utf8'));
  if (errors.length > 0) {
    console.error(`invalid libFuzzer dictionary ${path.relative(root, dictFile)}:`);
    for (const { line, text } of errors) console.error(`  line ${line}: ${text}`);
    process.exit(2);
  }
}

// The fuzzer writes straight to this process's own stdout and stderr. Do not put
// a pipe in between to read what it prints: libFuzzer writes from native code
// to descriptors Node has made non-blocking, so a burst (the dictionary it
// recommends at the end) is cut short when the reader falls behind. The first
// nightly run lost the closing line that way.
const started = performance.now();
const result = spawnSync(
  process.execPath,
  [
    jazzer,
    targetFile,
    evolved,
    ...(isAsync ? [] : ['--sync']),
    // Per-input timeout. Jazzer hands libFuzzer its own -timeout from this
    // option (default 5 s), overriding one passed after `--`.
    '--timeout=10000',
    ...includes,
    '--',
    `-max_total_time=${seconds}`,
    '-rss_limit_mb=2048',
    `-artifact_prefix=${crashes}${path.sep}`,
    ...(hasDict ? [`-dict=${dictFile}`] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
const elapsed = (performance.now() - started) / 1000;
if (result.status === 0 && elapsed < seconds) {
  // A clean fuzzing loop stops only when -max_total_time runs out, so exit 0
  // any sooner means the fuzzer gave up before or during startup (a bad
  // option, a target that failed to load) and Jazzer.js still exited 0.
  // Reporting that as success would show a green nightly run that fuzzed
  // nothing. Wall time, not the output, because the output can be cut short.
  console.error(
    `${target}: the fuzzer exited 0 after ${elapsed.toFixed(1)} s of a ${seconds} s budget, so it did not fuzz; treating it as a failure`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
