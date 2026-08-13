#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const directory = path.resolve(process.argv[2] ?? 'dist');
const tag = process.argv[3];
const listPath = process.argv[4];
if (!tag) throw new Error('Usage: verify-release-inventory.mjs <directory> <tag> [list-output].');

const names = readdirSync(directory)
  .filter((name) => statSync(path.join(directory, name)).isFile())
  .sort();
const present = new Set(names);
const required = new Set();
const requireFile = (name) => {
  if (!present.has(name)) throw new Error(`Required release asset is missing: ${name}`);
  required.add(name);
};

const expectedTemplateIds = new Set([
  'android-arm64-v8a-release',
  'android-x86_64-debug',
  'linux-x64-release',
  'macos-arm64-release',
  'web-wasm32-release',
  'web-wasm32-threads-release',
  'windows-x64-release',
]);
const descriptorNames = names.filter((name) => name.endsWith('.template.json'));
const actualTemplateIds = new Set(
  descriptorNames.map((name) => name.slice(0, -'.template.json'.length)),
);
if (
  actualTemplateIds.size !== expectedTemplateIds.size ||
  [...expectedTemplateIds].some((id) => !actualTemplateIds.has(id))
) {
  throw new Error(
    `Player template matrix mismatch. Expected ${[...expectedTemplateIds].sort().join(', ')}; found ${[...actualTemplateIds].sort().join(', ')}.`,
  );
}

for (const descriptorName of descriptorNames) {
  const descriptor = JSON.parse(readFileSync(path.join(directory, descriptorName), 'utf8'));
  if (
    descriptor.engineVersion !== tag ||
    descriptor.buildId !== `${tag}-${descriptor.templateId}`
  ) {
    throw new Error(`${descriptorName} does not belong to release ${tag}.`);
  }
  for (const name of [
    descriptorName,
    descriptor.artifacts.archive,
    descriptor.artifacts.symbols,
    `${descriptor.templateId}.SBOM.cdx.json`,
    `${descriptor.templateId}.THIRD_PARTY_NOTICES.txt`,
  ]) {
    requireFile(name);
  }
  const reports = names.filter((name) => name.startsWith('noveltea-platform-certification-'));
  const matches = reports.filter((name) => {
    const report = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    return (
      report.template?.templateId === descriptor.templateId &&
      report.template?.buildId === descriptor.buildId
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `${descriptor.templateId}@${descriptor.buildId} requires exactly one certification report; found ${matches.length}.`,
    );
  }
  const reportName = matches[0];
  requireFile(reportName);
  requireFile(`noveltea-certification-results-${descriptor.templateId}.json`);
  const report = JSON.parse(readFileSync(path.join(directory, reportName), 'utf8'));
  for (const evidence of report.evidence ?? []) {
    if (path.basename(evidence.artifact) !== evidence.artifact) {
      throw new Error(
        `${reportName} references non-top-level certification evidence '${evidence.artifact}'.`,
      );
    }
    requireFile(evidence.artifact);
  }
}

for (const name of [
  `noveltea-${tag}-linux-x64`,
  `noveltea-${tag}-windows-x64.exe`,
  `noveltea-editor-${tag}-linux-x64-release.AppImage`,
  `noveltea-editor-${tag}-linux-x64-release.deb`,
  `noveltea-editor-${tag}-linux-x64-release.rpm`,
  `noveltea-editor-${tag}-windows-x64-release.setup.exe`,
  'noveltea-player-template-registry.json',
]) {
  requireFile(name);
}
if (present.has('SHA256SUMS')) required.add('SHA256SUMS');

for (const name of names) {
  const certificationArtifact =
    name.startsWith('noveltea-platform-certification-') ||
    name.startsWith('noveltea-certification-results-') ||
    name.startsWith('noveltea-certification-evidence-');
  if (
    (certificationArtifact ||
      /^(?:noveltea-(?:editor|player-template|player-symbols)-|noveltea-v.*-(?:linux|windows|macos)-)/.test(
        name,
      )) &&
    !required.has(name)
  ) {
    throw new Error(`Unexpected release artifact: ${name}`);
  }
}

if (listPath) writeFileSync(listPath, `${names.join('\n')}\n`);
process.stdout.write(`Verified ${names.length} files and the complete required release matrix.\n`);
