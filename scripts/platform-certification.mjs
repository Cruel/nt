#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FORMAT = 'noveltea-platform-certification';
const RESULTS_FORMAT = 'noveltea-platform-certification-results';
const VERSION = 1;
const FIXTURE_ID = 'platform-export-acceptance';
const universalChecks = [
  'artifact-claims', 'descriptor-file-roles', 'runtime-closure', 'grouped-transaction-rollback',
  'fixture-launch', 'input', 'rendering', 'rmlui', 'lua', 'fonts', 'images', 'audio', 'navigation',
  'save-reload', 'clean-shutdown', 'fatal-startup-diagnostics', 'compatible-update',
  'incompatible-api-rejected', 'debug-release-separation', 'development-surfaces-absent',
  'symbols-build-id', 'third-party-notices', 'sbom', 'reproducibility',
];
const targetChecks = {
  web: ['web-root-path', 'web-subdirectory-path', 'web-persistence', 'web-two-games-one-origin', 'web-service-worker-update'],
  windows: ['windows-native-launch', 'windows-dependency-closure', 'windows-resource-metadata', 'windows-authenticode-policy'],
  linux: ['linux-x11-launch', 'linux-wayland-launch', 'linux-dependency-closure', 'linux-rpath', 'linux-desktop-integration', 'linux-appimage-launch'],
  macos: ['macos-launchservices-launch', 'macos-install-name-closure', 'macos-entitlements', 'macos-privacy-strings', 'macos-signing-policy'],
  android: ['android-system-assets', 'android-install-launch', 'android-abi-closure', 'android-signature-policy', 'android-page-alignment'],
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function args(argv) {
  const result = { subcommand: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument '${key}'.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for '${key}'.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

const hash = (data) => createHash('sha256').update(data).digest('hex');
const fileHash = async (file) => hash(await readFile(file));

async function run(command, commandArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)));
  });
}

