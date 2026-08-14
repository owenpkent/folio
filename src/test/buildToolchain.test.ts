// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import viteConfig from '../../vite.config';

// Guards the build toolchain against the class of breakage the Vite 8 bump hit:
// Vite is rolldown-based from 8.x and no longer installs esbuild, so anything
// that still assumes esbuild is sitting in the hoisted node_modules dies at
// build time rather than at install time. CI only notices several minutes in,
// and `npm run test` is the cheapest place to catch it.

const readJson = (relative: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

const pkg = readJson('../../package.json') as {
  devDependencies: Record<string, string>;
};
const lock = readJson('../../package-lock.json') as {
  packages: Record<string, { version: string } | undefined>;
};

// Minifiers Vite treats as optional peers: selecting one obliges us to install
// it. 'oxc' and `true`/`false` need nothing, because oxc is inside rolldown.
const PEER_MINIFIERS = ['esbuild', 'terser'];

describe('build toolchain', () => {
  it('does not select a minifier that nothing installs', () => {
    const minify = viteConfig.build?.minify;
    if (typeof minify === 'string' && PEER_MINIFIERS.includes(minify)) {
      expect(
        pkg.devDependencies[minify],
        `build.minify: '${minify}' needs a devDependency`,
      ).toBeDefined();
      expect(lock.packages[`node_modules/${minify}`]).toBeDefined();
    }
    // Whatever it is, it must still be a real minifier: an unminified 1.5 MB
    // bundle would ship silently rather than fail the build.
    expect(minify).not.toBe(false);
  });

  it('keeps esbuild installed at the root for the VS Code extension build', () => {
    // extensions/vscode/build.mjs imports esbuild and DEVELOPING.md drives
    // node_modules/.bin/esbuild for the fuzz harness, both resolved by walking
    // up to this package. Vite used to drag esbuild in; now it is ours to hold.
    expect(pkg.devDependencies.esbuild).toBeDefined();
    expect(lock.packages['node_modules/esbuild']).toBeDefined();
  });

  it('does not default-import a CJS package that hides its default behind __esModule', () => {
    // Default-importing CommonJS is only unambiguous when the package assigns
    // `module.exports` outright, the way node-forge does. When it instead marks
    // `__esModule` and sets `exports.default` (what Babel emits), the two
    // bundlers disagree: esbuild reads the marker and hands back
    // `exports.default`, rolldown hands back the whole namespace object.
    //
    // @signpdf/signpdf is that shape, and its namespace has no `.sign`, so the
    // Vite 8 bump broke signing in both the dev server and the built app. What
    // makes it worth a test rather than a memory: nothing else here can see it.
    // tsc reads the .d.ts, which describes the esbuild answer, and vitest runs
    // in Node, whose interop also matches esbuild. Only a browser build breaks,
    // which is why a full e2e run was the cheapest thing that caught it.
    const require = createRequire(import.meta.url);
    const srcDir = fileURLToPath(new URL('../', import.meta.url));

    // Only what ships to the browser. Tests and setup files run under Node.
    const shipped = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'test' ? [] : shipped(full);
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
        return [full];
      });

    const DEFAULT_IMPORT = /^import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+'([^']+)'/gm;
    const offenders: string[] = [];

    for (const file of shipped(srcDir)) {
      for (const [, local, specifier] of readFileSync(file, 'utf8').matchAll(DEFAULT_IMPORT)) {
        // Relative paths, the `@/` alias, node builtins and `?url` assets are
        // all resolved by Vite, not by this interop rule.
        if (/^[.@]\/|^node:/.test(specifier) || specifier.includes('?')) continue;

        let entry: string;
        try {
          entry = require.resolve(specifier);
        } catch {
          continue; // Browser-only or subpath-exported: nothing to read.
        }
        if (!/\.(js|cjs)$/.test(entry)) continue; // Resolved to ESM; not the hazard.

        const source = readFileSync(entry, 'utf8');
        if (source.includes('__esModule') && /exports\.default\s*=/.test(source)) {
          offenders.push(
            `${file.slice(srcDir.length)}: \`import ${local} from '${specifier}'\`` +
              ' — import the named export instead',
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('pins a target and sourcemaps for the Tauri WebView build', () => {
    expect(viteConfig.build?.target).toBe('es2021');
    expect(viteConfig.build?.sourcemap).toBe(true);
  });

  it('serves the dev port Tauri is configured to wait on', () => {
    // tauri.conf.json hardcodes devUrl; a drift here hangs `tauri dev`.
    const tauri = readJson('../../src-tauri/tauri.conf.json') as {
      build: { devUrl: string; frontendDist: string };
    };
    expect(tauri.build.devUrl).toBe(`http://localhost:${viteConfig.server?.port}`);
    expect(viteConfig.server?.strictPort).toBe(true);
    // frontendDist is relative to src-tauri/, and build.outDir is Vite's default.
    expect(tauri.build.frontendDist).toBe('../dist');
    expect(viteConfig.build?.outDir).toBeUndefined();
  });
});

describe('installer.nsh drift guard', () => {
  it('keeps the hand-written ProgID and extension in sync with bundle.fileAssociations', () => {
    // src-tauri/installer.nsh hand-writes registry keys keyed to a ProgID and
    // an extension that must match what bundle.fileAssociations in
    // tauri.conf.json actually generates. If they drift, every key the NSIS
    // hooks write points at a ProgID Tauri never creates, silently
    // reintroducing "Folio missing from Open with" with no compile error and
    // no test (this is the 0.5.0 bug this file exists to guard against).
    const tauri = readJson('../../src-tauri/tauri.conf.json') as {
      bundle: { fileAssociations: { ext: string[]; name: string }[] };
    };
    const assoc = tauri.bundle.fileAssociations[0];

    const nsh = readFileSync(
      fileURLToPath(new URL('../../src-tauri/installer.nsh', import.meta.url)),
      'utf8',
    );

    const progIdMatch = nsh.match(/!define FOLIO_PROGID "([^"]+)"/);
    expect(progIdMatch, 'installer.nsh must define FOLIO_PROGID').not.toBeNull();
    expect(progIdMatch?.[1]).toBe(assoc.name);

    const extMatch = nsh.match(/Capabilities\\FileAssociations" "\.([^"]+)" "\$\{FOLIO_PROGID\}"/);
    expect(
      extMatch,
      'installer.nsh must register FOLIO_PROGID under Capabilities\\FileAssociations for the extension',
    ).not.toBeNull();
    expect(extMatch?.[1]).toBe(assoc.ext[0]);
  });
});
