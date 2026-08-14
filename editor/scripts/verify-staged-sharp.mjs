import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const appRoot = process.argv[2];
if (!appRoot) throw new Error('Usage: node verify-staged-sharp.mjs <app-root>');

const appRequire = createRequire(path.join(appRoot, 'package.json'));
const sharp = appRequire('sharp');

const encoded = await sharp({
  create: {
    width: 3,
    height: 2,
    channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 1 },
  },
})
  .png()
  .toBuffer();

const metadata = await sharp(encoded).metadata();
if (metadata.format !== 'png' || metadata.width !== 3 || metadata.height !== 2) {
  throw new Error('The staged sharp encode/decode verification returned unexpected metadata.');
}
