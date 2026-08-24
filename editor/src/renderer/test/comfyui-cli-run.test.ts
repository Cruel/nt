import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import {
  configureImageInspectionService,
  resetImageInspectionService,
} from '../../main/services/image-inspection-service';
import type { WorkflowLibraryServiceOptions } from '../../main/services/comfyui-workflow-library-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  createNodeProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

const tempRoots: string[] = [];
const servers: http.Server[] = [];
const previousUserConfigRoot = process.env.NOVELTEA_USER_CONFIG_ROOT;

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-run-'));
  tempRoots.push(root);
  return root;
}

function manifest(id = 'scalar-run') {
  return {
    schemaVersion: 1,
    id,
    label: 'Scalar Run',
    provider: 'comfyui',
    workflowFile: `${id}.workflow.json`,
    contract: {
      inputs: {
        text: { type: 'string', required: true },
        count: { type: 'integer', required: false, defaultValue: 3 },
        strength: { type: 'number', required: true },
        enabled: { type: 'boolean', required: true },
      },
      outputs: {
        image: { mediaType: 'image', required: true, cardinality: 'one' },
      },
    },
    requiredNodeClasses: ['ScalarNode', 'SaveImage'],
    bindings: {
      text: [
        { nodeId: 'a', classType: 'ScalarNode', inputName: 'text' },
        { nodeId: 'b', classType: 'ScalarNode', inputName: 'text' },
      ],
      count: [{ nodeId: 'a', classType: 'ScalarNode', inputName: 'count' }],
      strength: [{ nodeId: 'a', classType: 'ScalarNode', inputName: 'strength' }],
      enabled: [{ nodeId: 'a', classType: 'ScalarNode', inputName: 'enabled' }],
    },
    outputBindings: {
      image: [{ nodeId: 'out', classType: 'SaveImage' }],
    },
  };
}

function workflow() {
  return {
    a: {
      class_type: 'ScalarNode',
      inputs: { text: '', count: 0, strength: 0, enabled: false },
    },
    b: { class_type: 'ScalarNode', inputs: { text: '' } },
    out: { class_type: 'SaveImage', inputs: { images: ['a', 0], filename_prefix: 'NovelTea' } },
  };
}

function imageManifest(id = 'image-run') {
  return {
    ...manifest(id),
    label: 'Image Run',
    contract: {
      inputs: {
        source: { type: 'image', required: true },
        text: { type: 'string', required: true },
      },
      outputs: {
        image: { mediaType: 'image', required: true, cardinality: 'one' },
      },
    },
    requiredNodeClasses: ['LoadImage', 'ScalarNode', 'SaveImage'],
    bindings: {
      source: [
        { nodeId: 'load', classType: 'LoadImage', inputName: 'image' },
        { nodeId: 'copy', classType: 'LoadImage', inputName: 'image' },
      ],
      text: [{ nodeId: 'a', classType: 'ScalarNode', inputName: 'text' }],
    },
  };
}

function imageWorkflow() {
  return {
    load: { class_type: 'LoadImage', inputs: { image: '' } },
    copy: { class_type: 'LoadImage', inputs: { image: '' } },
    a: { class_type: 'ScalarNode', inputs: { text: '' } },
    out: { class_type: 'SaveImage', inputs: { images: ['load', 0], filename_prefix: 'NovelTea' } },
  };
}

function multiManifest(id = 'multi-run') {
  return {
    ...manifest(id),
    label: 'Multi Run',
    contract: {
      inputs: manifest(id).contract.inputs,
      outputs: {
        preview: { mediaType: 'image', required: true, cardinality: 'one' },
        variants: { mediaType: 'image', required: true, cardinality: 'many' },
        optional: { mediaType: 'image', required: false, cardinality: 'one' },
        extras: { mediaType: 'image', required: false, cardinality: 'many' },
      },
    },
    outputBindings: {
      preview: [{ nodeId: 'preview', classType: 'SaveImage' }],
      variants: [{ nodeId: 'variants', classType: 'SaveImage' }],
      optional: [{ nodeId: 'optional', classType: 'SaveImage' }],
      extras: [{ nodeId: 'extras', classType: 'SaveImage' }],
    },
  };
}

function multiWorkflow() {
  return {
    ...workflow(),
    preview: { class_type: 'SaveImage', inputs: { images: ['a', 0] } },
    variants: { class_type: 'SaveImage', inputs: { images: ['a', 0] } },
    optional: { class_type: 'SaveImage', inputs: { images: ['a', 0] } },
    extras: { class_type: 'SaveImage', inputs: { images: ['a', 0] } },
  };
}

function writePackage(root: string, id = 'scalar-run', classification?: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${id}.manifest.json`),
    `${JSON.stringify({ ...manifest(id), ...(classification ? { classification } : {}) }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, `${id}.workflow.json`),
    `${JSON.stringify(workflow(), null, 2)}\n`,
  );
}

function writeMultiPackage(root: string, id = 'multi-run') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${id}.manifest.json`),
    `${JSON.stringify(multiManifest(id), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, `${id}.workflow.json`),
    `${JSON.stringify(multiWorkflow(), null, 2)}\n`,
  );
}

