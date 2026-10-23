// #520: pre-cutover comparison at real native and legacy editor Project seams.
// Do not use candidate CLI routing to time an editor Save: it is a different host.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { editorRoot } from './editor-distribution-lib.mjs';

const addonPath = process.argv[2];
assert.ok(addonPath, 'Pass the built native authoring Node addon path.');
const require = createRequire(import.meta.url);
const binding = require(path.resolve(addonPath));
await import('./native-schema/register-typescript.mjs');
const { createNodeProjectWorkspaceService } =
  await import('../src/shared/project-workspace/node-project-workspace-service.ts');
const { NodeProjectWorkspaceFileSystem, NodeProjectWorkspaceProcessLiveness } =
  await import('../src/shared/project-workspace/node-project-workspace-file-system.ts');
const { ProjectWorkspaceTransactionService } =
  await import('../src/shared/project-workspace/project-workspace-transaction.ts');
const { selectedExportProfile } = await import('../src/shared/project-schema/authoring-export.ts');
const { prepareRuntimeArtifact } = await import('../src/shared/runtime-artifact-preparation.ts');
const { nodeRuntimeArtifactPaths, nodeShaderCompilerAdapter } =
  await import('../src/main/services/node-runtime-artifact-adapters.ts');
const { invokeNovelTeaNativeOperation } = await import('../src/shared/noveltea-cli-subprocess.ts');
const { emptyEditorProjectState } =
  await import('../src/shared/project-schema/editor-project-state.ts');
const { authoringCollectionKeys } =
  await import('../src/shared/project-schema/authoring-collections.ts');
const { authoringProjectSchema } =
  await import('../src/shared/project-schema/authoring-project.ts');

const fixture = path.resolve(editorRoot, '../tests/projects/feature-lab');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-520-editor-performance-'));
const legacyRoot = path.join(scratch, 'legacy');
const nativeRoot = path.join(scratch, 'native');
const source = (root, file) => path.join(root, file);
const measurements = [];

