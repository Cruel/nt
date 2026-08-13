#!/usr/bin/env node

import process from 'node:process';

import { readNovelTeaVersion } from '../scripts/noveltea-version.mjs';

const { version, releaseTag } = readNovelTeaVersion();
const suppliedTag = process.argv[2]?.trim();

if (suppliedTag && suppliedTag !== releaseTag) {
  throw new Error(
    `Release tag '${suppliedTag}' does not match VERSION '${version}'; expected '${releaseTag}'.`,
  );
}

process.stderr.write(
  suppliedTag
    ? `${suppliedTag} matches canonical NovelTea version ${version}.\n`
    : `Canonical NovelTea release tag is ${releaseTag}.\n`,
);
process.stdout.write(`${releaseTag}\n`);
