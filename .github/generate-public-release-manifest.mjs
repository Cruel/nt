#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RELEASE_REPOSITORY = 'Cruel/noveltea-releases';

export function createPublicReleaseManifest(directory, tag, sourceRevision) {
  if (!tag) throw new Error('Release tag is required.');
  if (!sourceRevision) throw new Error('Source revision is required.');

  const asset = (file, options) => {
    const absolutePath = path.join(directory, file);
    const bytes = readFileSync(absolutePath);
    return {
      ...options,
      file,
      size: statSync(absolutePath).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
    };
  };

  return {
    format: 'noveltea.public-release',
    version: 1,
    release: {
      tag,
      sourceRevision,
      repository: RELEASE_REPOSITORY,
    },
    editor: [
      asset(`noveltea-editor-${tag}-windows-x64-release.setup.exe`, {
        platform: 'windows',
        arch: 'x64',
        format: 'installer',
        label: 'Windows installer',
        primary: true,
      }),
      asset(`noveltea-editor-${tag}-linux-x64-release.AppImage`, {
        platform: 'linux',
        arch: 'x64',
        format: 'appimage',
        label: 'Linux AppImage',
        primary: true,
      }),
      asset(`noveltea-editor-${tag}-linux-x64-release.deb`, {
        platform: 'linux',
        arch: 'x64',
        format: 'deb',
        label: 'Linux .deb',
        primary: false,
      }),
      asset(`noveltea-editor-${tag}-linux-x64-release.rpm`, {
        platform: 'linux',
        arch: 'x64',
        format: 'rpm',
        label: 'Linux .rpm',
        primary: false,
      }),
    ],
    cli: [
      asset(`noveltea-${tag}-windows-x64.exe`, {
        platform: 'windows',
        arch: 'x64',
        format: 'executable',
        label: 'Windows x64',
        primary: true,
      }),
      asset(`noveltea-${tag}-linux-x64`, {
        platform: 'linux',
        arch: 'x64',
        format: 'executable',
        label: 'Linux x64',
        primary: true,
      }),
    ],
  };
}

function main() {
  const [directoryArg = 'dist', tag, sourceRevision, outputArg = 'noveltea-release-manifest.json'] = process.argv.slice(2);
  if (!tag || !sourceRevision) {
    throw new Error(
      'Usage: generate-public-release-manifest.mjs <directory> <tag> <source-revision> [output].',
    );
  }
  const directory = path.resolve(directoryArg);
  const output = path.isAbsolute(outputArg) ? outputArg : path.join(directory, outputArg);
  writeFileSync(output, `${JSON.stringify(createPublicReleaseManifest(directory, tag, sourceRevision), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