async function time(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

async function compare(label, legacy, native) {
  const baseline = await time(legacy);
  const candidate = await time(native);
  const ratio = candidate.ms / Math.max(baseline.ms, 0.1);
  // The same conservative dual-threshold policy as the CLI candidate. A
  // sub-500ms difference is not actionable on shared CI hosts.
  assert.ok(
    ratio <= 3 || candidate.ms - baseline.ms <= 500,
    `${label}: native ${candidate.ms.toFixed(1)}ms vs legacy ${baseline.ms.toFixed(1)}ms (${ratio.toFixed(2)}x)`,
  );
  const row = {
    label,
    legacyMs: Math.round(baseline.ms),
    nativeMs: Math.round(candidate.ms),
    ratio: Number(ratio.toFixed(2)),
  };
  measurements.push(row);
  console.log(`${label}: ${JSON.stringify(row)}`);
  return { legacy: baseline.result, native: candidate.result };
}

function parseResult(text, operation) {
  const result = JSON.parse(text);
  assert.equal(result.accepted, true, `${operation}: ${result.error ?? 'rejected'}`);
  return result;
}

let handle;
try {
  for (const root of [legacyRoot, nativeRoot]) {
    await cp(fixture, root, {
      recursive: true,
      filter: (file) => !file.split(path.sep).includes('.noveltea'),
    });
  }

  const workspace = createNodeProjectWorkspaceService();
  const opened = await compare(
    'cold Project open',
    async () => {
      const value = await workspace.open(legacyRoot);
      assert.equal(value.ok, true, JSON.stringify(value.diagnostics));
      return value;
    },
    () => {
      handle = binding.open(nativeRoot);
      const value = JSON.parse(binding.snapshot(handle));
      assert.equal(value.valid, true, JSON.stringify(value.diagnostics));
      return value;
    },
  );

  const updated = await compare(
    'one-owner YAML patch and scoped Save',
    async () => {
      const next = structuredClone(opened.legacy.snapshot.project);
      next.project.name = 'Feature Lab Saved';
      return workspace.write(
        legacyRoot,
        opened.legacy.snapshot.workspaceRevision,
        next,
        opened.legacy.editorState,
        {},
        {
          targetFiles: ['project.yaml'],
          preflightSnapshot: opened.legacy.snapshot,
          commentDisposition: 'keep',
        },
      );
    },
    () => {
      const patched = parseResult(
        binding.patch(
          handle,
          opened.native.workingRevision,
          JSON.stringify([
            { operation: 'replace', path: '/project/name', value: 'Feature Lab Saved' },
          ]),
        ),
        'patch',
      );
      return parseResult(
        binding.saveOwners(handle, patched.snapshot.workingRevision, '["project"]', false, 'keep'),
        'saveOwners',
      );
    },
  );
  assert.ok(updated.legacy.workspaceRevision);
  for (const root of [legacyRoot, nativeRoot]) {
    const yaml = await readFile(source(root, 'project.yaml'), 'utf8');
    assert.match(yaml, /name: "?Feature Lab Saved"?/);
  }

  const luaPath = 'scripts/feature-lab-bootstrap.lua';
  const originalLua = await readFile(source(legacyRoot, luaPath), 'utf8');
  const luaSource = `${originalLua}\n-- #520 editor source Save\n`;
  const expectedLuaRevision = `sha256:${createHash('sha256').update(originalLua).digest('hex')}`;
  const textSaved = await compare(
    'one-source Lua physical Save transaction',
    async () => {
      const fsPort = new NodeProjectWorkspaceFileSystem();
      const transaction = new ProjectWorkspaceTransactionService(
        fsPort,
        new NodeProjectWorkspaceProcessLiveness(),
        process.pid,
        randomUUID,
      );
      return transaction.commit(legacyRoot, {
        operationLabel: `save source ${luaPath}`,
        targets: [
          {
            path: luaPath,
            operation: 'write',
            expectedRevision: expectedLuaRevision,
            bytes: new TextEncoder().encode(luaSource),
          },
        ],
      });
    },
    () => {
      const staged = parseResult(
        binding.stageTextSource(
          handle,
          updated.native.snapshot.workingRevision,
          luaPath,
          luaSource,
        ),
        'stageTextSource',
      );
      return parseResult(
        binding.saveTextSources(
          handle,
          staged.snapshot.workingRevision,
          JSON.stringify([luaPath]),
          JSON.stringify({ [luaPath]: expectedLuaRevision }),
        ),
        'saveTextSources',
      );
    },
  );
  for (const root of [legacyRoot, nativeRoot])
    assert.equal(await readFile(source(root, luaPath), 'utf8'), luaSource);

  const revised = await compare(
    'saved Project semantic preparation',
    async () => {
      const value = await workspace.open(legacyRoot);
      assert.equal(value.ok, true, JSON.stringify(value.diagnostics));
      await workspace.buildDependencyGraph(value.snapshot);
      return value;
    },
    () => {
      const value = parseResult(
        binding.prepareCompleteWorking(handle, textSaved.native.snapshot.workingRevision, ''),
        'prepareCompleteWorking',
      );
      assert.ok(value.completeProject, 'Native working preparation omitted effective Project');
      return value;
    },
  );
  assert.equal(revised.legacy.snapshot.project.project.name, 'Feature Lab Saved');
  assert.equal(revised.native.completeProject.project.name, 'Feature Lab Saved');

  // Compare the complete saved-Project -> prepared Runtime Package boundary,
  // not just the common compiler in isolation or a CLI-only export. Both
  // paths execute the same real downstream shader/asset/package preparation.
  const compiler = nodeShaderCompilerAdapter((shaderProject, options) =>
    invokeNovelTeaNativeOperation('compile-shaders', { shaderProject, options }),
  );
  async function prepareExport(project, projectRoot) {
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot,
      profile: selectedExportProfile(project),
      intent: 'runtime-package-export',
      shaderCompiler: compiler,
      paths: nodeRuntimeArtifactPaths,
    });
    assert.equal(
      result.status,
      'prepared',
      `Runtime Package preparation blocked: ${JSON.stringify(result.diagnostics)}`,
    );
    return result.artifact;
  }
  const exported = await compare(
    'saved editor Runtime Package export preparation',
    async () => {
      const opened = await workspace.open(legacyRoot);
      assert.equal(opened.ok, true, JSON.stringify(opened.diagnostics));
      await workspace.buildDependencyGraph(opened.snapshot);
      return prepareExport(opened.snapshot.project, legacyRoot);
    },
    async () => {
      const prepared = parseResult(
        binding.prepareCompleteWorking(handle, textSaved.native.snapshot.workingRevision, ''),
        'prepareCompleteWorking for export',
      );
      const project = {
        ...prepared.completeProject,
        editor: { ...emptyEditorProjectState(), ...prepared.completeProject.editor },
      };
      for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
      return prepareExport(authoringProjectSchema.parse(project), nativeRoot);
    },
  );
  assert.deepEqual(exported.native.gameplayJson, exported.legacy.gameplayJson);
  assert.deepEqual(exported.native.compiledProject, exported.legacy.compiledProject);
  assert.deepEqual(exported.native.manifestPreview, exported.legacy.manifestPreview);

  console.log(JSON.stringify({ format: 'noveltea.native-editor-performance.v1', measurements }));
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
