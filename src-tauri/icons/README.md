# App icons

Tauri embeds these icons into the compiled binary, so the referenced files in
[`tauri.conf.json`](../tauri.conf.json) (`32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.icns`, `icon.ico`) must exist for `tauri dev` and
`tauri build` to compile.

## Regenerating

The full icon set is generated from a single square source image (1024x1024 PNG
or an SVG) using the Tauri CLI:

```bash
npm run tauri icon path/to/source.png
```

That command writes every platform icon into this directory. The source used for
the placeholder set is [`folio-logo.svg`](../../src/assets/folio-logo.svg).
Replace it with final artwork and re-run the command.
