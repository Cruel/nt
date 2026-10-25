import assert from 'node:assert/strict';
import {
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const candidates = [
  'renderer/main.tsx',
  'shared/authoring-compiler-lowering.ts',
  'shared/authoring-source-downstream.ts',
  'shared/authoring-native-lua-sources.ts',
  'shared/runtime-artifact-preparation.ts',
  'cli/native-project-package-cli.ts',
  'cli/native-project-tests-cli.ts',
  'main/services/native-authoring-runtime-preparation.ts',
  'main/services/native-runtime-tool-service.ts',
  'main/services/project-editor-metadata-service.ts',
  'main/package-smoke.ts',
  'main/services/native-editor-project-handoff.ts',
  'main/services/native-editor-project-open.ts',
  'main/services/native-editor-project-create.ts',
  'main/services/native-editor-observer-watch-service.ts',
  'main/services/native-project-copy-service.ts',
  'main/services/native-editor-session-controller.ts',
  'main/services/native-project-source-transactions.ts',
  'main/services/native-desktop-project-import-service.ts',
];

const retired = [
  /(?:^|\/)authoring-compiler\.ts$/u,
  /(?:^|\/)authoring-source-analysis\.ts$/u,
  /(?:^|\/)authoring-dependency-graph\.ts$/u,
  /(?:^|\/)authoring-validation\.ts$/u,
  /(?:^|\/)project-workspace(?:-service)?\.ts$/u,
  /(?:^|\/)project-workspace\/index\.ts$/u,
  /(?:^|\/)resident-project-workspace-service\.ts$/u,
  /(?:^|\/)commands\/native-commands\.ts$/u,
  /(?:^|\/)legacy-[^/]+\.ts$/u,
];

function imports(source) {
  // Include value imports, re-exports and static lazy imports, excluding
  // erased type-only imports. The negative fixture proves indirect traversal.
  const edges = new Set();
  for (const match of source.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s*)?['"]([^'"\n]+)['"]/gmu,
  )) {
    if (
      /^(?:import|export)\s+\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}\s+from\s/u.test(
        match[0].trim(),
      )
    )
      continue;
    edges.add(match[1]);
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu)) {
    // TypeScript import-type nodes produce no executable dependency.
    if (source.slice(match.index + match[0].length).match(/^\.[A-Z][A-Za-z0-9_]+\b/u)) continue;
    edges.add(match[1]);
  }
  return [...edges];
}

function localTarget(from, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;
  spec = spec.split('?')[0];
  const name = spec.startsWith('@/')
    ? path.join(sourceRoot, 'renderer', spec.slice(2))
    : path.resolve(path.dirname(from), spec);
  if (/\.(?:css|scss|svg|json|png|webp|rml|rcss|md|lua)$/u.test(name)) return null;
  for (const candidate of [
    name,
    `${name}.ts`,
    `${name}.tsx`,
    `${name}.mjs`,
    path.join(name, 'index.ts'),
    path.join(name, 'index.tsx'),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  // Only declared non-script imports (such as styles) are intentionally opaque.
  if (/\.(?:css|scss|svg|json|png|webp)$/u.test(name)) return null;
  throw new Error(`Unresolved candidate import ${spec} in ${from}`);
}

function provenance(root) {
  const paths = new Map([[root, [root]]]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const spec of imports(readFileSync(current, 'utf8'))) {
      const target = localTarget(current, spec);
      if (!target || paths.has(target)) continue;
      paths.set(target, [...paths.get(current), target]);
      queue.push(target);
    }
  }
  return paths;
}

function forbiddenEdges(paths, rootDir) {
  return [...paths.entries()].flatMap(([file, chain]) => {
    const relative = path.relative(rootDir, file).replaceAll('\\', '/');
    return retired.some((pattern) => pattern.test(relative))
      ? [chain.map((entry) => path.relative(rootDir, entry)).join(' -> ')]
      : [];
  });
}

void test('native candidate editor, CLI and runtime lowering contain no retired Project authority', () => {
  for (const root of candidates) {
    const chain = provenance(path.join(sourceRoot, root));
    // A pure lexical helper legitimately imports only one local utility.
    // Entrypoint closures must still traverse multiple implementation layers.
    const smallAdapter =
      /(?:project-editor-metadata|native-(?:runtime-tool|desktop-project-import|editor-project-(?:open|create|handoff)|editor-observer-watch|project-copy))/u.test(
        root,
      );
    assert.ok(
      chain.size >=
        (root.includes('native-editor-observer-watch')
          ? 1
          : root.startsWith('shared/') || smallAdapter
            ? 2
            : 6),
      `Candidate closure not resolved: ${root}`,
    );
    assert.deepEqual(forbiddenEdges(chain, sourceRoot), [], root);
    if (root.startsWith('cli/native-project-'))
      assert.ok(
        [...chain.keys()].some((file) => file.endsWith('/runtime-artifact-preparation.ts')),
      );
  }
});

void test('provenance guard detects a retired authority behind an indirect adapter', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'noveltea-native-closure-'));
  try {
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'candidate.ts'), "import './sub/adapter';\n");
    writeFileSync(
      path.join(dir, 'sub/adapter.ts'),
      "export * from '../authoring-dependency-graph';\n",
    );
    writeFileSync(
      path.join(dir, 'authoring-dependency-graph.ts'),
      'export const authority = true;\n',
    );
    const evidence = forbiddenEdges(provenance(path.join(dir, 'candidate.ts')), dir);
    assert.equal(evidence.length, 1);
    assert.match(
      evidence[0],
      /candidate\.ts -> sub\/adapter\.ts -> authoring-dependency-graph\.ts/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('import parser follows runtime lazy edges but excludes erased type-only edges', () => {
  assert.deepEqual(
    imports(`
      import type { Old } from './retired-type';
      import { type Other } from './also-erased';
      type Query = import('./query-type').Description;
      export { type Transient } from './export-erased';
      export { live } from './live-reexport';
      const loaded = import('./lazy-runtime');
      const cjs = require('./commonjs-runtime');
    `),
    ['./live-reexport', './lazy-runtime', './commonjs-runtime'],
  );
});
