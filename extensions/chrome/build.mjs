// Stage the Folio Chrome extension: build the Folio web app with relative asset
// paths and copy it into dist/ as the in-browser viewer, and copy the icon.
//
//   node extensions/chrome/build.mjs
//
// Then load extensions/chrome as an unpacked extension at chrome://extensions.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const dist = resolve(here, 'dist');
const icons = resolve(here, 'icons');

// Relative base so the built index.html references ./assets/... which resolve
// under chrome-extension://<id>/dist/ (an absolute /assets/ would 404).
console.log('Building Folio web app (relative base) ...');
execSync('npm run build -- --base=./', { cwd: repo, stdio: 'inherit' });

console.log('Staging viewer into extensions/chrome/dist ...');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(resolve(repo, 'dist'), dist, { recursive: true });

mkdirSync(icons, { recursive: true });
cpSync(resolve(repo, 'src-tauri', 'icons', '128x128.png'), resolve(icons, 'icon-128.png'));

console.log('Done. Load extensions/chrome as an unpacked extension in chrome://extensions.');
