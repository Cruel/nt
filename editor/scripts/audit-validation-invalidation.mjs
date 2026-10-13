#!/usr/bin/env node
// Differential performance/correctness audit of the real headless CLI.
// Runs exclusively in a disposable Project copy; never edits the supplied Project.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
const project = option('--project');
const cli = option('--cli');
if (!project || !cli) {
  console.error(
    'Usage: node editor/scripts/audit-validation-invalidation.mjs --project <directory> --cli <noveltea> [--cases a,b] [--parity a,b] [--output <json>]',
  );
  process.exit(2);
}
const sourceRoot = path.resolve(project);
const executable = path.resolve(cli);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'noveltea-validation-audit-'));
const root = path.join(scratch, 'project');
const output = option('--output');
const requested = new Set((option('--cases') ?? '').split(',').filter(Boolean));
const parity = new Set((option('--parity') ?? '').split(',').filter(Boolean));
const firstFile = (dir, extension) => {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return null;
  return (
    readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name))
      .sort()[0] ?? null
  );
};
const firstLayoutSource = (extension) => {
  const layouts = path.join(root, 'records', 'layouts');
  if (!existsSync(layouts)) return null;
  for (const entry of readdirSync(layouts).sort()) {
    const relative = `records/layouts/${entry}/layout.${extension}`;
    if (existsSync(path.join(root, relative))) return relative;
  }
  return null;
};
const json = (change) => (original, attempt) => {
  const document = JSON.parse(original);
  change(document, attempt);
  return `${JSON.stringify(document, null, 2)}\n`;
};
const yaml = (change) => (original, attempt) => {
  const document = parseYaml(original);
  change(document, attempt);
  return stringifyYaml(document);
};
const whitespace = (original, attempt) => `${original.trimEnd()}\n${' '.repeat(attempt)}\n`;
const comment = (syntax) => (original, attempt) =>
  `${original}\n${syntax === 'xml' ? `<!-- audit ${attempt} -->` : syntax === 'css' ? `/* audit ${attempt} */` : syntax === 'lua' ? `-- audit ${attempt}` : `// audit ${attempt}`}\n`;
const cases = [];
const add = (name, relativePath, mutation, binary = false) => {
  if (relativePath && (requested.size === 0 || requested.has(name)))
    cases.push({ name, relativePath, mutation, binary });
};

