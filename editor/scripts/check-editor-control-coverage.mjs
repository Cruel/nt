#!/usr/bin/env node
/**
 * Closed-world audit of JSX control callbacks in the Project editors. The
 * classifications live alongside this snapshot in editor-control-coverage.json.
 * New editors, controls and callback changes must be classified in #607's
 * matrix; modifying the snapshot alone is not evidence of correct buffering.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..');
const defaultRoot = resolve(scriptsDir, '../src/renderer/editors');
const defaultManifest = resolve(scriptsDir, 'editor-control-coverage.json');
const defaultRoutes = resolve(scriptsDir, '../src/renderer/workbench/default-editors.tsx');

export function countEditorCallbacks(source) {
  const counts = {};
  // JSX callbacks are invariably expressed as onXxx={...}; include custom
  // component callbacks and user/DOM events, not just native input tags.
  for (const match of source.matchAll(/\b(on[A-Z][A-Za-z]+)\s*=\s*\{/gu)) {
    const name = match[1];
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function editorRouteBindings(source) {
  const registrations = source.split(
    'export const defaultEditorRegistrations: WorkbenchEditorRegistration[] = [',
  )[1];
  if (!registrations) throw new Error('Editor registration declaration was not found.');
  const bindings = {};
  for (const match of registrations.matchAll(
    /\btype:\s*'([^']+)'\s*,[\s\S]*?\bcomponent:\s*([A-Za-z][A-Za-z0-9_]*)\s*,/gu,
  )) {
    if (Object.hasOwn(bindings, match[1])) throw new Error(`Duplicate editor route ${match[1]}`);
    bindings[match[1]] = match[2];
  }
  return Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walk(root, full);
      return entry.isFile() && entry.name.endsWith('.tsx')
        ? [relative(root, full).replaceAll('\\', '/')]
        : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

export function checkEditorControlCoverage(
  root,
  manifest,
  routes = editorRouteBindings(readFileSync(defaultRoutes, 'utf8')),
) {
  const errors = [];
  if (manifest.schema !== 1 || !manifest.categories || !manifest.files || !manifest.routes)
    return ['Invalid editor control coverage manifest schema.'];
  if (
    JSON.stringify(routes) !==
    JSON.stringify(
      Object.fromEntries(Object.entries(manifest.routes).sort(([a], [b]) => a.localeCompare(b))),
    )
  )
    errors.push(
      `Unclassified editor route or component mapping change:\n  expected ${JSON.stringify(manifest.routes)}\n  actual   ${JSON.stringify(routes)}`,
    );
  const files = walk(root);
  const existing = new Set(files);
  for (const file of files) {
    const expected = manifest.files[file];
    if (!expected) {
      errors.push(`Unclassified editor module: ${file}`);
      continue;
    }
    const category = file.includes('/') ? file.split('/')[0] : 'shared';
    if (!manifest.categories[category]?.disposition || !manifest.categories[category]?.evidence) {
      errors.push(`No documented owner/projection/test classification for ${file} (${category}).`);
      continue;
    }
    const actual = countEditorCallbacks(readFileSync(join(root, file), 'utf8'));
    if (
      JSON.stringify(actual) !==
      JSON.stringify(
        Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))),
      )
    ) {
      errors.push(
        `Unreviewed JSX control callback change: ${file}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const file of Object.keys(manifest.files)) {
    if (!existing.has(file)) errors.push(`Orphaned editor control coverage entry: ${file}`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? defaultRoot);
  const manifestPath = resolve(process.argv[3] ?? defaultManifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const errors = checkEditorControlCoverage(root, manifest);
  if (errors.length) {
    console.error(errors.join('\n'));
    console.error(
      'Review every changed editor control and update the #607 coverage matrix and snapshot.',
    );
    process.exitCode = 1;
  } else {
    const handlers = Object.values(manifest.files).reduce(
      (sum, entry) => sum + Object.values(entry).reduce((a, b) => a + b, 0),
      0,
    );
    console.log(
      `Editor JSX control coverage: ${Object.keys(manifest.files).length} modules, ${handlers} classified callbacks.`,
    );
  }
}
