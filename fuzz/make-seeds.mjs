// Regenerates the small committed seeds in fuzz/corpus/<target>/ from real
// inputs: the .p12 fixtures the signing tests use, a .p12 and a signed PDF made
// by the app's own code, and content streams as pdf-lib writes them.
//   node fuzz/make-seeds.mjs
// Not run in CI. The seeds are committed, so this only needs re-running when a
// format the targets read changes.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from './bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const outDir = path.join(root, 'out/fuzz-seeds');
rmSync(outDir, { recursive: true, force: true });
await bundle(['fuzz/seedgen.ts'], 'out/fuzz-seeds');
const gen = require(path.join(outDir, 'seedgen.cjs'));

const corpus = (name) => {
  const dir = path.join(root, 'fuzz/corpus', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};
const write = (dir, file, bytes) => writeFileSync(path.join(dir, file), bytes);

// p12: one passphrase-selector byte (see fuzz/targets/p12.fuzz.ts), then the file.
const p12 = corpus('p12');
const fixtures = path.join(root, 'src/features/signing/__fixtures__');
const selector = { 'legacy-node-forge-aes-latin1.p12': 2 };
for (const f of readdirSync(fixtures).filter((n) => n.endsWith('.p12'))) {
  write(
    p12,
    f,
    Buffer.concat([Buffer.from([selector[f] ?? 1]), readFileSync(path.join(fixtures, f))]),
  );
}
const generated = await gen.generatedP12();
write(p12, 'generated-pw.p12', Buffer.concat([Buffer.from([0]), generated]));

// signatures: a real signed PDF, and the same bytes with the tail appended to.
const signed = await gen.signedPdf(generated);
const sigs = corpus('signatures');
write(sigs, 'signed.pdf', signed);
write(sigs, 'signed-appended.pdf', Buffer.concat([signed, Buffer.from('\n%%EOF\nappended\n')]));
write(
  sigs,
  'byterange-only.txt',
  Buffer.from('/ByteRange [0 10 20 30]/Contents <3082>/M (D:20260101000000)'),
);

// combine-pdf: the unsigned and the signed tiny documents.
const combine = corpus('combine-pdf');
write(combine, 'tiny.pdf', await gen.tinyPdf());
write(combine, 'signed.pdf', signed);

// content-stream: selector byte (stream count), then a stream.
const cs = corpus('content-stream');
for (const [name, text] of Object.entries(gen.contentStreams)) {
  write(cs, `${name}.txt`, Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]));
}
write(
  cs,
  'form-do.txt',
  Buffer.concat([
    Buffer.from([1]),
    Buffer.from(gen.contentStreams.text, 'latin1'),
    Buffer.from(gen.contentStreams.form, 'latin1'),
  ]),
);

// addresses: text as extracted from a page.
const addr = corpus('addresses');
write(addr, 'mixed.txt', Buffer.from(gen.addressText, 'utf8'));

for (const t of ['p12', 'signatures', 'combine-pdf', 'content-stream', 'addresses']) {
  const dir = path.join(root, 'fuzz/corpus', t);
  const sizes = readdirSync(dir).map((n) => readFileSync(path.join(dir, n)).length);
  console.log(`${t}: ${sizes.length} seeds, largest ${Math.max(...sizes)} bytes`);
}
