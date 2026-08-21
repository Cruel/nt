import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { generateComfyUiImage } from '../../main/services/comfyui-service';
import type { ComfyUiConfig } from '../../shared/comfyui';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/noveltea-test-user-data',
  },
}));

const roots: string[] = [];
const pngBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lbMcWQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

function projectFilePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-generate-'));
  roots.push(root);
  return path.join(root, 'project.json');
}

function config(): ComfyUiConfig {
  return {
    enabled: true,
    serverUrl: 'http://127.0.0.1:8188',
    requestTimeoutMs: 100,
    connectionCheckIntervalMs: 1000,
    defaultWorkflowId: 'custom',
    defaultWorkflows: {},
  };
}

function writeWorkflowPair(project: string, manifest: unknown, workflow: unknown) {
  const workflowsRoot = path.join(path.dirname(project), 'workflows');
  fs.mkdirSync(workflowsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsRoot, 'custom.workflow.json'),
    `${JSON.stringify(workflow, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(workflowsRoot, 'custom.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function workflow() {
  return {
    prompt: {
      class_type: 'PrimitiveStringMultiline',
      _meta: { title: 'noveltea.prompt' },
      inputs: { value: '' },
    },
    negative: {
      class_type: 'PrimitiveStringMultiline',
      _meta: { title: 'noveltea.negativePrompt' },
      inputs: { value: '' },
    },
    cfg: { class_type: 'PrimitiveFloat', _meta: { title: 'noveltea.cfg' }, inputs: { value: 0 } },
    output: {
      class_type: 'SaveImage',
      _meta: { title: 'noveltea.output' },
      inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] },
    },
  };
}

function manifest(includeOptionalBindings: boolean) {
  return {
    schemaVersion: 2,
    id: 'custom',
    label: 'Custom',
    provider: 'comfyui',
    role: 'image.generate',
    workflowFile: 'custom.workflow.json',
    contract: {
      inputs: {
        prompt: { type: 'string', required: true },
        ...(includeOptionalBindings
          ? {
              negativePrompt: { type: 'string', required: false },
              cfg: { type: 'number', required: false },
            }
          : {}),
      },
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
      ...(includeOptionalBindings
        ? {
            negativePrompt: {
              nodeId: 'negative',
              nodeTitle: 'noveltea.negativePrompt',
              classType: 'PrimitiveStringMultiline',
              inputName: 'value',
              valueType: 'string',
            },
            cfg: {
              nodeId: 'cfg',
              nodeTitle: 'noveltea.cfg',
              classType: 'PrimitiveFloat',
              inputName: 'value',
              valueType: 'number',
            },
          }
        : {}),
    },
    outputBindings: {
      images: [
        {
          nodeId: 'output',
          nodeTitle: 'noveltea.output',
          classType: 'SaveImage',
          valueType: 'image-list',
          primary: 'first',
        },
      ],
    },
    defaults: { filenamePrefix: 'NovelTea' },
    requiredNodeClasses: ['PrimitiveStringMultiline', 'PrimitiveFloat', 'SaveImage'],
  };
}

class CompletedWebSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'execution_start', data: { prompt_id: 'job-1' } }),
        }),
      );
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'executing', data: { prompt_id: 'job-1', node: null } }),
        }),
      );
    });
  }

  close() {
    // no-op
  }
}

function mockComfyUiFetch(capturedPrompts: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes('/object_info')) {
      return new Response(
        JSON.stringify({ PrimitiveStringMultiline: {}, PrimitiveFloat: {}, SaveImage: {} }),
        { status: 200 },
      );
    }
    if (url.includes('/prompt')) {
      capturedPrompts.push(JSON.parse(requestBody(init)));
      return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
    }
    if (url.includes('/history/job-1')) {
      return new Response(
        JSON.stringify({
          'job-1': {
            outputs: { output: { images: [{ filename: 'generated.png', type: 'output' }] } },
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/view')) {
      return new Response(pngBytes, { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): string {
  return typeof init?.body === 'string' ? init.body : '';
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('comfyui generation service', () => {
  it('rejects stale Project authority before workflow or network work begins', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await generateComfyUiImage(
      null,
      config(),
      {
        projectFilePath: '/missing/project.json',
        workflowId: 'custom',
        prompt: 'tea house',
      },
      () => false,
      '11111111-1111-4111-8111-111111111111',
    );

    expect(response).toMatchObject({
      success: false,
      error: 'Project session is stale or unknown.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not publish a generated Asset when Project authority is revoked during the write', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    vi.stubGlobal('fetch', mockComfyUiFetch([]));
    vi.stubGlobal('WebSocket', CompletedWebSocket);
    const generatedDirectory = path.join(path.dirname(project), 'assets', 'generated');
    let observedStagedWrite = false;
    const isAuthorityCurrent = () => {
      if (!fs.existsSync(generatedDirectory)) return true;
      const hasStagedWrite = fs
        .readdirSync(generatedDirectory)
        .some((name) => name.endsWith('.tmp'));
      if (hasStagedWrite) observedStagedWrite = true;
      return !hasStagedWrite;
    };

    const response = await generateComfyUiImage(
      null,
      config(),
      {
        projectFilePath: project,
        workflowId: 'custom',
        prompt: 'tea house',
        clientJobId: 'job-1',
      },
      isAuthorityCurrent,
      '11111111-1111-4111-8111-111111111111',
    );

    expect(observedStagedWrite).toBe(true);
    expect(response).toMatchObject({
      success: false,
      error: 'Project session is stale or unknown.',
    });
    expect(fs.readdirSync(generatedDirectory)).toEqual([]);
  });

  it('mutates bound negative prompt and cfg inputs before submitting a prompt', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(true), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    vi.stubGlobal('WebSocket', CompletedWebSocket);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'tea house',
      negativePrompt: 'blur',
      cfg: 7.5,
      clientJobId: 'job-1',
    });
    expect(response.success).toBe(true);
    const submitted = capturedPrompts[0] as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(submitted.prompt.prompt.inputs.value).toBe('tea house');
    expect(submitted.prompt.negative.inputs.value).toBe('blur');
    expect(submitted.prompt.cfg.inputs.value).toBe(7.5);
  });

  it('ignores unbound optional request fields', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    vi.stubGlobal('WebSocket', CompletedWebSocket);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'tea house',
      negativePrompt: 'should not apply',
      cfg: 9,
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(true);
    const submitted = capturedPrompts[0] as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(submitted.prompt.prompt.inputs.value).toBe('tea house');
    expect(submitted.prompt.negative.inputs.value).toBe('');
    expect(submitted.prompt.cfg.inputs.value).toBe(0);
  });

  it('resolves legacy bare workflow ids to the active workflow package', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    vi.stubGlobal('WebSocket', CompletedWebSocket);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'legacy id path',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(true);
    const submitted = capturedPrompts[0] as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(submitted.prompt.prompt.inputs.value).toBe('legacy id path');
  });

  it('resolves generation requests by source-specific workflow key', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    vi.stubGlobal('WebSocket', CompletedWebSocket);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowKey: 'project:custom.manifest.json',
      prompt: 'tea house',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(true);
    expect(capturedPrompts).toHaveLength(1);
  });

  it('reports selected output node ids when a completed prompt has no images there', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    vi.stubGlobal('WebSocket', CompletedWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/object_info'))
          return new Response(
            JSON.stringify({ PrimitiveStringMultiline: {}, PrimitiveFloat: {}, SaveImage: {} }),
            { status: 200 },
          );
        if (url.includes('/prompt'))
          return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
        if (url.includes('/history/job-1'))
          return new Response(
            JSON.stringify({
              'job-1': {
                outputs: { other: { images: [{ filename: 'ignored.png', type: 'output' }] } },
              },
            }),
            { status: 200 },
          );
        if (url.includes('/view')) return new Response(pngBytes, { status: 200 });
        return new Response('{}', { status: 404 });
      }),
    );

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'tea house',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('selected output node output');
  });

  it('rejects mapped inputs that are absent from available ComfyUI object_info metadata', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/object_info')) {
          return new Response(
            JSON.stringify({
              PrimitiveStringMultiline: { input: { required: { other: ['STRING'] } } },
              PrimitiveFloat: {},
              SaveImage: {},
            }),
            { status: 200 },
          );
        }
        if (url.includes('/prompt')) {
          capturedPrompts.push(JSON.parse(requestBody(init)));
          return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'tea house',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('PrimitiveStringMultiline.value');
    expect(capturedPrompts).toHaveLength(0);
  });
});
