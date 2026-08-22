import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { WorkflowLibraryServiceOptions } from '../../main/services/comfyui-workflow-library-service';

const roots: string[] = [];
const previousUserConfigRoot = process.env.NOVELTEA_USER_CONFIG_ROOT;

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-cli-catalog-'));
  roots.push(root);
  return root;
}

function workflow(prompt = 'Tea') {
  return {
    prompt: {
      class_type: 'PrimitiveStringMultiline',
      _meta: { title: 'noveltea.prompt' },
      inputs: { value: prompt, seed: 42 },
    },
    output: {
      class_type: 'SaveImage',
      _meta: { title: 'noveltea.output' },
      inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] },
    },
  };
}

function manifest(id: string, label: string, description = `${label} description`) {
  return {
    schemaVersion: 2,
    id,
    label,
    provider: 'comfyui',
    classification: 'image.generate',
    description,
    workflowFile: `${id}.workflow.json`,
    contract: {
      inputs: {
        prompt: {
          type: 'string',
          required: true,
          authoring: { label: 'Prompt', description: 'Generation prompt', editorField: 'textarea' },
        },
        seed: { type: 'integer', required: false, defaultValue: 42 },
      },
      outputs: {
        images: { mediaType: 'image', required: true, cardinality: 'many' },
      },
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
      seed: [
        {
          nodeId: 'prompt',
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'seed',
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

function writePackage(root: string, id: string, label: string, prompt = 'Tea') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${id}.manifest.json`),
    `${JSON.stringify(manifest(id, label), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, `${id}.workflow.json`),
    `${JSON.stringify(workflow(prompt), null, 2)}\n`,
  );
}

function libraryOptions(builtInRoot: string, userRoot: string): WorkflowLibraryServiceOptions {
  return {
    roots: {
      builtInRoot,
      userRoot,
      cacheFile: path.join(path.dirname(userRoot), 'verification-cache-v1.json'),
    },
  };
}

function writeUserConfig(root: string, serverUrl = 'http://127.0.0.1:8188') {
  const comfyUiRoot = path.join(root, 'comfyui');
  fs.mkdirSync(comfyUiRoot, { recursive: true });
  fs.writeFileSync(
    path.join(comfyUiRoot, 'config-v1.json'),
    `${JSON.stringify({
      format: 'noveltea.comfyui-user-config',
      formatVersion: 1,
      serverUrl,
      requestTimeoutMs: 1000,
      defaultWorkflows: { 'image.generate': 'starter' },
    })}\n`,
  );
}

function compatibleObjectInfo() {
  return {
    PrimitiveStringMultiline: {
      input: { required: { value: [], seed: [] } },
    },
    SaveImage: { input: { required: { images: [], filename_prefix: [] } } },
  };
}

function stubComfyUi(version = '1.2.3', objectInfo: unknown = compatibleObjectInfo()) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/system_stats'))
      return new Response(JSON.stringify({ system: { comfyui_version: version } }), {
        status: 200,
      });
    if (url.includes('/queue'))
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), {
        status: 200,
      });
    if (url.includes('/object_info'))
      return new Response(JSON.stringify(objectInfo), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

function writeProject(root: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'project.json'),
    `${JSON.stringify({ schema: 'noveltea.project.workspace', schemaVersion: 1 })}\n`,
  );
}

function envelope(result: Awaited<ReturnType<typeof runNovelTeaCli>>) {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  if (previousUserConfigRoot === undefined) delete process.env.NOVELTEA_USER_CONFIG_ROOT;
  else process.env.NOVELTEA_USER_CONFIG_ROOT = previousUserConfigRoot;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('noveltea comfyui workflow catalog CLI', () => {
  it('reports project-independent status from shared user config and honors --server override', async () => {
    const root = tempRoot();
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot, 'http://127.0.0.1:8188');
    const fetch_ = stubComfyUi('1.2.3');
    vi.stubGlobal('fetch', fetch_);

    const configured = await runNovelTeaCli(['--json', 'comfyui', 'status'], { cwd: root });
    expect(configured.exitCode).toBe(0);
    expect(configured.stderr).toBe('');
    expect(envelope(configured)).toMatchObject({
      serverUrl: 'http://127.0.0.1:8188',
      comfyUiVersion: '1.2.3',
      queueRemaining: 0,
    });

    const overridden = await runNovelTeaCli(
      ['--json', 'comfyui', 'status', '--server', 'http://127.0.0.1:9191'],
      { cwd: root },
    );
    expect(envelope(overridden)).toMatchObject({ serverUrl: 'http://127.0.0.1:9191' });
    expect(fetch_).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'http://127.0.0.1:9191/system_stats' }),
      expect.any(Object),
    );

    fs.rmSync(path.join(configRoot, 'comfyui', 'config-v1.json'));
    const fallback = await runNovelTeaCli(['--json', 'comfyui', 'status'], { cwd: root });
    expect(envelope(fallback)).toMatchObject({ serverUrl: 'http://127.0.0.1:8000' });

    const rejected = await runNovelTeaCli(['--json', '--project', root, 'comfyui', 'status'], {
      cwd: root,
    });
    expect(rejected.exitCode).toBe(2);
    expect(envelope(rejected).diagnostics).toEqual([
      expect.objectContaining({ code: 'CLI_USAGE', message: expect.stringContaining('--project') }),
    ]);
  });

  it('verifies one active workflow, writes the shared server-scoped cache, and validates mapped inputs', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const configRoot = path.join(root, 'config');
    const userRoot = path.join(configRoot, 'comfyui', 'workflows');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot);
    writePackage(userRoot, 'starter', 'Starter');
    vi.stubGlobal('fetch', stubComfyUi());

    const verified = await runNovelTeaCli(['--json', 'comfyui', 'verify', 'starter'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(verified.exitCode).toBe(0);
    expect(verified.stderr).toBe('');
    expect(envelope(verified)).toMatchObject({
      serverUrl: 'http://127.0.0.1:8188',
      workflowId: 'starter',
      verified: [
        expect.objectContaining({
          id: 'starter',
          serverIdentity: 'http://127.0.0.1:8188',
          comfyUiVersion: '1.2.3',
          status: 'verified',
        }),
      ],
    });
    const cache = JSON.parse(
      fs.readFileSync(path.join(configRoot, 'comfyui', 'verification-cache-v1.json'), 'utf8'),
    ) as { schemaVersion: number; records: Array<{ serverIdentity: string }> };
    expect(cache.schemaVersion).toBe(1);
    expect(cache.records).toContainEqual(
      expect.objectContaining({ serverIdentity: 'http://127.0.0.1:8188' }),
    );

    vi.stubGlobal(
      'fetch',
      stubComfyUi('1.2.3', {
        PrimitiveStringMultiline: { input: { required: { value: [] } } },
        SaveImage: { input: { required: { images: [] } } },
      }),
    );
    const incompatible = await runNovelTeaCli(['--json', 'comfyui', 'verify', 'starter'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(incompatible.exitCode).toBe(4);
    expect(envelope(incompatible).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'COMFYUI_VERIFICATION_FAILED',
        message: expect.stringContaining("missing mapped input 'seed'"),
      }),
    );
  });

  it('fails a missing verify id before network work', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const configRoot = path.join(root, 'config');
    const userRoot = path.join(configRoot, 'comfyui', 'workflows');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot);
    writePackage(userRoot, 'starter', 'Starter');
    const fetch_ = stubComfyUi();
    vi.stubGlobal('fetch', fetch_);

    const result = await runNovelTeaCli(['--json', 'comfyui', 'verify', 'missing'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(4);
    expect(fetch_).not.toHaveBeenCalled();
    expect(envelope(result).diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("'missing'") }),
    );
  });

  it('verifies the active workflow set in the optional Project context', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const configRoot = path.join(root, 'config');
    const userRoot = path.join(configRoot, 'comfyui', 'workflows');
    const projectRoot = path.join(root, 'project');
    const nested = path.join(projectRoot, 'nested');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot);
    writeProject(projectRoot);
    fs.mkdirSync(nested, { recursive: true });
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(userRoot, 'portrait', 'User Portrait');
    writePackage(userRoot, 'user-only', 'User Only');
    writePackage(path.join(projectRoot, 'workflows'), 'portrait', 'Project Portrait');
    vi.stubGlobal('fetch', stubComfyUi());

    const result = await runNovelTeaCli(['--json', 'comfyui', 'verify'], {
      cwd: nested,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(envelope(result)).toMatchObject({ projectRoot });
    const verified = envelope(result).verified as Array<Record<string, unknown>>;
    expect(verified.map((entry) => entry.workflowKey)).toEqual([
      'user:user-only.manifest.json',
      'project:portrait.manifest.json',
    ]);
  });

  it('reports unavailable servers with bounded diagnostics instead of response objects', async () => {
    const root = tempRoot();
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ huge: 'x'.repeat(100_000) }), { status: 503 }),
      ),
    );

    const result = await runNovelTeaCli(['--json', 'comfyui', 'status'], { cwd: root });
    expect(result.exitCode).toBe(4);
    expect(result.stdout.length).toBeLessThan(1000);
    expect(result.stdout).not.toContain('xxxx');
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({
        code: 'COMFYUI_SERVER_UNAVAILABLE',
        message: 'ComfyUI connection check failed.',
      }),
    ]);
  });

  it('lists built-in and shared user workflows without requiring a Project', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(builtInRoot, 'starter', 'Starter');
    writePackage(userRoot, 'custom', 'Custom');

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(envelope(result).workflows).toEqual([
      expect.objectContaining({ id: 'custom', source: 'user', validationStatus: 'valid' }),
      expect.objectContaining({ id: 'starter', source: 'built-in', validationStatus: 'valid' }),
    ]);
    expect(envelope(result)).not.toHaveProperty('projectRoot');
  });

  it('discovers an optional Project and applies project > user > built-in precedence by logical id', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    const projectRoot = path.join(root, 'project');
    const nested = path.join(projectRoot, 'nested');
    writeProject(projectRoot);
    fs.mkdirSync(nested, { recursive: true });
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(userRoot, 'portrait', 'User Portrait');
    writePackage(path.join(projectRoot, 'workflows'), 'portrait', 'Project Portrait');
    writePackage(userRoot, 'user-only', 'User Only');

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows'], {
      cwd: nested,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    const parsed = envelope(result);
    expect(parsed.projectRoot).toBe(projectRoot);
    expect(parsed.workflows).toEqual([
      expect.objectContaining({ id: 'portrait', source: 'project', label: 'Project Portrait' }),
      expect.objectContaining({ id: 'user-only', source: 'user' }),
    ]);
  });

  it('uses user > built-in precedence without a Project', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(userRoot, 'portrait', 'User Portrait');

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(envelope(result).workflows).toEqual([
      expect.objectContaining({ id: 'portrait', source: 'user', label: 'User Portrait' }),
    ]);
  });

  it('inspects the effective workflow contract and authoring metadata in JSON and human modes', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot, 'portrait', 'Portrait');

    const jsonResult = await runNovelTeaCli(['--json', 'comfyui', 'workflows', 'portrait'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    const parsed = envelope(jsonResult);
    expect(parsed.workflow).toMatchObject({
      id: 'portrait',
      source: 'user',
      classification: 'image.generate',
      description: 'Portrait description',
      validationStatus: 'valid',
      verification: { status: 'unverified', diagnostics: [] },
      inputs: {
        prompt: {
          type: 'string',
          required: true,
          authoring: {
            label: 'Prompt',
            description: 'Generation prompt',
            editorField: 'textarea',
          },
        },
        seed: { type: 'integer', required: false, defaultValue: 42 },
      },
      outputs: {
        images: { mediaType: 'image', required: true, cardinality: 'many' },
      },
    });
    expect(jsonResult.stderr).toBe('');

    const human = await runNovelTeaCli(['comfyui', 'workflows', 'portrait'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(human.stdout).toContain('portrait — Portrait');
    expect(human.stdout).toContain('Source: user');
    expect(human.stdout).toContain('prompt: string required (Prompt)');
    expect(human.stdout).toContain('seed: integer optional default=42');
    expect(human.stdout).toContain('images: image many required');
  });

  it('--all exposes overridden and invalid package copies without changing effective precedence', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(builtInRoot, 'portrait', 'Built-in Portrait');
    writePackage(userRoot, 'portrait', 'User Portrait');
    fs.writeFileSync(path.join(userRoot, 'broken.manifest.json'), '{"schemaVersion":2,"id":');

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows', '--all'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const workflows = envelope(result).workflows as Array<Record<string, unknown>>;
    expect(workflows).toContainEqual(
      expect.objectContaining({
        id: 'portrait',
        source: 'user',
        active: true,
        overridden: false,
      }),
    );
    expect(workflows).toContainEqual(
      expect.objectContaining({
        id: 'portrait',
        source: 'built-in',
        active: false,
        overridden: true,
        overriddenBy: 'user:portrait.manifest.json',
      }),
    );
    expect(workflows).toContainEqual(
      expect.objectContaining({
        id: null,
        source: 'user',
        manifestFile: 'broken.manifest.json',
        validationStatus: 'invalid',
      }),
    );
  });

  it('honors NOVELTEA_USER_CONFIG_ROOT for the default shared user workflow area', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writePackage(path.join(configRoot, 'comfyui', 'workflows'), 'configured', 'Configured');

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: { roots: { builtInRoot } },
    });

    expect(envelope(result).workflows).toEqual([
      expect.objectContaining({ id: 'configured', source: 'user' }),
    ]);
  });

  it('bounds package parsing and surfaces oversized packages as invalid under --all', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    fs.mkdirSync(userRoot, { recursive: true });
    fs.writeFileSync(path.join(userRoot, 'oversized.manifest.json'), ' '.repeat(1024 * 1024 + 1));

    const result = await runNovelTeaCli(['--json', 'comfyui', 'workflows', '--all'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(envelope(result).workflows).toContainEqual(
      expect.objectContaining({
        manifestFile: 'oversized.manifest.json',
        source: 'user',
        validationStatus: 'invalid',
        diagnostics: [
          expect.objectContaining({ message: expect.stringContaining('catalog parsing limit') }),
        ],
      }),
    );
  });

  it('fails explicit invalid Projects but treats absence of a discovered Project as optional', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(builtInRoot, 'starter', 'Starter');

    const optional = await runNovelTeaCli(['--json', 'comfyui', 'workflows'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(optional.exitCode).toBe(0);

    const explicit = await runNovelTeaCli(
      ['--json', '--project', path.join(root, 'missing'), 'comfyui', 'workflows'],
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(explicit.exitCode).toBe(3);
    expect(envelope(explicit).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }),
    );
  });

  it('rejects ambiguous or unsupported workflow-list arguments', async () => {
    const root = tempRoot();
    const options = {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(
        path.join(root, 'built-in'),
        path.join(root, 'user'),
      ),
    };

    const ambiguous = await runNovelTeaCli(
      ['--json', 'comfyui', 'workflows', 'portrait', '--all'],
      options,
    );
    expect(ambiguous.exitCode).toBe(2);
    expect(envelope(ambiguous).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CLI_USAGE' }),
    );

    const unknown = await runNovelTeaCli(['--json', 'comfyui', 'workflows', '--unknown'], options);
    expect(unknown.exitCode).toBe(2);
  });
});