async function descriptorFromArchive(archive) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-certification-'));
  try {
    await run('cmake', ['-E', 'tar', 'xf', path.resolve(archive)], { cwd: root });
    const pending = [''];
    while (pending.length) {
      const relative = pending.shift();
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile() && entry.name === 'template.json') {
          const data = await readFile(path.join(root, child));
          return { descriptor: JSON.parse(data), descriptorSha256: hash(data) };
        }
      }
    }
    throw new Error(`Archive '${archive}' does not contain template.json.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectedArtifactFormats(descriptor) {
  if (descriptor.platform === 'android') return descriptor.android?.artifactKinds ?? [];
  if (descriptor.platform === 'web') return ['directory', 'zip'];
  if (descriptor.platform === 'macos') return ['app-bundle', 'zip', 'dmg'];
  if (descriptor.platform === 'linux') return ['directory', 'tar.gz', 'appimage'];
  return ['directory', 'zip'];
}

function validate(descriptor, report) {
  const errors = [];
  const requireEqual = (label, actual, expected) => {
    if (actual !== expected) errors.push(`${label}: expected '${expected}', got '${actual}'.`);
  };
  requireEqual('format', report.format, FORMAT);
  requireEqual('formatVersion', report.formatVersion, VERSION);
  requireEqual('fixture.id', report.fixture?.id, FIXTURE_ID);
  for (const field of ['templateId', 'buildId']) requireEqual(`template.${field}`, report.template?.[field], descriptor[field]);
  requireEqual('template.target', report.template?.target, descriptor.platform);
  requireEqual('template.architecture', report.template?.architecture, descriptor.architecture);
  requireEqual('template.buildFlavor', report.template?.buildFlavor, descriptor.buildFlavor);
  requireEqual('environment.target', report.environment?.target, descriptor.platform);
  for (const field of ['sourceRevision']) if (!report.template?.[field]) errors.push(`template.${field} is required.`);
  for (const field of ['revision', 'sha256', 'runtimePackageSha256', 'profileSha256']) {
    if (!report.fixture?.[field]) errors.push(`fixture.${field} is required.`);
  }
  for (const field of ['workflow', 'runId', 'job', 'runnerOs', 'runnerArch', 'target']) {
    if (!report.environment?.[field]) errors.push(`environment.${field} is required.`);
  }
  const exercised = report.exercised ?? {};
  const contains = (field, value) => Array.isArray(exercised[field]) && exercised[field].includes(value);
  for (let api = descriptor.runtimePackageApi.minimum; api <= descriptor.runtimePackageApi.maximum; api += 1) if (!contains('packageApis', api)) errors.push(`Package API ${api} was not exercised.`);
  for (let api = descriptor.playerConfigApi.minimum; api <= descriptor.playerConfigApi.maximum; api += 1) if (!contains('playerConfigApis', api)) errors.push(`Player config API ${api} was not exercised.`);
  for (const [field, values] of [
    ['capabilities', descriptor.capabilities], ['graphicsBackends', descriptor.graphicsBackends],
    ['shaderVariants', descriptor.shaderVariants], ['compiledFeatures', descriptor.compiledFeatures],
    ['packageAccessModes', descriptor.packageAccessModes], ['artifactFormats', expectedArtifactFormats(descriptor)],
  ]) for (const value of values ?? []) if (!contains(field, value)) errors.push(`${field} '${value}' was not exercised.`);
  const evidenceItems = report.evidence ?? [];
  const evidence = new Map();
  const artifactOwners = new Map();
  for (const item of evidenceItems) {
    if (evidence.has(item.check)) errors.push(`Duplicate evidence for '${item.check}'.`);
    evidence.set(item.check, item);
    if (item.artifact) {
      const owner = artifactOwners.get(item.artifact);
      if (owner && owner !== item.check) errors.push(`Evidence artifact '${item.artifact}' is reused by unrelated checks '${owner}' and '${item.check}'.`);
      artifactOwners.set(item.artifact, item.check);
    }
    if (item.target !== descriptor.platform) errors.push(`Evidence '${item.check}' targets '${item.target}', expected '${descriptor.platform}'.`);
    if (item.environment?.target !== descriptor.platform) errors.push(`Evidence '${item.check}' environment targets '${item.environment?.target}', expected '${descriptor.platform}'.`);
    for (const field of ['workflow', 'runId', 'job', 'runnerOs', 'runnerArch', 'target']) {
      if (item.environment?.[field] !== report.environment?.[field]) errors.push(`Evidence '${item.check}' environment.${field} does not match the report environment.`);
    }
    if (!item.test) errors.push(`Evidence '${item.check}' does not identify its exact test or verifier.`);
    if (!item.environment?.workflow || !item.environment?.runId || !item.environment?.job || !item.environment?.runnerOs || !item.environment?.runnerArch) {
      errors.push(`Evidence '${item.check}' does not identify a complete target environment.`);
    }
  }
  for (const check of new Set([...universalChecks, ...(targetChecks[descriptor.platform] ?? []), `${descriptor.platform}-system-assets`])) {
    const item = evidence.get(check);
    if (!item) errors.push(`Missing evidence '${check}'.`);
    else if (item.status !== 'passed') errors.push(`Evidence '${check}' is ${item.status}.`);
    else if (!item.producer || !item.command || !item.test || !item.artifact || !item.artifactSha256) errors.push(`Evidence '${check}' is not bound to a test, producer, command, and hashed artifact.`);
  }
  if ((report.hostGaps ?? []).length) errors.push(`Certification contains host gaps: ${report.hostGaps.map((item) => item.check).join(', ')}.`);
  return errors;
}

async function create(options) {
  for (const name of ['archive', 'fixture', 'results', 'output', 'source-revision']) if (!options[name]) throw new Error(`create requires --${name}.`);
  const archive = path.resolve(options.archive);
  const fixture = path.resolve(options.fixture);
  const outputPath = path.resolve(options.output);
  const evidenceInput = JSON.parse(await readFile(path.resolve(options.results), 'utf8'));
  if (evidenceInput.format !== RESULTS_FORMAT || evidenceInput.formatVersion !== VERSION) {
    throw new Error(`Results input must use ${RESULTS_FORMAT} version ${VERSION}.`);
  }
  if (!Array.isArray(evidenceInput.evidence) || evidenceInput.evidence.length === 0) {
    throw new Error('Results input must contain explicit per-check evidence records.');
  }
  for (const field of ['fixtureRevision', 'runtimePackageSha256', 'profileSha256', 'environment', 'exercised']) {
    if (!evidenceInput[field]) throw new Error(`Results input requires '${field}'.`);
  }
  const { descriptor, descriptorSha256 } = await descriptorFromArchive(archive);
  const evidence = [];
  for (const item of evidenceInput.evidence) {
    const artifact = path.resolve(item.artifact);
    if (!(await stat(artifact)).isFile()) throw new Error(`Evidence artifact '${artifact}' is not a file.`);
    evidence.push({
      ...item,
      artifact: path.relative(path.dirname(outputPath), artifact).split(path.sep).join('/'),
      artifactSha256: await fileHash(artifact),
    });
  }
  const report = {
    format: FORMAT,
    formatVersion: VERSION,
    generatedAt: new Date().toISOString(),
    template: {
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      target: descriptor.platform,
      architecture: descriptor.architecture,
      buildFlavor: descriptor.buildFlavor,
      descriptorSha256,
      archiveSha256: await fileHash(archive),
      sourceRevision: options['source-revision'],
    },
    fixture: {
      id: FIXTURE_ID,
      revision: evidenceInput.fixtureRevision,
      sha256: await fileHash(fixture),
      runtimePackageSha256: evidenceInput.runtimePackageSha256,
      profileSha256: evidenceInput.profileSha256,
    },
    environment: evidenceInput.environment,
    exercised: evidenceInput.exercised,
    evidence,
    hostGaps: evidenceInput.hostGaps ?? [],
  };
  const errors = validate(descriptor, report);
  if (errors.length) throw new Error(`Certification report is incomplete:\n- ${errors.join('\n- ')}`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function verify(options) {
  for (const name of ['archive', 'report']) if (!options[name]) throw new Error(`verify requires --${name}.`);
  const archive = path.resolve(options.archive);
  const reportPath = path.resolve(options.report);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const { descriptor, descriptorSha256 } = await descriptorFromArchive(archive);
  const errors = validate(descriptor, report);
  if (report.template?.descriptorSha256 !== descriptorSha256) errors.push('Descriptor SHA-256 does not match the template archive.');
  if (report.template?.archiveSha256 !== await fileHash(archive)) errors.push('Archive SHA-256 does not match the certified template archive.');
  for (const item of report.evidence ?? []) {
    if (!item.artifact || !item.artifactSha256) continue;
    const artifact = path.resolve(path.dirname(reportPath), item.artifact);
    try {
      if (await fileHash(artifact) !== item.artifactSha256) errors.push(`Evidence artifact hash mismatch for '${item.check}'.`);
    } catch {
      errors.push(`Evidence artifact is missing for '${item.check}': ${item.artifact}.`);
    }
  }
  if (errors.length) throw new Error(`Certification verification failed:\n- ${errors.join('\n- ')}`);
}

async function verifySet(options) {
  if (!options.directory) throw new Error('verify-set requires --directory.');
  const directory = path.resolve(options.directory);
  const names = await readdir(directory);
  const archives = names.filter((name) => /^noveltea-player-template-.*\.(?:zip|tar\.gz)$/.test(name));
  if (!archives.length) throw new Error(`No player template archives were found in '${directory}'.`);
  const reports = names.filter((name) => /^noveltea-platform-certification-.*\.json$/.test(name));
  const used = new Set();
  for (const archiveName of archives) {
    const archive = path.join(directory, archiveName);
    const { descriptor } = await descriptorFromArchive(archive);
    const candidates = [];
    for (const reportName of reports) {
      const report = JSON.parse(await readFile(path.join(directory, reportName), 'utf8'));
      if (report.template?.templateId === descriptor.templateId && report.template?.buildId === descriptor.buildId) candidates.push({ reportName, report });
    }
    if (candidates.length !== 1) throw new Error(`Template ${descriptor.templateId}@${descriptor.buildId} requires exactly one certification report; found ${candidates.length}.`);
    used.add(candidates[0].reportName);
    await verify({ archive, report: path.join(directory, candidates[0].reportName) });
  }
  const unused = reports.filter((name) => !used.has(name));
  if (unused.length) throw new Error(`Certification reports do not match a published template: ${unused.join(', ')}.`);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.subcommand === 'create') await create(options);
  else if (options.subcommand === 'verify') await verify(options);
  else if (options.subcommand === 'verify-set') await verifySet(options);
  else throw new Error('Usage: platform-certification.mjs <create|verify|verify-set> ...');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
