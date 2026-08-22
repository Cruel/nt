import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cancelComfyUiJob, generateComfyUiImage } from '../../main/services/comfyui-service';
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
    classification: 'image.generate',
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
      ...(includeOptionalBindings
        ? {
            negativePrompt: [
              {
                nodeId: 'negative',
                nodeTitle: 'noveltea.negativePrompt',
                classType: 'PrimitiveStringMultiline',
                inputName: 'value',
              },
            ],
            cfg: [
              {
                nodeId: 'cfg',
                nodeTitle: 'noveltea.cfg',
                classType: 'PrimitiveFloat',
                inputName: 'value',
              },
            ],
          }
        : {}),
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
        JSON.stringify({
          PrimitiveStringMultiline: { input: { required: { value: {} } } },
          PrimitiveFloat: { input: { required: { value: {} } } },
          SaveImage: { input: { required: { filename_prefix: {}, images: {} } } },
        }),
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
            status: { completed: true, status_str: 'success' },
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

  it('refuses to execute a discovered workflow with unsupported output media', async () => {
    const project = projectFilePath();
    const baseManifest = manifest(false);
    writeWorkflowPair(
      project,
      {
        ...baseManifest,
        contract: {
          inputs: baseManifest.contract.inputs,
          outputs: { audio: { mediaType: 'audio', required: true, cardinality: 'one' } },
        },
        outputBindings: { audio: baseManifest.outputBindings.images },
      },
      workflow(),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'tea house',
      clientJobId: 'job-1',
    });

    expect(response).toMatchObject({
      success: false,
      error: "Workflow 'custom' uses unsupported output media: audio.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not publish a generated revision when Project authority is revoked after remote completion', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const baseFetch = mockComfyUiFetch([]);
    let authorityCurrent = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await baseFetch(input, init);
        if (requestUrl(input).includes('/view')) authorityCurrent = false;
        return response;
      }),
    );
    const generatedDirectory = path.join(path.dirname(project), 'assets', 'generated');

    const response = await generateComfyUiImage(
      null,
      config(),
      {
        projectFilePath: project,
        workflowId: 'custom',
        prompt: 'tea house',
        clientJobId: 'job-1',
      },
      () => authorityCurrent,
      '11111111-1111-4111-8111-111111111111',
    );

    expect(response).toMatchObject({
      success: false,
      error: 'Project session is stale or unknown.',
    });
    expect(fs.existsSync(generatedDirectory)).toBe(false);
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

  it('writes one public input value to every mapped graph binding', async () => {
    const project = projectFilePath();
    const baseManifest = manifest(false);
    const baseWorkflow = workflow();
    writeWorkflowPair(
      project,
      {
        ...baseManifest,
        bindings: {
          ...baseManifest.bindings,
          prompt: [
            ...baseManifest.bindings.prompt,
            {
              nodeId: 'prompt-copy',
              nodeTitle: 'noveltea.prompt-copy',
              classType: 'PrimitiveStringMultiline',
              inputName: 'value',
            },
          ],
        },
      },
      {
        ...baseWorkflow,
        'prompt-copy': {
          class_type: 'PrimitiveStringMultiline',
          _meta: { title: 'noveltea.prompt-copy' },
          inputs: { value: '' },
        },
      },
    );
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    vi.stubGlobal('WebSocket', CompletedWebSocket);

    const response = await generateComfyUiImage(null, config(), {
      projectFilePath: project,
      workflowId: 'custom',
      prompt: 'shared public value',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(true);
    const submitted = capturedPrompts[0] as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(submitted.prompt.prompt.inputs.value).toBe('shared public value');
    expect(submitted.prompt['prompt-copy'].inputs.value).toBe('shared public value');
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

  it('resolves the configured image.generate default when the editor request omits a workflow id', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    const capturedPrompts: unknown[] = [];
    vi.stubGlobal('fetch', mockComfyUiFetch(capturedPrompts));
    const configured = config();
    configured.defaultWorkflows = { 'image.generate': 'custom' };

    const response = await generateComfyUiImage(null, configured, {
      projectFilePath: project,
      prompt: 'tea house',
      clientJobId: 'job-1',
    });

    expect(response.success).toBe(true);
    expect(capturedPrompts).toHaveLength(1);
  });

  it('cancels the active editor run through prompt-specific queue deletion instead of /interrupt', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, manifest(false), workflow());
    let promptSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      promptSubmitted = resolve;
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({ url, body: requestBody(init) ? JSON.parse(requestBody(init)) : null });
        if (url.includes('/object_info'))
          return new Response(
            JSON.stringify({
              PrimitiveStringMultiline: { input: { required: { value: {} } } },
              PrimitiveFloat: { input: { required: { value: {} } } },
              SaveImage: { input: { required: { filename_prefix: {}, images: {} } } },
            }),
            { status: 200 },
          );
        if (url.includes('/prompt')) {
          promptSubmitted();
          return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
        }
        if (url.includes('/queue')) return new Response('{}', { status: 200 });
        if (url.includes('/history/job-1'))
          return new Response(
            JSON.stringify({ 'job-1': { status: { completed: false }, outputs: {} } }),
            { status: 200 },
          );
        return new Response('{}', { status: 404 });
      }),
    );
    const projectSessionId = '11111111-1111-4111-8111-111111111111';
    const run = generateComfyUiImage(
      null,
      config(),
      { projectFilePath: project, workflowId: 'custom', prompt: 'tea house', clientJobId: 'job-1' },
      () => true,
      projectSessionId,
    );
    await submitted;
    await cancelComfyUiJob(config(), projectSessionId);
    const response = await run;

    expect(response.success).toBe(false);
    expect(requests.some((request) => request.url.includes('/interrupt'))).toBe(false);
    expect(requests.find((request) => request.url.includes('/queue'))?.body).toEqual({
      delete: ['job-1'],
    });
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
            JSON.stringify({
              PrimitiveStringMultiline: { input: { required: { value: {} } } },
              PrimitiveFloat: { input: { required: { value: {} } } },
              SaveImage: { input: { required: { filename_prefix: {}, images: {} } } },
            }),
            { status: 200 },
          );
        if (url.includes('/prompt'))
          return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
        if (url.includes('/history/job-1'))
          return new Response(
            JSON.stringify({
              'job-1': {
                status: { completed: true, status_str: 'success' },
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
    expect(response.error).toContain("Output 'images' produced 0 results");
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
    expect(response.error).toContain("PrimitiveStringMultiline is missing mapped input 'value'");
    expect(capturedPrompts).toHaveLength(0);
  });
});
