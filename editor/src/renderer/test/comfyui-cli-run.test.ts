import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { WorkflowLibraryServiceOptions } from '../../main/services/comfyui-workflow-library-service';

const tempRoots: string[] = [];
const servers: http.Server[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-run-'));
  tempRoots.push(root);
  return root;
}

function manifest(id = 'scalar-run') {
  return {
    schemaVersion: 2,
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

function writePackage(root: string, id = 'scalar-run') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${id}.manifest.json`),
    `${JSON.stringify(manifest(id), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, `${id}.workflow.json`),
    `${JSON.stringify(workflow(), null, 2)}\n`,
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
  neverComplete?: boolean;
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
            SaveImage: { input: { required: { images: {}, filename_prefix: {} } } },
          }),
        );
        return;
      }
      if (requestPath === '/prompt' && request.method === 'POST') {
        const promptId = (body as { prompt_id?: string })?.prompt_id;
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
              outputs: {
                out: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] },
              },
            },
          }),
        );
        return;
      }
      if (requestPath.startsWith('/view?')) {
        const bytes = options.imageBytes ?? png();
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    queueDelete,
  };
}

function envelope(result: Awaited<ReturnType<typeof runNovelTeaCli>>) {
  return JSON.parse(result.stdout) as Record<string, unknown>;
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

afterEach(async () => {
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
