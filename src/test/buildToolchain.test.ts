// @vitest-environment node
import { readFileSync } from 'node:fs';
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
