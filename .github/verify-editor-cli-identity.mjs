#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const pointerPath = path.resolve(
  process.argv[2] ?? 'editor/out/electron-builder/latest-artifact.json',
);
const cliPath = path.resolve(process.argv[3] ?? '');
if (!process.argv[3]) throw new Error('Pass the certified host CLI path.');
const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(pointer.stageRoot, 'stage-manifest.json'), 'utf8'));
const expectedPath = pointer.platform === 'windows' ? 'resources/bin/noveltea.exe' : 'resources/bin/noveltea';
const record = manifest.files.find((item) => item.path === expectedPath);
if (!record) throw new Error(`Stage manifest does not contain ${expectedPath}.`);
const actual = createHash('sha256').update(readFileSync(cliPath)).digest('hex');
if (record.sha256 !== actual) {
  throw new Error(`Editor CLI hash ${record.sha256} differs from certified host CLI ${actual}.`);
}
process.stdout.write(`Editor embeds the certified ${pointer.platform}-${pointer.architecture} CLI bytes.\n`);
