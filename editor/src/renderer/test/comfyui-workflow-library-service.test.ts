import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeComfyUiWorkflowPackageHash,
  copyComfyUiWorkflow,
  deleteComfyUiWorkflow,
  listComfyUiWorkflowLibrary,
  revealComfyUiWorkflow,
  verifyComfyUiWorkflowLibrary,
  writeComfyUiWorkflowVerificationCache,
  type WorkflowLibraryServiceOptions,
} from '../../main/services/comfyui-workflow-library-service';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => path.join(os.tmpdir(), 'noveltea-test-user-data'),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
}));

const roots: string[] = [];

function testRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-workflow-library-'));
  roots.push(root);
  const builtInRoot = path.join(root, 'built-in');
  const editorRoot = path.join(root, 'editor');
  const projectRoot = path.join(root, 'project', 'workflows');
  for (const item of [builtInRoot, editorRoot, projectRoot]) fs.mkdirSync(item, { recursive: true });
  const options: WorkflowLibraryServiceOptions = {
    roots: {
      builtInRoot,
      editorRoot,
      projectRoot,
      cacheFile: path.join(editorRoot, '.verification-cache.json'),
    },
  };
  return { root, builtInRoot, editorRoot, projectRoot, options };
}

function testRootsWithoutProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-workflow-library-'));
  roots.push(root);
  const builtInRoot = path.join(root, 'built-in');
  const editorRoot = path.join(root, 'editor');
  for (const item of [builtInRoot, editorRoot]) fs.mkdirSync(item, { recursive: true });
  const options: WorkflowLibraryServiceOptions = {
    roots: {
      builtInRoot,
      editorRoot,
      cacheFile: path.join(editorRoot, '.verification-cache.json'),
    },
  };
  return { root, builtInRoot, editorRoot, options };
}

function workflow(prompt = 'Tea') {
  return {
    prompt: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.prompt' }, inputs: { value: prompt } },
    output: { class_type: 'SaveImage', _meta: { title: 'noveltea.output' }, inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] } },
  };
}

function manifest(id: string, label = id, workflowFile = `${id}.workflow.json`) {
  return {
    schemaVersion: 2,
    id,
    label,
    provider: 'comfyui',
    role: 'image.generate',
    workflowFile,
    contract: {
      inputs: { prompt: { type: 'string', required: true } },
      outputs: { images: { type: 'image-list', required: true, primary: 'first' } },
    },
    bindings: {
      prompt: {
        nodeId: 'prompt',
        nodeTitle: 'noveltea.prompt',
        classType: 'PrimitiveStringMultiline',
        inputName: 'value',
        valueType: 'string',
      },
    },
    outputBindings: {
      images: [{
        nodeId: 'output',
        nodeTitle: 'noveltea.output',
        classType: 'SaveImage',
        outputName: 'images',
        valueType: 'image-list',
        primary: 'first',
      }],
    },
    outputNodeIds: ['output'],
    defaults: { filenamePrefix: 'NovelTea' },
    requiredNodeClasses: ['PrimitiveStringMultiline', 'SaveImage'],
  };
}

