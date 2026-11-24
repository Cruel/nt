// Regenerate the checked-in Windows icon from the canonical SVG.
// Run from any directory: node editor/scripts/generate-windows-icon.mjs
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const svg = await readFile(new URL('../branding/icon.svg', import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(
  sizes.map(async (size) => {
    if (size === 256) {
      return sharp(svg).resize(size, size).ensureAlpha().png().toBuffer();
    }
    // Standard 32-bit DIB entries for small shell/installer icons. The
    // pixel rows are bottom-up BGRA, followed by a 1-bit transparency mask.
    const rgba = await sharp(svg).resize(size, size).ensureAlpha().raw().toBuffer();
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const source = ((size - 1 - y) * size + x) * 4;
        const target = 40 + (y * size + x) * 4;
        dib[target] = rgba[source + 2];
        dib[target + 1] = rgba[source + 1];
        dib[target + 2] = rgba[source];
        dib[target + 3] = rgba[source + 3];
        if (rgba[source + 3] === 0) {
          dib[40 + size * size * 4 + y * maskStride + (x >> 3)] |= 0x80 >> (x % 8);
        }
      }
    }
    return dib;
  }),
);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(
  new URL('../branding/windows/icon.ico', import.meta.url),
  Buffer.concat([directory, ...images]),
);
