// Build the Folio VS Code extension: bundles the extension host (Node/CJS) and
// the webview app — the REAL Folio React app — into a self-contained IIFE plus
// its CSS, and copies the PDF.js worker into out/. Resolves esbuild, React,
// pdfjs, and Folio's own source from the repo's node_modules / src (walks up),
// so no separate `npm install` in this folder is needed just to build.
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'out');
const folioSrc = path.resolve(root, '../../src');
const watch = process.argv.includes('--watch');

fs.mkdirSync(out, { recursive: true });

// Folio's desktop build gets the worker URL via Vite's `?url` import, which
// esbuild does not understand. Swap any `*?url` import for a lookup into a
// global the extension injects with the real webview URI at render time.
const urlAssetPlugin = {
  name: 'folio-url-asset',
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => ({
      path: args.path.replace(/\?url$/, ''),
      namespace: 'folio-url-asset',
    }));
    build.onLoad({ filter: /.*/, namespace: 'folio-url-asset' }, (args) => {
      const base = args.path.split(/[\\/]/).pop();
      return {
        contents: `export default (globalThis.__FOLIO_ASSETS__ && globalThis.__FOLIO_ASSETS__[${JSON.stringify(base)}]) || '';`,
        loader: 'js',
      };
    });
  },
};

const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

const extension = {
  ...shared,
  entryPoints: [path.join(root, 'src/extension.ts')],
  outfile: path.join(out, 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const app = {
  ...shared,
  entryPoints: [path.join(root, 'src/webview/app.tsx')],
  outfile: path.join(out, 'app.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  alias: { '@': folioSrc },
  plugins: [urlAssetPlugin],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.gif': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl' },
  // pdfjs optionally requires the native 'canvas' package on Node; the browser
  // path never hits it, so keep it out of the bundle.
  external: ['canvas'],
};

// The legacy build, to match the one src/core/pdf/setupWorker.ts imports: the
// worker refuses to talk to an API bundle of a different version.
function copyWorker() {
  const worker = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  fs.copyFileSync(worker, path.join(out, 'pdf.worker.min.mjs'));
  console.log('copied pdf.worker.min.mjs');
}

// PDF.js 6 fetches its JBIG2 / JPEG2000 / ICC decoders as .wasm at run time from
// a directory (see setupWorker.ts). The desktop build gets that directory from
// vite.config.ts; here it has to land in out/ so the webview can address it via
// asWebviewUri. Without it, scanned PDFs render blank pages.
function copyWasm() {
  const src = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm');
  const dest = path.join(out, 'pdfjs-wasm');
  fs.mkdirSync(dest, { recursive: true });
  // Same filter as vite.config.ts: skip the LICENSE_* siblings, and skip
  // quickjs-eval.* (the embedded-JavaScript sandbox Folio never enables).
  const files = fs
    .readdirSync(src)
    .filter((f) => /\.(wasm|js)$/.test(f) && !f.startsWith('quickjs-eval'));
  for (const file of files) fs.copyFileSync(path.join(src, file), path.join(dest, file));
  console.log(`copied ${files.length} pdfjs wasm assets`);
}

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(app)]);
  copyWorker();
  copyWasm();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching for changes…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(app)]);
  copyWorker();
  copyWasm();
  console.log('build complete → out/');
}
