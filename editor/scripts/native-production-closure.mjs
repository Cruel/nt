import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// These modules implement the superseded Project authority, not transient UI
// parsing or build-time schema generation. #521 must reconcile this inventory
// whenever it splits an old mixed-purpose module before deleting it.
const retiredAuthority = new Set([
  'src/shared/project-workspace/project-workspace-service.ts',
  'src/shared/project-workspace/node-project-workspace-service.ts',
  'src/shared/project-workspace/resident-project-workspace-session.ts',
  'src/shared/project-workspace/resident-project-workspace-service.ts',
  'src/shared/project-workspace/project-workspace-source-codec.ts',
  'src/shared/project-workspace/project-workspace-transaction.ts',
  'src/shared/project-workspace-watch.ts',
  'src/shared/authoring-dependency-graph.ts',
  'src/shared/authoring-source-analysis.ts',
  'src/shared/authoring-cache.ts',
  'src/shared/project-schema/authoring-validation.ts',
  'src/shared/project-schema/authoring-validation-contributions.ts',
  'src/shared/project-schema/project-validation.ts',
  'src/main/services/project-workspace-watcher-service.ts',
  'src/cli/semantic-project.ts',
  'src/cli/fmt-command.ts',
  'src/cli/project-bundle-cli.ts',
]);

const bundledExtensions = new Set(['.js', '.mjs', '.cjs']);

function isPureForwarder(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every(
      (line) =>
        /^import\s+(?:(?:[^;]*\s+from\s+)?["'][^"']+["'])\s*;?$/.test(line) ||
        /^export\s+(?:\{[^}]*\}|\*\s+from\s+["'][^"']+["'])\s*;?$/.test(line),
    );
}

function sourceModule(specifier) {
  const normalized = specifier.replaceAll('\\', '/');
  // Source maps may contain ../../src/... or absolute checkout paths; only
  // source modules under an editor/src root are compared with the inventory.
  const index = normalized.lastIndexOf('/src/');
  return index >= 0
    ? normalized.slice(index + 1)
    : normalized.startsWith('src/')
      ? normalized
      : null;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile() && bundledExtensions.has(path.extname(target))) files.push(target);
  }
  return files;
}

/**
 * Verify the emitted module closure, not just the checked-in source tree.
 * Every emitted JS chunk is inspected, including lazy chunks used only on
 * static-cache misses or disposable heavy jobs. A missing build or missing
 * provenance is an error rather than an implied clean native build.
 */
export async function verifyNativeProductionClosure(artifactRoots) {
  const violations = [];
  for (const root of artifactRoots) {
    let files;
    try {
      files = await walk(root);
    } catch (error) {
      violations.push(`missing production output ${root}: ${error.message}`);
      continue;
    }
    if (files.length === 0) {
      violations.push(`missing production output JS chunks in ${root}`);
      continue;
    }
    let manifest = null;
    try {
      manifest = JSON.parse(
        await readFile(path.join(root, 'native-production-provenance.json'), 'utf8'),
      );
      if (manifest.version !== 1 || !manifest.chunks || Array.isArray(manifest.chunks))
        throw new Error('unsupported production module manifest');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        violations.push(`invalid production module manifest in ${root}: ${error.message}`);
        continue;
      }
    }
    const emitted = new Set(
      files.map((file) => path.relative(root, file).split(path.sep).join('/')),
    );
    if (manifest)
      for (const name of Object.keys(manifest.chunks))
        if (!emitted.has(name)) violations.push(`stale manifest entry ${name} in ${root}`);
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      const text = await readFile(file, 'utf8');
      if (manifest) {
        const entry = manifest.chunks[relative];
        if (!entry) {
          violations.push(`missing manifest entry for ${relative}`);
          continue;
        }
        if (
          !Array.isArray(entry.modules) ||
          (entry.modules.length === 0 && !isPureForwarder(text)) ||
          entry.modules.some((item) => typeof item !== 'string') ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        ) {
          violations.push(`invalid manifest entry for ${relative}`);
          continue;
        }
        if (createHash('sha256').update(text).digest('hex') !== entry.sha256)
          violations.push(`hash mismatch for ${relative}; cannot trust emitted module provenance`);
        for (const source of entry.modules) {
          const module = sourceModule(source);
          if (module && retiredAuthority.has(module))
            violations.push(`${relative} includes retired Project authority ${module}`);
        }
        continue;
      }
      const sources = new Set(
        [...text.matchAll(/^\s*\/\/#region\s+([^\r\n]+)/gm)].map((match) => match[1]),
      );
      try {
        const map = JSON.parse(await readFile(`${file}.map`, 'utf8'));
        if (!Array.isArray(map.sources) || map.sources.some((item) => typeof item !== 'string'))
          throw new Error('invalid source list');
        for (const source of map.sources) sources.add(source);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          violations.push(`invalid source map for ${relative}: ${error.message}`);
          continue;
        }
      }
      // The compiled file name is evidence for single-module chunks emitted
      // without a map/region, but is not enough to prove an arbitrary bundle.
      const basename = path.basename(file).replace(/\.(?:cjs|mjs|js)$/, '.ts');
      const filenameMatches = [...retiredAuthority].filter(
        (item) => path.basename(item) === basename,
      );
      if (filenameMatches.length) for (const match of filenameMatches) sources.add(match);
      if (!sources.size && text.trim() && !isPureForwarder(text)) {
        violations.push(`no module provenance for ${relative}; cannot certify production closure`);
        continue;
      }
      for (const source of sources) {
        const module = sourceModule(source);
        if (module && retiredAuthority.has(module))
          violations.push(`${relative} includes retired Project authority ${module}`);
      }
    }
  }
  return [...new Set(violations)];
}
