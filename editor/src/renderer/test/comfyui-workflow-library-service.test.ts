import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
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
const verificationServerIdentity = 'http://127.0.0.1:8188';

function testRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-workflow-library-'));
  roots.push(root);
  const builtInRoot = path.join(root, 'built-in');
  const editorRoot = path.join(root, 'editor');
  const projectRoot = path.join(root, 'project', 'workflows');
  for (const item of [builtInRoot, editorRoot, projectRoot])
    fs.mkdirSync(item, { recursive: true });
  const options: WorkflowLibraryServiceOptions = {
    roots: {
      builtInRoot,
      userRoot: editorRoot,
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
      userRoot: editorRoot,
      cacheFile: path.join(editorRoot, '.verification-cache.json'),
    },
  };
  return { root, builtInRoot, editorRoot, options };
}

function workflow(prompt = 'Tea') {
  return {
    prompt: {
      class_type: 'PrimitiveStringMultiline',
      _meta: { title: 'noveltea.prompt' },
      inputs: { value: prompt },
    },
    output: {
      class_type: 'SaveImage',
      _meta: { title: 'noveltea.output' },
      inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] },
    },
  };
}

function manifest(id: string, label = id, workflowFile = `${id}.workflow.json`) {
  return {
    schemaVersion: 2,
    id,
    label,
    provider: 'comfyui',
    classification: 'image.generate',
    workflowFile,
    contract: {
      inputs: { prompt: { type: 'string', required: true } },
      outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
    },
    bindings: {
      prompt: [
        {
          nodeId: 'prompt',
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
        },
      ],
    },
    outputBindings: {
      images: [
        {
          nodeId: 'output',
          nodeTitle: 'noveltea.output',
          classType: 'SaveImage',
        },
      ],
    },
    requiredNodeClasses: ['PrimitiveStringMultiline', 'SaveImage'],
  };
}

function compatibleObjectInfo() {
  return {
    PrimitiveStringMultiline: { input: { required: { value: [] } } },
    SaveImage: { input: { required: { images: [], filename_prefix: [] } } },
  };
}