function writeUserConfig(configRoot: string, defaultWorkflows: Record<string, string>) {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.json'),
    `${JSON.stringify({
      format: 'noveltea.user-config',
      formatVersion: 1,
      comfyui: {
        serverUrl: 'http://127.0.0.1:8000',
        requestTimeoutMs: 15000,
        defaultWorkflows,
      },
    })}\n`,
  );
}

function writeProject(root: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'project.json'),
    `${JSON.stringify({ schema: 'noveltea.project.workspace', schemaVersion: 1 })}\n`,
  );
}

function writeImagePackage(root: string, id = 'image-run') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${id}.manifest.json`),
    `${JSON.stringify(imageManifest(id), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, `${id}.workflow.json`),
    `${JSON.stringify(imageWorkflow(), null, 2)}\n`,
  );
}

function writeProjectWorkspace(root: string) {
  const project = createAuthoringProject({ id: 'comfyui-run', name: 'ComfyUI Run' });
  for (const [relativePath, text] of Object.entries(
    projectWorkspaceFiles(project, project.editor),
  )) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, text);
  }
  return project;
}

function libraryOptions(builtInRoot: string, userRoot: string): WorkflowLibraryServiceOptions {
  return {
    roots: {
      builtInRoot,
      userRoot,
      cacheFile: path.join(path.dirname(userRoot), 'verification-cache.json'),
    },
  };
}

function png() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3XQAAAAASUVORK5CYII=',
    'base64',
  );
}

interface FakeServerOptions {
  completeAfterHistoryCalls?: number;
  imageBytes?: Buffer;
  imageContentLength?: number;
  historyOutputs?: Record<
    string,
    { images?: Array<{ filename: string; subfolder?: string; type?: string }> }
  >;
  viewBytesByFilename?: Record<string, Buffer>;
  neverComplete?: boolean;
  uploadStatus?: number;
  host?: string;
  onPrompt?: () => void;
}

async function fakeComfyUi(options: FakeServerOptions = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const historyCalls = new Map<string, number>();
  let queueDeleteResolve!: (value: unknown) => void;
  const queueDelete = new Promise<unknown>((resolve) => {
    queueDeleteResolve = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const requestPath = request.url ?? '/';
      requests.push({ method: request.method ?? 'GET', path: requestPath, body });
      response.setHeader('Content-Type', 'application/json');
      if (requestPath === '/system_stats') {
        response.end(JSON.stringify({ system: { comfyui_version: '1.2.3' } }));
        return;
      }
      if (requestPath === '/object_info') {
        response.end(
          JSON.stringify({
            ScalarNode: {
              input: {
                required: { text: {}, count: {}, strength: {}, enabled: {} },
              },
            },
            LoadImage: { input: { required: { image: {} } } },
            SaveImage: { input: { required: { images: {}, filename_prefix: {} } } },
          }),
        );
        return;
      }
      if (requestPath === '/upload/image' && request.method === 'POST') {
        if (options.uploadStatus && options.uploadStatus !== 200) {
          response.statusCode = options.uploadStatus;
          response.end(JSON.stringify({ error: 'upload failed' }));
          return;
        }
        const filename = raw.match(/filename="([^"]+)"/)?.[1] ?? 'missing.png';
        response.end(JSON.stringify({ name: filename, subfolder: 'noveltea' }));
        return;
      }
      if (requestPath === '/prompt' && request.method === 'POST') {
        const promptId = (body as { prompt_id?: string })?.prompt_id;
        options.onPrompt?.();
        response.end(JSON.stringify({ prompt_id: promptId, number: 0 }));
        return;
      }
      if (requestPath.startsWith('/history/')) {
        const promptId = decodeURIComponent(requestPath.slice('/history/'.length));
        const calls = (historyCalls.get(promptId) ?? 0) + 1;
        historyCalls.set(promptId, calls);
        if (options.neverComplete || calls < (options.completeAfterHistoryCalls ?? 2)) {
          response.end(
            JSON.stringify({ [promptId]: { status: { completed: false }, outputs: {} } }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            [promptId]: {
              status: { completed: true, status_str: 'success' },
              outputs: options.historyOutputs ?? {
                out: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] },
              },
            },
          }),
        );
        return;
      }
      if (requestPath.startsWith('/view?')) {
        const filename =
          new URL(requestPath, 'http://127.0.0.1').searchParams.get('filename') ?? '';
        const bytes = options.viewBytesByFilename?.[filename] ?? options.imageBytes ?? png();
        response.setHeader('Content-Type', 'image/png');
        response.setHeader(
          'Content-Length',
          String(options.imageContentLength ?? bytes.byteLength),
        );
        response.end(bytes);
        return;
      }
      if (requestPath === '/queue' && request.method === 'POST') {
        queueDeleteResolve(body);
        response.end('{}');
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
  });
  servers.push(server);
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server.');
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    requests,
    queueDelete,
  };
}