let results = [];
function validate(label, cold = false) {
  if (cold) rmSync(path.join(root, '.noveltea/cache/authoring/current.json'), { force: true });
  const start = performance.now();
  const proc = spawnSync(
    executable,
    ['--project', root, '--json', ...(cold ? ['--no-daemon'] : []), 'validate'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NOVELTEA_CLI_VALIDATION_PROFILE: '1',
        ...(cold ? { NOVELTEA_EXPORT_PROFILE: '1' } : {}),
      },
    },
  );
  const durationMs = Math.round(performance.now() - start);
  if (proc.error || proc.signal) throw new Error(`${label}: ${proc.error ?? proc.signal}`);
  let result;
  try {
    result = JSON.parse(proc.stdout);
  } catch {
    throw new Error(
      `${label}: CLI did not return JSON (exit ${proc.status}): ${proc.stderr.slice(-600)}`,
    );
  }
  const metricsLine = proc.stderr
    .split('\n')
    .find((line) => line.startsWith('[validation-profile] '));
  const metrics = metricsLine
    ? JSON.parse(metricsLine.slice('[validation-profile] '.length))
    : null;
  const trace = proc.stderr
    .split('\n')
    .filter((line) => line.startsWith('[validation-invalidation] '))
    .map((line) => JSON.parse(line.slice('[validation-invalidation] '.length)));
  return {
    exitCode: proc.status,
    durationMs,
    diagnostics: result.diagnostics ?? [],
    metrics,
    trace,
  };
}
const diagnosticSet = (entry) =>
  JSON.stringify(
    [...entry.diagnostics].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

try {
  cpSync(sourceRoot, root, { recursive: true, dereference: false });
  rmSync(path.join(root, '.noveltea/cache/authoring/current.json'), { force: true });
  add('lua', firstFile('scripts', '.lua'), comment('lua'));
  add(
    'lua-named-message',
    firstFile('scripts', '.lua'),
    (text, attempt) => `${text}\nText.msg("audit.missing.${attempt}")\n`,
  );
  add('missing-lua', firstFile('scripts', '.lua'), (text, attempt) =>
    attempt === 1 ? comment('lua')(text, attempt) : null,
  );
  add('rml', firstLayoutSource('rml'), comment('xml'));
  add('missing-rml', firstLayoutSource('rml'), (text, attempt) =>
    attempt === 1 ? comment('xml')(text, attempt) : null,
  );
  add('rcss', firstLayoutSource('rcss'), comment('css'));
  add('layout-lua', firstLayoutSource('lua'), comment('lua'));
  add('shader', firstFile('shaders', '.sc'), comment('shader'));
  add(
    'project-name',
    'project.yaml',
    yaml((x, n) => {
      x.project.name += ` audit-${n}`;
    }),
  );
  add('project-whitespace', 'project.yaml', whitespace);
  add('editor-whitespace', 'editor.yaml', whitespace);
  add('traits-whitespace', 'traits.yaml', whitespace);
  for (const collection of [
    'assets',
    'animations',
    'variables',
    'materials',
    'archetypes',
    'characters',
    'rooms',
    'interactables',
    'verbs',
    'interactions',
    'dialogues',
    'scenes',
    'maps',
    'scripts',
    'tests',
  ]) {
    const file = firstFile(`records/${collection}`, '.json');
    add(
      `record-${collection}`,
      file,
      json((x, n) => {
        x.label += ` audit-${n}`;
      }),
    );
  }
  add('record-rooms-whitespace', firstFile('records/rooms', '.json'), whitespace);
  add('record-assets-whitespace', firstFile('records/assets', '.json'), whitespace);
  add('missing-room', firstFile('records/rooms', '.json'), (text, attempt) =>
    attempt === 1 ? whitespace(text, attempt) : null,
  );
  const assetRecords = path.join(root, 'records/assets');
  if (existsSync(assetRecords)) {
    const byKind = new Map();
    for (const file of readdirSync(assetRecords)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const asset = JSON.parse(readFileSync(path.join(assetRecords, file), 'utf8')).data;
      const source = asset?.source?.path;
      if (
        !byKind.has(asset.kind) &&
        typeof source === 'string' &&
        !path.isAbsolute(source) &&
        !source.split('/').includes('..') &&
        existsSync(path.join(root, source))
      )
        byKind.set(asset.kind, source);
    }
    for (const [kind, source] of byKind)
      add(
        `asset-bytes-${kind}`,
        source,
        (original, attempt) =>
          Buffer.concat([original, Buffer.from(`\nvalidation-audit-${attempt}\n`)]),
        true,
      );
    if (byKind.has('font'))
      add(
        'missing-font',
        byKind.get('font'),
        (original, attempt) =>
          attempt === 1 ? Buffer.concat([original, Buffer.from('audit')]) : null,
        true,
      );
  }
  const layoutDirs = path.join(root, 'records/layouts');
  if (existsSync(layoutDirs)) {
    const file = readdirSync(layoutDirs)
      .sort()
      .map((dir) => `records/layouts/${dir}/layout.json`)
      .find((f) => existsSync(path.join(root, f)));
    add(
      'record-layouts',
      file,
      json((x, n) => {
        x.label += ` audit-${n}`;
      }),
    );
  }
  add('i18n-policy', 'i18n/project.json', whitespace);
  add('i18n-translations', firstFile('i18n/locales', '.json'), whitespace);
  add('i18n-assets', firstFile('i18n/assets', '.json'), whitespace);
  add('i18n-tracking', 'i18n/tracking.json', whitespace);
  add('i18n-orphans', 'i18n/orphans.json', whitespace);
  add('i18n-usage-notes', 'i18n/usage-notes.json', whitespace);
  add(
    'i18n-messages',
    'i18n/messages.json',
    json((x, n) => {
      const message = Object.values(x.messages).find((value) => typeof value.source === 'string');
      if (!message) throw new Error('No Message source in fixture');
      message.source += ` audit-${n}`;
    }),
  );
  const missingRequested = [...requested].filter(
    (name) => !cases.some((item) => item.name === name),
  );
  if (missingRequested.length > 0)
    throw new Error(`Missing selected cases: ${missingRequested.join(', ')}`);

  const baseline = validate('baseline');
  console.log(`Baseline: ${baseline.durationMs} ms; ${cases.length} scenarios`);
  for (const item of cases) {
    const file = path.join(root, item.relativePath);
    const original = readFileSync(file, item.binary ? undefined : 'utf8');
    const apply = (content) => {
      if (content === null) rmSync(file, { force: true });
      else writeFileSync(file, content);
    };
    try {
      apply(item.mutation(original, 1));
      validate(`${item.name}-first`);
      apply(item.mutation(original, 2));
      const warm = validate(`${item.name}-second`);
      const cold = parity.has(item.name) ? validate(`${item.name}-cold`, true) : null;
      const equal = cold ? diagnosticSet(warm) === diagnosticSet(cold) : null;
      const m = warm.metrics;
      const row = {
        case: item.name,
        source: item.relativePath,
        warmMs: warm.durationMs,
        admissionMs: m?.workspaceAdmissionMs,
        checks: m?.validationWork.executed,
        topChecks: m?.validationWork.checkFamilyMs?.slice(0, 5),
        graphMs: m?.dependencyMs,
        graphContributions: m?.dependencyWork.derivedContributions,
        graphSourceOwners: m?.dependencyWork.analyzedOwners,
        fontPreparationMs: m?.fontCoveragePreparationMs,
        fontNativeMs: m?.fontCoverageNativeMs,
        shaderPreparationMs: m?.shaderPreparationMs,
        shaderNativeMs: m?.shaderNativeMs,
        shaderReflectionMs: m?.shaderReflectionMs,
        validationStageCacheReadMs: m?.validationStageCacheReadMs,
        fontRevisionProofMs: m?.fontRevisionProofMs,
        shaderRevisionProofMs: m?.shaderRevisionProofMs,
        shaderOutputProofMs: m?.shaderOutputProofMs,
        noticeMs: m?.distributionNoticeMs,
        trace: warm.trace,
        parity: equal,
        warmExitCode: warm.exitCode,
        coldExitCode: cold?.exitCode,
        coldMs: cold?.durationMs,
        ...(equal === false
          ? {
              warmDiagnostics: warm.diagnostics,
              coldDiagnostics: cold.diagnostics,
            }
          : {}),
      };
      results.push(row);
      console.log(JSON.stringify(row));
      if (equal === false) process.exitCode = 1;
    } finally {
      apply(original);
      validate(`${item.name}-restore`);
    }
  }
} finally {
  if (output) writeFileSync(path.resolve(output), `${JSON.stringify(results, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
}