function writePackage(root: string, id: string, label = id, prompt = 'Tea') {
  const manifestFile = `${id}.manifest.json`;
  const workflowFile = `${id}.workflow.json`;
  fs.writeFileSync(path.join(root, manifestFile), `${JSON.stringify(manifest(id, label, workflowFile), null, 2)}\n`);
  fs.writeFileSync(path.join(root, workflowFile), `${JSON.stringify(workflow(prompt), null, 2)}\n`);
  return { manifestFile, workflowFile };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('comfyui workflow library service', () => {
  it('discovers built-in and editor workflows without a project and omits project workflows until a project path exists', async () => {
    const { root, builtInRoot, editorRoot, options } = testRootsWithoutProject();
    const projectRoot = path.join(root, 'project', 'workflows');
    fs.mkdirSync(projectRoot, { recursive: true });
    writePackage(builtInRoot, 'built-in-workflow', 'Built-in Workflow');
    writePackage(editorRoot, 'editor-workflow', 'Editor Workflow');
    writePackage(projectRoot, 'project-workflow', 'Project Workflow');

    const withoutProject = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const withProject = await listComfyUiWorkflowLibrary({ projectFilePath: path.join(root, 'project', 'game.json'), includeOverridden: true }, options);

    expect(withoutProject.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'built-in:built-in-workflow',
      'editor:editor-workflow',
    ]);
    expect(withoutProject.summary.sources.find((source) => source.source === 'project')).toMatchObject({ available: false, workflowCount: 0 });
    expect(withProject.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'built-in:built-in-workflow',
      'editor:editor-workflow',
      'project:project-workflow',
    ]);
  });

  it('discovers source-aware workflow entries and resolves active overrides by workflow id', async () => {
    const { builtInRoot, editorRoot, projectRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    writePackage(projectRoot, 'portrait', 'Project Portrait');
    writePackage(editorRoot, 'landscape', 'Editor Landscape');

    const visible = await listComfyUiWorkflowLibrary({ includeOverridden: false }, options);
    const full = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);

    expect(visible.entries.map((entry) => `${entry.source}:${entry.id}`)).toEqual(['editor:landscape', 'project:portrait']);
    expect(full.overriddenEntries.map((entry) => `${entry.source}:${entry.id}->${entry.overriddenBy}`)).toEqual([
      'built-in:portrait->project:portrait.manifest.json',
      'editor:portrait->project:portrait.manifest.json',
    ]);
    expect(full.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual(['editor:landscape', 'project:portrait']);
    expect(full.summary).toMatchObject({ totalCount: 4, activeCount: 2, overriddenCount: 2, invalidCount: 0 });
  });

  it('computes package hashes from canonical manifest and workflow JSON', () => {
    const left = computeComfyUiWorkflowPackageHash({ b: 2, a: 1 }, { prompt: { inputs: { value: 'Tea' } } });
    const right = computeComfyUiWorkflowPackageHash({ a: 1, b: 2 }, { prompt: { inputs: { value: 'Tea' } } });
    const changed = computeComfyUiWorkflowPackageHash({ a: 1, b: 2 }, { prompt: { inputs: { value: 'Coffee' } } });
    const manifestChanged = computeComfyUiWorkflowPackageHash({ a: 1, b: 3 }, { prompt: { inputs: { value: 'Tea' } } });

    expect(left).toBe(right);
    expect(changed).not.toBe(left);
    expect(manifestChanged).not.toBe(left);
  });

  it('copies workflows to mutable sources, detects duplicates, and requires replace for changed packages', async () => {
    const { builtInRoot, editorRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');

    const copied = await copyComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json', targetSource: 'editor' }, options);
    expect(copied).toMatchObject({ ok: true, success: true, action: 'copied', targetWorkflowKey: 'editor:portrait.manifest.json' });
    expect(fs.existsSync(path.join(editorRoot, 'portrait.manifest.json'))).toBe(true);

    const duplicate = await copyComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json', targetSource: 'editor' }, options);
    expect(duplicate.action).toBe('already-copied');

    writePackage(builtInRoot, 'portrait', 'Built-in Portrait Revised', 'Coffee');
    const collision = await copyComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json', targetSource: 'editor' }, options);
    expect(collision).toMatchObject({ ok: false, success: false, action: 'replace-required' });

    const replaced = await copyComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json', targetSource: 'editor', replace: true }, options);
    expect(replaced).toMatchObject({ ok: true, success: true, action: 'replaced' });
  });

  it('deletes mutable packages and refreshes override state', async () => {
    const { builtInRoot, editorRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');

    const response = await deleteComfyUiWorkflow({ workflowKey: 'editor:portrait.manifest.json' }, options);

    expect(response.success).toBe(true);
    expect(response.deleted).toHaveLength(2);
    expect(response.refreshed?.activeWorkflows).toContainEqual(expect.objectContaining({ source: 'built-in', id: 'portrait' }));
  });

  it('rejects built-in workflow deletion', async () => {
    const { builtInRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');

    const response = await deleteComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json' }, options);

    expect(response).toMatchObject({ ok: false, success: false, deleted: [], error: 'Built-in workflows cannot be deleted.' });
  });

  it('applies matching verification cache records and reveals workflow files', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0]!;
    await writeComfyUiWorkflowVerificationCache([{
      workflowKey: entry.workflowKey,
      id: entry.id!,
      packageHash: entry.packageHash!,
      status: 'verified',
      checkedAt: '2026-07-09T00:00:00.000Z',
      diagnostics: [],
    }], null, options);

    const showItemInFolder = vi.fn();
    const second = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const revealed = await revealComfyUiWorkflow('editor:portrait.manifest.json', null, { ...options, showItemInFolder });

    expect(second.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });
    expect(revealed).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(path.join(editorRoot, 'portrait.manifest.json'));
  });
  it('verifies all offline-valid discovered workflows including overridden entries and reuses cache by package hash', async () => {
    const { builtInRoot, editorRoot, projectRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    writePackage(projectRoot, 'portrait', 'Project Portrait');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ PrimitiveStringMultiline: {}, SaveImage: {} }), { status: 200 })));

    const verified = await verifyComfyUiWorkflowLibrary({
      projectFilePath: '/mock/project/game.json',
      config: { enabled: true, serverUrl: 'http://127.0.0.1:8188', requestTimeoutMs: 1000, connectionCheckIntervalMs: 1000, defaultWorkflowId: 'portrait', defaultWorkflows: {} },
    }, options);

    expect(verified.success).toBe(true);
    expect(verified.verified.map((record) => record.workflowKey).sort()).toEqual([
      'built-in:portrait.manifest.json',
      'editor:portrait.manifest.json',
      'project:portrait.manifest.json',
    ]);

    fs.rmSync(path.join(editorRoot, 'portrait.manifest.json'));
    fs.rmSync(path.join(editorRoot, 'portrait.workflow.json'));
    await copyComfyUiWorkflow({ workflowKey: 'built-in:portrait.manifest.json', targetSource: 'editor' }, options);

    const listed = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const copied = listed.entries.find((entry) => entry.workflowKey === 'editor:portrait.manifest.json');
    expect(copied).toMatchObject({ onlineStatus: 'previously-verified' });
  });

  it('preserves previous successful verification cache when object_info is unavailable', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0]!;
    await writeComfyUiWorkflowVerificationCache([{
      workflowKey: entry.workflowKey,
      id: entry.id!,
      packageHash: entry.packageHash!,
      status: 'verified',
      checkedAt: '2026-07-09T00:00:00.000Z',
      diagnostics: [],
    }], null, options);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const failed = await verifyComfyUiWorkflowLibrary({
      config: { enabled: true, serverUrl: 'http://127.0.0.1:8188', requestTimeoutMs: 1000, connectionCheckIntervalMs: 1000, defaultWorkflowId: 'portrait', defaultWorkflows: {} },
    }, options);

    expect(failed.success).toBe(false);
    const after = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    expect(after.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });
  });
});