function writePackage(root: string, id: string, label = id, prompt = 'Tea') {
  const manifestFile = `${id}.manifest.json`;
  const workflowFile = `${id}.workflow.json`;
  fs.writeFileSync(
    path.join(root, manifestFile),
    `${JSON.stringify(manifest(id, label, workflowFile), null, 2)}\n`,
  );
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
    const withProject = await listComfyUiWorkflowLibrary(
      { projectFilePath: path.join(root, 'project', 'game.json'), includeOverridden: true },
      options,
    );

    expect(withoutProject.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'built-in:built-in-workflow',
      'user:editor-workflow',
    ]);
    expect(
      withoutProject.summary.sources.find((source) => source.source === 'project'),
    ).toMatchObject({ available: false, workflowCount: 0 });
    expect(withProject.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'built-in:built-in-workflow',
      'user:editor-workflow',
      'project:project-workflow',
    ]);
  });

  it('keeps unsupported output media discoverable but marks the workflow non-runnable', async () => {
    const { editorRoot, options } = testRootsWithoutProject();
    const futureManifest = manifest('future-media');
    fs.writeFileSync(
      path.join(editorRoot, 'future-media.manifest.json'),
      `${JSON.stringify(
        {
          ...futureManifest,
          contract: {
            inputs: futureManifest.contract.inputs,
            outputs: { audio: { mediaType: 'audio', required: true, cardinality: 'one' } },
          },
          outputBindings: { audio: futureManifest.outputBindings.images },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(editorRoot, 'future-media.workflow.json'),
      `${JSON.stringify(workflow(), null, 2)}\n`,
    );

    const response = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);

    expect(response.activeWorkflows).toContainEqual(
      expect.objectContaining({ id: 'future-media', runnable: false, offlineStatus: 'warning' }),
    );
    expect(response.entries[0]?.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining("Output media type 'audio'"),
      }),
    );
  });

  it('discovers source-aware workflow entries and resolves active overrides by workflow id', async () => {
    const { builtInRoot, editorRoot, projectRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    writePackage(projectRoot, 'portrait', 'Project Portrait');
    writePackage(editorRoot, 'landscape', 'Editor Landscape');

    const visible = await listComfyUiWorkflowLibrary({ includeOverridden: false }, options);
    const full = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);

    expect(visible.entries.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'user:landscape',
      'project:portrait',
    ]);
    expect(
      full.overriddenEntries.map((entry) => `${entry.source}:${entry.id}->${entry.overriddenBy}`),
    ).toEqual([
      'built-in:portrait->project:portrait.manifest.json',
      'user:portrait->project:portrait.manifest.json',
    ]);
    expect(full.activeWorkflows.map((entry) => `${entry.source}:${entry.id}`)).toEqual([
      'user:landscape',
      'project:portrait',
    ]);
    expect(full.summary).toMatchObject({
      totalCount: 4,
      activeCount: 2,
      overriddenCount: 2,
      invalidCount: 0,
    });
  });

  it('computes package hashes from canonical manifest and workflow JSON', () => {
    const left = computeComfyUiWorkflowPackageHash(
      { b: 2, a: 1 },
      { prompt: { inputs: { value: 'Tea' } } },
    );
    const right = computeComfyUiWorkflowPackageHash(
      { a: 1, b: 2 },
      { prompt: { inputs: { value: 'Tea' } } },
    );
    const changed = computeComfyUiWorkflowPackageHash(
      { a: 1, b: 2 },
      { prompt: { inputs: { value: 'Coffee' } } },
    );
    const manifestChanged = computeComfyUiWorkflowPackageHash(
      { a: 1, b: 3 },
      { prompt: { inputs: { value: 'Tea' } } },
    );

    expect(left).toBe(right);
    expect(changed).not.toBe(left);
    expect(manifestChanged).not.toBe(left);
  });

  it('copies workflows to mutable sources, detects duplicates, and requires replace for changed packages', async () => {
    const { builtInRoot, editorRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');

    const copied = await copyComfyUiWorkflow(
      { workflowKey: 'built-in:portrait.manifest.json', targetSource: 'user' },
      options,
    );
    expect(copied).toMatchObject({
      ok: true,
      success: true,
      action: 'copied',
      targetWorkflowKey: 'user:portrait.manifest.json',
    });
    expect(fs.existsSync(path.join(editorRoot, 'portrait.manifest.json'))).toBe(true);

    const duplicate = await copyComfyUiWorkflow(
      { workflowKey: 'built-in:portrait.manifest.json', targetSource: 'user' },
      options,
    );
    expect(duplicate.action).toBe('already-copied');

    writePackage(builtInRoot, 'portrait', 'Built-in Portrait Revised', 'Coffee');
    const collision = await copyComfyUiWorkflow(
      { workflowKey: 'built-in:portrait.manifest.json', targetSource: 'user' },
      options,
    );
    expect(collision).toMatchObject({ ok: false, success: false, action: 'replace-required' });

    const replaced = await copyComfyUiWorkflow(
      { workflowKey: 'built-in:portrait.manifest.json', targetSource: 'user', replace: true },
      options,
    );
    expect(replaced).toMatchObject({ ok: true, success: true, action: 'replaced' });
  });

  it('deletes mutable packages and refreshes override state', async () => {
    const { builtInRoot, editorRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');

    const response = await deleteComfyUiWorkflow(
      { workflowKey: 'user:portrait.manifest.json' },
      options,
    );

    expect(response.success).toBe(true);
    expect(response.deleted).toHaveLength(2);
    expect(response.refreshed?.activeWorkflows).toContainEqual(
      expect.objectContaining({ source: 'built-in', id: 'portrait' }),
    );
  });

  it('rejects built-in workflow deletion', async () => {
    const { builtInRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');

    const response = await deleteComfyUiWorkflow(
      { workflowKey: 'built-in:portrait.manifest.json' },
      options,
    );

    expect(response).toMatchObject({
      ok: false,
      success: false,
      deleted: [],
      error: 'Built-in workflows cannot be deleted.',
    });
  });

  it('applies matching verification cache records and reveals workflow files', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0]!;
    await writeComfyUiWorkflowVerificationCache(
      [
        {
          workflowKey: entry.workflowKey,
          id: entry.id!,
          serverIdentity: 'http://127.0.0.1:8188',
          packageHash: entry.packageHash!,
          comfyUiVersion: '1.0.0',
          status: 'verified',
          checkedAt: '2026-07-09T00:00:00.000Z',
          diagnostics: [],
        },
      ],
      null,
      options,
    );

    const showItemInFolder = vi.fn();
    const second = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: verificationServerIdentity,
        comfyUiVersion: '1.0.0',
      },
      options,
    );
    const revealed = await revealComfyUiWorkflow('user:portrait.manifest.json', null, {
      ...options,
      showItemInFolder,
    });

    expect(second.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });
    const otherServer = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: 'http://127.0.0.1:9191',
        comfyUiVersion: '1.0.0',
      },
      options,
    );
    expect(otherServer.entries[0]).toMatchObject({ onlineStatus: 'unverified' });
    expect(revealed).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(path.join(editorRoot, 'portrait.manifest.json'));
  });

  it('discards an unversioned verification cache array', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0];
    expect(entry).toBeDefined();
    if (!entry?.id || !entry.packageHash) throw new Error('Expected a valid workflow entry.');
    fs.writeFileSync(
      path.join(editorRoot, '.verification-cache.json'),
      `${JSON.stringify([
        {
          workflowKey: entry.workflowKey,
          id: entry.id,
          packageHash: entry.packageHash,
          comfyUiVersion: '1.0.0',
          status: 'verified',
          checkedAt: '2026-07-09T00:00:00.000Z',
          diagnostics: [],
        },
      ])}\n`,
    );

    const listed = await listComfyUiWorkflowLibrary(
      { includeOverridden: true, comfyUiVersion: '1.0.0' },
      options,
    );

    expect(listed.entries[0]).toMatchObject({ onlineStatus: 'unverified' });
  });
  it('discards same-version verification cache records that lack server identity', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'User Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0]!;
    fs.writeFileSync(
      path.join(editorRoot, '.verification-cache.json'),
      `${JSON.stringify({
        schema: 'noveltea.comfyui-workflow-verification-cache',
        schemaVersion: 1,
        records: [
          {
            workflowKey: entry.workflowKey,
            id: entry.id,
            packageHash: entry.packageHash,
            comfyUiVersion: '1.0.0',
            status: 'verified',
            checkedAt: '2026-07-09T00:00:00.000Z',
            diagnostics: [],
          },
        ],
      })}\n`,
    );

    const listed = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: verificationServerIdentity,
        comfyUiVersion: '1.0.0',
      },
      options,
    );
    expect(listed.entries[0]).toMatchObject({ onlineStatus: 'unverified' });
  });

  it('rejects the retired editor-source identity in same-version verification cache records', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'User Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0];
    expect(entry).toBeDefined();
    if (!entry?.id || !entry.packageHash) throw new Error('Expected a valid workflow entry.');
    fs.writeFileSync(
      path.join(editorRoot, '.verification-cache.json'),
      `${JSON.stringify({
        schema: 'noveltea.comfyui-workflow-verification-cache',
        schemaVersion: 1,
        records: [
          {
            workflowKey: 'editor:portrait.manifest.json',
            id: entry.id,
            serverIdentity: verificationServerIdentity,
            packageHash: entry.packageHash,
            comfyUiVersion: '1.0.0',
            status: 'verified',
            checkedAt: '2026-07-09T00:00:00.000Z',
            diagnostics: [],
          },
        ],
      })}\n`,
    );

    const listed = await listComfyUiWorkflowLibrary(
      { includeOverridden: true, comfyUiVersion: '1.0.0' },
      options,
    );

    expect(listed.entries[0]).toMatchObject({
      workflowKey: 'user:portrait.manifest.json',
      onlineStatus: 'unverified',
    });
  });

  it('verifies only the active workflow selected by source precedence', async () => {
    const { builtInRoot, editorRoot, projectRoot, options } = testRoots();
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    writePackage(projectRoot, 'portrait', 'Project Portrait');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/system_stats'))
          return new Response(JSON.stringify({ system: { comfyui_version: '1.0.0' } }), {
            status: 200,
          });
        return new Response(JSON.stringify(compatibleObjectInfo()), { status: 200 });
      }),
    );

    const verified = await verifyComfyUiWorkflowLibrary(
      {
        projectFilePath: '/mock/project/game.json',
        config: {
          enabled: true,
          serverUrl: 'http://127.0.0.1:8188',
          requestTimeoutMs: 1000,
          connectionCheckIntervalMs: 1000,
          defaultWorkflowId: 'portrait',
          defaultWorkflows: {},
        },
      },
      options,
    );

    expect(verified.success).toBe(true);
    expect(verified.verified.map((record) => record.workflowKey)).toEqual([
      'project:portrait.manifest.json',
    ]);
    expect(verified.verified[0]).toMatchObject({ serverIdentity: verificationServerIdentity });
  });

  it('preserves previous successful verification cache when object_info is unavailable', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');
    const first = await listComfyUiWorkflowLibrary({ includeOverridden: true }, options);
    const entry = first.entries[0]!;
    await writeComfyUiWorkflowVerificationCache(
      [
        {
          workflowKey: entry.workflowKey,
          id: entry.id!,
          serverIdentity: 'http://127.0.0.1:8188',
          packageHash: entry.packageHash!,
          comfyUiVersion: '1.0.0',
          status: 'verified',
          checkedAt: '2026-07-09T00:00:00.000Z',
          diagnostics: [],
        },
      ],
      null,
      options,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const failed = await verifyComfyUiWorkflowLibrary(
      {
        config: {
          enabled: true,
          serverUrl: 'http://127.0.0.1:8188',
          requestTimeoutMs: 1000,
          connectionCheckIntervalMs: 1000,
          defaultWorkflowId: 'portrait',
          defaultWorkflows: {},
        },
      },
      options,
    );

    expect(failed.success).toBe(false);
    expect(failed.skipped).toContain('user:portrait.manifest.json');
    const after = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: verificationServerIdentity,
        comfyUiVersion: '1.0.0',
      },
      options,
    );
    expect(after.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });
  });
  it('does not reuse verification cache across different ComfyUI versions', async () => {
    const { editorRoot, options } = testRoots();
    writePackage(editorRoot, 'portrait', 'Editor Portrait');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/system_stats'))
          return new Response(JSON.stringify({ system: { comfyui_version: '1.0.0' } }), {
            status: 200,
          });
        return new Response(JSON.stringify(compatibleObjectInfo()), { status: 200 });
      }),
    );
    const verified = await verifyComfyUiWorkflowLibrary(
      {
        config: {
          enabled: true,
          serverUrl: 'http://127.0.0.1:8188',
          requestTimeoutMs: 1000,
          connectionCheckIntervalMs: 1000,
          defaultWorkflowId: 'portrait',
          defaultWorkflows: {},
        },
      },
      options,
    );
    expect(verified.verified[0]).toMatchObject({ comfyUiVersion: '1.0.0' });

    let listed = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: verificationServerIdentity,
        comfyUiVersion: verified.verified[0]!.comfyUiVersion,
      },
      options,
    );
    expect(listed.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/system_stats'))
          return new Response(JSON.stringify({ system: { comfyui_version: '2.0.0' } }), {
            status: 200,
          });
        return new Response(JSON.stringify(compatibleObjectInfo()), { status: 200 });
      }),
    );
    await verifyComfyUiWorkflowLibrary(
      {
        config: {
          enabled: true,
          serverUrl: 'http://127.0.0.1:8188',
          requestTimeoutMs: 1000,
          connectionCheckIntervalMs: 1000,
          defaultWorkflowId: 'portrait',
          defaultWorkflows: {},
        },
      },
      options,
    );

    const cache = JSON.parse(
      fs.readFileSync(path.join(editorRoot, '.verification-cache.json'), 'utf8'),
    ) as {
      schema: string;
      schemaVersion: number;
      records: Array<{ packageHash: string; comfyUiVersion: string }>;
    };
    expect(cache).toMatchObject({
      schema: 'noveltea.comfyui-workflow-verification-cache',
      schemaVersion: 1,
    });
    expect(new Set(cache.records.map((record) => record.comfyUiVersion))).toEqual(
      new Set(['1.0.0', '2.0.0']),
    );
    listed = await listComfyUiWorkflowLibrary(
      {
        includeOverridden: true,
        serverIdentity: verificationServerIdentity,
        comfyUiVersion: verified.verified[0]!.comfyUiVersion,
      },
      options,
    );
    expect(listed.entries[0]).toMatchObject({ onlineStatus: 'previously-verified' });
  });
});