function envelope(result: Awaited<ReturnType<typeof runNovelTeaCli>>) {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function configureImageInspection() {
  configureImageInspectionService(async () => ({ width: 1, height: 1, hasAlpha: true }));
}

function imageRunArguments(server: string, source: string, output: string) {
  return [
    '--json',
    'comfyui',
    'run',
    'image-run',
    '--input',
    `source=${source}`,
    '--input',
    'text=edit this',
    '--output',
    output,
    '--server',
    server,
  ];
}

function runArguments(server: string, output: string) {
  return [
    '--json',
    'comfyui',
    'run',
    'scalar-run',
    '--input',
    'text=a=b=c',
    '--input',
    'strength=1.25',
    '--input',
    'enabled=true',
    '--output',
    output,
    '--server',
    server,
  ];
}

function multiRunArguments(server: string, routes: string[] = []) {
  return [
    '--json',
    'comfyui',
    'run',
    'multi-run',
    '--input',
    'text=multi',
    '--input',
    'strength=1.25',
    '--input',
    'enabled=true',
    ...routes.flatMap((route) => ['--output', route]),
    '--server',
    server,
  ];
}

afterEach(async () => {
  if (previousUserConfigRoot === undefined) delete process.env.NOVELTEA_USER_CONFIG_ROOT;
  else process.env.NOVELTEA_USER_CONFIG_ROOT = previousUserConfigRoot;
  resetImageInspectionService();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('noveltea comfyui run scalar filesystem execution', () => {
  it('runs through the public CLI with typed/default inputs, binding fan-out, polling, and filesystem publication', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 2 });
    const output = path.join('nested', 'result.png');

    const result = await runNovelTeaCli(runArguments(server.url, output), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    const parsed = envelope(result);
    expect(parsed).toMatchObject({
      success: true,
      serverUrl: server.url,
      workflow: { id: 'scalar-run', source: 'user' },
      outputs: {
        image: {
          outputId: 'image',
          target: 'filesystem',
          path: path.join(root, output),
          format: 'png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          byteSize: 68,
        },
      },
    });
    expect(typeof parsed.promptId).toBe('string');
    expect(typeof parsed.clientId).toBe('string');
    expect(fs.readFileSync(path.join(root, output))).toEqual(png());

    const submission = server.requests.find((request) => request.path === '/prompt');
    expect(submission?.body).toMatchObject({
      prompt: {
        a: { inputs: { text: 'a=b=c', count: 3, strength: 1.25, enabled: true } },
        b: { inputs: { text: 'a=b=c' } },
      },
    });
    expect(server.requests.filter((request) => request.path.startsWith('/history/'))).toHaveLength(
      2,
    );
    const objectInfoIndex = server.requests.findIndex((request) => request.path === '/object_info');
    const promptIndex = server.requests.findIndex((request) => request.path === '/prompt');
    expect(objectInfoIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThan(objectInfoIndex);
  });

  it('runs a configured default by future dotted classification without guessing a workflow', async () => {
    const root = tempRoot();
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot, { 'audio.generate': 'scalar-run' });
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot, 'scalar-run', 'audio.generate');
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });

    const result = await runNovelTeaCli(
      [
        '--json',
        'comfyui',
        'run',
        '--type',
        'audio.generate',
        '--input',
        'text=hello',
        '--input',
        'strength=1',
        '--input',
        'enabled=true',
        '--output',
        'typed.png',
        '--server',
        server.url,
      ],
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(envelope(result)).toMatchObject({
      workflow: { id: 'scalar-run', source: 'user' },
    });
  });

  it('rejects ambiguous or missing workflow selection before network work', async () => {
    const root = tempRoot();
    const server = await fakeComfyUi();
    const common = [
      '--json',
      'comfyui',
      'run',
      '--input',
      'text=hello',
      '--input',
      'strength=1',
      '--input',
      'enabled=true',
      '--output',
      'out.png',
      '--server',
      server.url,
    ];

    const missing = await runNovelTeaCli(common, { cwd: root });
    const ambiguous = await runNovelTeaCli(
      [...common.slice(0, 3), 'scalar-run', '--type', 'image.generate', ...common.slice(3)],
      { cwd: root },
    );
    expect(missing.exitCode).toBe(2);
    expect(ambiguous.exitCode).toBe(2);
    expect(server.requests).toEqual([]);
  });

  it('fails targeted default resolution when the classification is unconfigured or its configured workflow is unavailable', async () => {
    const root = tempRoot();
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    const server = await fakeComfyUi();
    const args = (classification: string) => [
      '--json',
      'comfyui',
      'run',
      '--type',
      classification,
      '--output',
      'out.png',
      '--server',
      server.url,
    ];

    writeUserConfig(configRoot, {});
    const unconfigured = await runNovelTeaCli(args('audio.generate'), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(unconfigured.exitCode).toBe(4);
    expect(envelope(unconfigured).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_DEFAULT_WORKFLOW_NOT_CONFIGURED' }),
    ]);

    writeUserConfig(configRoot, { 'audio.generate': 'missing-audio' });
    const unavailable = await runNovelTeaCli(args('audio.generate'), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(unavailable.exitCode).toBe(4);
    expect(envelope(unavailable).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_DEFAULT_WORKFLOW_UNAVAILABLE' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('resolves a configured logical default through project over user precedence', async () => {
    const root = tempRoot();
    writeProject(root);
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot, { 'image.generate': 'scalar-run' });
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot, 'scalar-run', 'image.generate');
    writePackage(path.join(root, 'workflows'), 'scalar-run', 'image.generate');
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });

    const result = await runNovelTeaCli(
      [
        '--json',
        'comfyui',
        'run',
        '--type',
        'image.generate',
        '--input',
        'text=hello',
        '--input',
        'strength=1',
        '--input',
        'enabled=true',
        '--output',
        'project-default.png',
        '--server',
        server.url,
      ],
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(envelope(result)).toMatchObject({
      projectRoot: root,
      workflow: { id: 'scalar-run', source: 'project' },
    });
  });

  it('rejects a configured default whose active workflow has a different classification', async () => {
    const root = tempRoot();
    const configRoot = path.join(root, 'config');
    process.env.NOVELTEA_USER_CONFIG_ROOT = configRoot;
    writeUserConfig(configRoot, { 'audio.generate': 'scalar-run' });
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot, 'scalar-run', 'image.generate');
    const server = await fakeComfyUi();

    const result = await runNovelTeaCli(
      [
        '--json',
        'comfyui',
        'run',
        '--type',
        'audio.generate',
        '--output',
        'mismatch.png',
        '--server',
        server.url,
      ],
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_DEFAULT_WORKFLOW_CLASSIFICATION_MISMATCH' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('rejects duplicate, unknown, missing, and invalid scalar inputs before any network work', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi();
    const base = [
      '--json',
      'comfyui',
      'run',
      'scalar-run',
      '--output',
      'out.png',
      '--server',
      server.url,
    ];
    const cases = [
      [
        ...base,
        '--input',
        'text=a',
        '--input',
        'text=b',
        '--input',
        'strength=1',
        '--input',
        'enabled=true',
      ],
      [
        ...base,
        '--input',
        'unknown=x',
        '--input',
        'text=a',
        '--input',
        'strength=1',
        '--input',
        'enabled=true',
      ],
      [...base, '--input', 'text=a', '--input', 'enabled=true'],
      [...base, '--input', 'text=a', '--input', 'strength=nope', '--input', 'enabled=true'],
      [...base, '--input', 'text=a', '--input', 'strength=1', '--input', 'enabled=yes'],
    ];

    for (const argv of cases) {
      const result = await runNovelTeaCli(argv, {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe('');
    }
    expect(server.requests).toEqual([]);
  });

  it('fails an existing destination before submission and replaces it only with --force', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const output = path.join(root, 'result.png');
    fs.writeFileSync(output, 'existing');

    const refused = await runNovelTeaCli(runArguments(server.url, output), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(refused.exitCode).toBe(4);
    expect(envelope(refused).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_EXISTS' }),
    ]);
    expect(server.requests).toEqual([]);

    const forced = await runNovelTeaCli([...runArguments(server.url, output), '--force'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(forced.exitCode).toBe(0);
    expect(fs.readFileSync(output)).toEqual(png());
  });

  it('rejects a destination extension mismatch after remote success without publishing bytes', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const output = path.join(root, 'wrong.jpg');

    const result = await runNovelTeaCli(runArguments(server.url, output), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });

    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_EXTENSION' }),
    ]);
    expect(fs.existsSync(output)).toBe(false);
    expect(server.requests.some((request) => request.path.startsWith('/view?'))).toBe(true);
  });

  it('rejects malformed and oversized returned images before filesystem publication', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);

    const malformedServer = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      imageBytes: Buffer.from('not-an-image'),
    });
    const malformedOutput = path.join(root, 'malformed.png');
    const malformed = await runNovelTeaCli(runArguments(malformedServer.url, malformedOutput), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(malformed.exitCode).toBe(4);
    expect(envelope(malformed).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_INVALID' }),
    ]);
    expect(fs.existsSync(malformedOutput)).toBe(false);

    const oversizedServer = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      imageContentLength: 32 * 1024 * 1024 + 1,
    });
    const oversizedOutput = path.join(root, 'oversized.png');
    const oversized = await runNovelTeaCli(runArguments(oversizedServer.url, oversizedOutput), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(oversized.exitCode).toBe(4);
    expect(envelope(oversized).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_RESPONSE_TOO_LARGE' }),
    ]);
    expect(fs.existsSync(oversizedOutput)).toBe(false);
  });

  it('uploads a validated relative image input to loopback, hides the local basename, and binds the returned reference to every graph binding', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    configureImageInspection();
    fs.mkdirSync(path.join(root, 'inputs'), { recursive: true });
    const source = path.join(root, 'inputs', 'private-source-name.png');
    fs.writeFileSync(source, png());
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const output = path.join(root, 'result.png');

    const result = await runNovelTeaCli(
      imageRunArguments(server.url, path.relative(root, source), output),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(output)).toEqual(png());
    const upload = server.requests.find((request) => request.path === '/upload/image');
    expect(upload).toBeDefined();
    expect(String(upload?.body)).not.toContain('private-source-name');
    expect(String(upload?.body)).toMatch(/filename="noveltea-[^"]+\.png"/);
    const prompt = server.requests.find((request) => request.path === '/prompt')?.body as {
      prompt?: Record<string, { inputs?: Record<string, unknown> }>;
    };
    expect(prompt.prompt?.load.inputs?.image).toMatch(/^noveltea\/noveltea-.*\.png$/);
    expect(prompt.prompt?.copy.inputs?.image).toBe(prompt.prompt?.load.inputs?.image);
    expect(server.requests.findIndex((request) => request.path === '/object_info')).toBeLessThan(
      server.requests.findIndex((request) => request.path === '/upload/image'),
    );
    expect(server.requests.findIndex((request) => request.path === '/upload/image')).toBeLessThan(
      server.requests.findIndex((request) => request.path === '/prompt'),
    );
  });

  it('rejects unsafe local-image upload targets before any network request while text-only runs remain remote-capable', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    writePackage(userRoot, 'scalar-run');
    configureImageInspection();
    const source = path.join(root, 'source.png');
    fs.writeFileSync(source, png());
    const output = path.join(root, 'result.png');
    const unsafeServers = [
      'http://localhost:8188',
      'http://user:pass@127.0.0.1:8188',
      'https://127.0.0.1:8188',
      'http://192.168.1.10:8188',
      'http://example.com:8188',
    ];

    for (const serverUrl of unsafeServers) {
      const result = await runNovelTeaCli(imageRunArguments(serverUrl, source, output), {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      });
      expect(result.exitCode).toBe(4);
      expect(envelope(result).diagnostics).toEqual([
        expect.objectContaining({ code: 'COMFYUI_UPLOAD_TARGET_DENIED' }),
      ]);
    }

    const remoteText = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const textServer = remoteText.url.replace('127.0.0.1', 'localhost');
    const textResult = await runNovelTeaCli(
      runArguments(textServer, path.join(root, 'text-only.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(textResult.exitCode).toBe(0);
  });

  it('accepts IPv6 and IPv4-mapped IPv6 loopback image-upload targets', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    configureImageInspection();
    const source = path.join(root, 'source.png');
    fs.writeFileSync(source, png());
    const ipv4Server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const mappedServer = ipv4Server.url.replace('127.0.0.1', '[::ffff:127.0.0.1]');
    const mapped = await runNovelTeaCli(
      imageRunArguments(mappedServer, source, path.join(root, 'mapped.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(mapped.exitCode).toBe(0);

    let server;
    try {
      server = await fakeComfyUi({ completeAfterHistoryCalls: 1, host: '::1' });
    } catch {
      return;
    }

    const result = await runNovelTeaCli(
      imageRunArguments(server.url, source, path.join(root, 'ipv6.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(server.requests.some((request) => request.path === '/upload/image')).toBe(true);
  });

  it('honors native decode rejection before verification or upload', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    configureImageInspectionService(async () => {
      throw new Error('decode failed');
    });
    const source = path.join(root, 'looks-valid.png');
    fs.writeFileSync(source, png());
    const server = await fakeComfyUi();

    const result = await runNovelTeaCli(
      imageRunArguments(server.url, source, path.join(root, 'decode-out.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_INPUT_IMAGE_INVALID' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('rejects malformed and oversized local images before verification or upload', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    configureImageInspection();
    const server = await fakeComfyUi();

    const malformed = path.join(root, 'broken.png');
    fs.writeFileSync(malformed, 'not an image');
    const malformedResult = await runNovelTeaCli(
      imageRunArguments(server.url, malformed, path.join(root, 'broken-out.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(malformedResult.exitCode).toBe(4);
    expect(server.requests).toEqual([]);

    const oversized = path.join(root, 'oversized.png');
    fs.writeFileSync(oversized, Buffer.alloc(32 * 1024 * 1024 + 1));
    const oversizedResult = await runNovelTeaCli(
      imageRunArguments(server.url, oversized, path.join(root, 'oversized-out.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(oversizedResult.exitCode).toBe(4);
    expect(envelope(oversizedResult).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_INPUT_IMAGE_TOO_LARGE' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('aborts before prompt submission when image upload fails', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeImagePackage(userRoot);
    configureImageInspection();
    const source = path.join(root, 'source.png');
    fs.writeFileSync(source, png());
    const server = await fakeComfyUi({ uploadStatus: 500 });

    const result = await runNovelTeaCli(
      imageRunArguments(server.url, source, path.join(root, 'result.png')),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(4);
    expect(server.requests.some((request) => request.path === '/upload/image')).toBe(true);
    expect(server.requests.some((request) => request.path === '/prompt')).toBe(false);
  });

  it('publishes to a normal Project Asset by default when --output is omitted', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });

    const result = await runNovelTeaCli(
      runArguments(server.url, 'ignored.png').filter(
        (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
      ),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );

    expect(result.exitCode).toBe(0);
    const parsed = envelope(result);
    const output = (parsed.outputs as Record<string, Record<string, unknown>>).image;
    expect(output).toMatchObject({
      target: 'asset',
      projectRelativePath: expect.stringMatching(/^assets\/generated\//),
    });
    const assetId = output.assetId as string;
    const recordPath = path.join(root, 'records', 'assets', `${assetId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      id: assetId,
      data: { source: { type: 'project-file', path: output.projectRelativePath } },
    });
    expect(fs.readFileSync(path.join(root, output.projectRelativePath as string))).toEqual(png());
    expect(assetId).toMatch(/^scalar-run-/);
  });

  it('keeps an explicit filesystem route definitive even when a Project is available', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const outputPath = path.join(root, 'explicit.png');
    const result = await runNovelTeaCli(runArguments(server.url, outputPath), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    expect(
      (envelope(result).outputs as Record<string, Record<string, unknown>>).image,
    ).toMatchObject({
      target: 'filesystem',
      path: outputPath,
    });
    expect(fs.existsSync(path.join(root, 'records', 'assets'))).toBe(false);
  });

  it('requires explicit filesystem output outside a Project before any network work', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi();
    const result = await runNovelTeaCli(
      runArguments(server.url, 'ignored.png').filter(
        (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
      ),
      { cwd: root, comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot) },
    );
    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_ROUTE_REQUIRED' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('reopens latest Project state after remote success and preserves unrelated edits', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writePackage(userRoot);
    let edited = false;
    let writerLockObserved = false;
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 2,
      onPrompt: () => {
        writerLockObserved = fs.existsSync(
          path.join(root, '.noveltea', 'transactions', '.writer-lock'),
        );
        if (edited) return;
        edited = true;
        const projectFile = path.join(root, 'project.json');
        const document = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as {
          project: { name: string };
        };
        document.project.name = 'Edited During Generation';
        fs.writeFileSync(projectFile, `${JSON.stringify(document, null, 2)}\n`);
      },
    });
    const argv = runArguments(server.url, 'ignored.png').filter(
      (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
    );
    const result = await runNovelTeaCli(argv, {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    expect(writerLockObserved).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'))).toMatchObject({
      project: { name: 'Edited During Generation' },
    });
  });

  it('reports remote-success/local-publication failure distinctly when the Project disappears', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      onPrompt: () => fs.rmSync(path.join(root, 'project.json')),
    });
    const argv = runArguments(server.url, 'ignored.png').filter(
      (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
    );
    const result = await runNovelTeaCli(argv, {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID' }),
    ]);
    expect(server.requests.some((request) => request.path === '/prompt')).toBe(true);
    expect(server.requests.some((request) => request.path.startsWith('/view?'))).toBe(true);
  });

  it('keeps publication tied to the captured project-local workflow package when that package changes during the job', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    const projectWorkflows = path.join(root, 'workflows');
    writePackage(projectWorkflows);
    const inspected = await runNovelTeaCli(['--json', 'comfyui', 'workflows', 'scalar-run'], {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(inspected.exitCode).toBe(0);
    const capturedHash = (envelope(inspected).workflow as { packageHash: string }).packageHash;
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 2,
      onPrompt: () => {
        const workflowPath = path.join(projectWorkflows, 'scalar-run.workflow.json');
        const changed = workflow();
        changed.a.inputs.text = 'changed-after-submit';
        fs.writeFileSync(workflowPath, `${JSON.stringify(changed, null, 2)}\n`);
      },
    });
    const argv = runArguments(server.url, 'ignored.png').filter(
      (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
    );
    const result = await runNovelTeaCli(argv, {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    expect(envelope(result).workflow).toMatchObject({
      source: 'project',
      packageHash: capturedHash,
    });
  });

  it('allows concurrent remote runs to publish independent Assets without clobbering', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writePackage(userRoot);
    const fast = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const slow = await fakeComfyUi({ completeAfterHistoryCalls: 3 });
    const withoutOutput = (serverUrl: string) =>
      runArguments(serverUrl, 'ignored.png').filter(
        (value, index, values) => value !== '--output' && values[index - 1] !== '--output',
      );
    const [left, right] = await Promise.all([
      runNovelTeaCli(withoutOutput(fast.url), {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      }),
      runNovelTeaCli(withoutOutput(slow.url), {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      }),
    ]);
    expect(left.exitCode).toBe(0);
    expect(right.exitCode).toBe(0);
    const leftId = (envelope(left).outputs as Record<string, Record<string, unknown>>).image
      .assetId as string;
    const rightId = (envelope(right).outputs as Record<string, Record<string, unknown>>).image
      .assetId as string;
    expect(leftId).not.toBe(rightId);
    expect(fs.existsSync(path.join(root, 'records', 'assets', `${leftId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, 'records', 'assets', `${rightId}.json`))).toBe(true);
  });

  it('supports named mixed routing with one/many and optional output semantics', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: {
          images: [{ filename: 'variant-a.png' }, { filename: 'variant-b.png' }],
        },
      },
    });
    const previewPath = path.join(root, 'scratch', 'preview.png');
    const result = await runNovelTeaCli(multiRunArguments(server.url, [`preview=${previewPath}`]), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    const outputs = envelope(result).outputs as Record<string, unknown>;
    expect(outputs.preview).toMatchObject({ target: 'filesystem', path: previewPath });
    expect(outputs.variants).toEqual([
      expect.objectContaining({ target: 'asset', assetId: expect.any(String) }),
      expect.objectContaining({ target: 'asset', assetId: expect.any(String) }),
    ]);
    expect(outputs.optional).toBeNull();
    expect(outputs.extras).toEqual([]);
    expect(fs.readFileSync(previewPath)).toEqual(png());
  });

  it('requires named routing for multi-output workflows and complete filesystem routing without a Project', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const bare = await runNovelTeaCli(
      multiRunArguments(server.url, [path.join(root, 'bare.png')]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(bare.exitCode).toBe(2);
    const incomplete = await runNovelTeaCli(
      multiRunArguments(server.url, [
        `preview=${path.join(root, 'preview.png')}`,
        `variants=${path.join(root, 'variants')}`,
      ]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(incomplete.exitCode).toBe(4);
    expect(envelope(incomplete).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_ROUTE_REQUIRED' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('runs multi-output workflows without a Project when every named output has a filesystem route', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'variant.png' }] },
      },
    });
    const previewPath = path.join(root, 'preview.png');
    const variantsDir = path.join(root, 'variants');
    const optionalPath = path.join(root, 'optional.png');
    const extrasDir = path.join(root, 'extras');
    const result = await runNovelTeaCli(
      multiRunArguments(server.url, [
        `preview=${previewPath}`,
        `variants=${variantsDir}`,
        `optional=${optionalPath}`,
        `extras=${extrasDir}`,
      ]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(result.exitCode).toBe(0);
    const outputs = envelope(result).outputs as Record<string, unknown>;
    expect(outputs.preview).toMatchObject({ target: 'filesystem', path: previewPath });
    expect(outputs.variants).toEqual([
      expect.objectContaining({ target: 'filesystem', path: expect.stringContaining(variantsDir) }),
    ]);
    expect(outputs.optional).toBeNull();
    expect(outputs.extras).toEqual([]);
    expect(fs.existsSync(optionalPath)).toBe(false);
  });

  it('enforces required one/many cardinality before publishing anything', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'a.png' }, { filename: 'b.png' }] },
        variants: { images: [] },
      },
    });
    const explicit = path.join(root, 'preview.png');
    const result = await runNovelTeaCli(multiRunArguments(server.url, [`preview=${explicit}`]), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_CARDINALITY' }),
    ]);
    expect(fs.existsSync(explicit)).toBe(false);
    expect(fs.existsSync(path.join(root, 'records', 'assets'))).toBe(false);
  });

  it('writes cardinality-many filesystem outputs into a directory with generated filenames', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'remote-one.png' }, { filename: 'remote-two.png' }] },
      },
    });
    const directory = path.join(root, 'variants-out');
    const result = await runNovelTeaCli(multiRunArguments(server.url, [`variants=${directory}`]), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    const variants = (envelope(result).outputs as Record<string, unknown>).variants as Array<{
      path: string;
    }>;
    expect(variants).toHaveLength(2);
    expect(variants.every((value) => path.dirname(value.path) === directory)).toBe(true);
    expect(variants.every((value) => path.basename(value.path).startsWith('variants-'))).toBe(true);
  });

  it('rejects duplicate named routes and conflicting one-valued filesystem destinations before submission', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });
    const destination = path.join(root, 'same.png');

    const duplicate = await runNovelTeaCli(
      multiRunArguments(server.url, [`preview=${destination}`, `preview=${destination}.other`]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(duplicate.exitCode).toBe(2);

    const conflicting = await runNovelTeaCli(
      multiRunArguments(server.url, [`preview=${destination}`, `optional=${destination}`]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(conflicting.exitCode).toBe(4);
    expect(envelope(conflicting).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_DESTINATION_CONFLICT' }),
    ]);
    expect(server.requests).toEqual([]);
  });

  it('rejects a missing required-many result and too many optional-one results', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);

    const missingMany = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [] },
      },
    });
    const missing = await runNovelTeaCli(multiRunArguments(missingMany.url), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(missing.exitCode).toBe(4);
    expect(envelope(missing).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_MISSING' }),
    ]);

    const tooManyOptional = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'variant.png' }] },
        optional: { images: [{ filename: 'one.png' }, { filename: 'two.png' }] },
      },
    });
    const optional = await runNovelTeaCli(multiRunArguments(tooManyOptional.url), {
      cwd: root,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(optional.exitCode).toBe(4);
    expect(envelope(optional).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_CARDINALITY' }),
    ]);
  });

  it('applies collision and --force semantics to generated files for many-valued filesystem routes', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const historyOutputs = {
      preview: { images: [{ filename: 'preview.png' }] },
      variants: { images: [{ filename: 'variant-a.png' }, { filename: 'variant-b.png' }] },
    };
    const directory = path.join(root, 'many-force');

    const firstServer = await fakeComfyUi({ completeAfterHistoryCalls: 1, historyOutputs });
    const first = await runNovelTeaCli(
      multiRunArguments(firstServer.url, [`variants=${directory}`]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(first.exitCode).toBe(0);
    const firstPaths = (
      (envelope(first).outputs as Record<string, unknown>).variants as Array<{ path: string }>
    ).map((value) => value.path);

    const collisionServer = await fakeComfyUi({ completeAfterHistoryCalls: 1, historyOutputs });
    const collision = await runNovelTeaCli(
      multiRunArguments(collisionServer.url, [`variants=${directory}`]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(collision.exitCode).toBe(4);
    expect(envelope(collision).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_EXISTS' }),
    ]);

    const forceServer = await fakeComfyUi({ completeAfterHistoryCalls: 1, historyOutputs });
    const forced = await runNovelTeaCli(
      [...multiRunArguments(forceServer.url, [`variants=${directory}`]), '--force'],
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(forced.exitCode).toBe(0);
    expect(firstPaths.every((value) => fs.existsSync(value))).toBe(true);
  });

  it('does not publish any mixed result when a filesystem extension mismatches after remote success', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'variant.png' }] },
      },
    });
    const mismatchedPath = path.join(root, 'preview.jpg');
    const result = await runNovelTeaCli(
      multiRunArguments(server.url, [`preview=${mismatchedPath}`]),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      },
    );
    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OUTPUT_EXTENSION' }),
    ]);
    expect(fs.existsSync(mismatchedPath)).toBe(false);
    expect(fs.existsSync(path.join(root, 'records', 'assets'))).toBe(false);
  });

  it('rolls back staged filesystem publication when mixed Project Asset publication fails', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'variant.png' }] },
      },
    });
    const workspace = createNodeProjectWorkspaceService();
    vi.spyOn(workspace, 'write').mockRejectedValueOnce(new Error('forced publication failure'));
    const previewPath = path.join(root, 'mixed', 'preview.png');
    const result = await runNovelTeaCli(multiRunArguments(server.url, [`preview=${previewPath}`]), {
      cwd: root,
      workspace,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(4);
    expect(envelope(result).diagnostics).toEqual([
      expect.objectContaining({ code: 'COMFYUI_ASSET_PUBLICATION_FAILED' }),
    ]);
    expect(fs.existsSync(previewPath)).toBe(false);
    expect(
      fs.existsSync(path.dirname(previewPath))
        ? fs.readdirSync(path.dirname(previewPath)).filter((name) => name.includes('noveltea-'))
        : [],
    ).toEqual([]);
  });

  it('keeps mixed publication committed when workspace bookkeeping throws after the authoritative Asset transaction', async () => {
    const root = tempRoot();
    writeProjectWorkspace(root);
    const builtInRoot = path.join(root, '.catalog', 'built-in');
    const userRoot = path.join(root, '.catalog', 'user');
    writeMultiPackage(userRoot);
    const server = await fakeComfyUi({
      completeAfterHistoryCalls: 1,
      historyOutputs: {
        preview: { images: [{ filename: 'preview.png' }] },
        variants: { images: [{ filename: 'variant.png' }] },
      },
    });
    const workspace = createNodeProjectWorkspaceService();
    const actualWrite = workspace.write.bind(workspace);
    vi.spyOn(workspace, 'write').mockImplementationOnce(async (...arguments_) => {
      await actualWrite(...arguments_);
      throw new Error('post-commit editor-local bookkeeping failure');
    });
    const previewPath = path.join(root, 'post-commit', 'preview.png');
    const result = await runNovelTeaCli(multiRunArguments(server.url, [`preview=${previewPath}`]), {
      cwd: root,
      workspace,
      comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
    });
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(previewPath)).toEqual(png());
    const variants = (envelope(result).outputs as Record<string, unknown>).variants as Array<{
      assetId: string;
    }>;
    expect(variants).toHaveLength(1);
    expect(
      fs.existsSync(path.join(root, 'records', 'assets', `${variants[0]!.assetId}.json`)),
    ).toBe(true);
  });

  it('returns 130 on interruption and attempts prompt-specific queue cancellation without /interrupt', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ neverComplete: true });
    const controller = new AbortController();

    const result = await runNovelTeaCli(
      runArguments(server.url, path.join(root, 'cancel.png')).filter((value) => value !== '--json'),
      {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
        comfyUiAbortSignal: controller.signal,
        onComfyUiProgress: (stage) => {
          if (stage === 'queued') controller.abort();
        },
      },
    );

    expect(result.exitCode).toBe(130);
    const cancellation = (await Promise.race([
      server.queueDelete,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ])) as { delete?: string[] } | null;
    const promptRequest = server.requests.find((request) => request.path === '/prompt')?.body as {
      prompt_id?: string;
    };
    expect(cancellation).toEqual({ delete: [promptRequest.prompt_id] });
    expect(server.requests.some((request) => request.path === '/interrupt')).toBe(false);
  });

  it('allows concurrent runs with distinct client and prompt identities', async () => {
    const root = tempRoot();
    const builtInRoot = path.join(root, 'built-in');
    const userRoot = path.join(root, 'user');
    writePackage(userRoot);
    const server = await fakeComfyUi({ completeAfterHistoryCalls: 1 });

    const [left, right] = await Promise.all([
      runNovelTeaCli(runArguments(server.url, path.join(root, 'left.png')), {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      }),
      runNovelTeaCli(runArguments(server.url, path.join(root, 'right.png')), {
        cwd: root,
        comfyUiWorkflowLibraryOptions: libraryOptions(builtInRoot, userRoot),
      }),
    ]);

    expect(left.exitCode).toBe(0);
    expect(right.exitCode).toBe(0);
    expect(envelope(left).clientId).not.toBe(envelope(right).clientId);
    expect(envelope(left).promptId).not.toBe(envelope(right).promptId);
    expect(server.requests.filter((request) => request.path === '/prompt')).toHaveLength(2);
  });
});
