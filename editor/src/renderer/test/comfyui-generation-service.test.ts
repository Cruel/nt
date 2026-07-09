import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateComfyUiImage } from '../../main/services/comfyui-service';
import type { ComfyUiConfig } from '../../shared/comfyui';

const roots: string[] = [];

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
  fs.writeFileSync(path.join(workflowsRoot, 'custom.workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
  fs.writeFileSync(path.join(workflowsRoot, 'custom.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function workflow() {
  return {
    prompt: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.prompt' }, inputs: { value: '' } },
    negative: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.negativePrompt' }, inputs: { value: '' } },
    cfg: { class_type: 'PrimitiveFloat', _meta: { title: 'noveltea.cfg' }, inputs: { value: 0 } },
    output: { class_type: 'SaveImage', _meta: { title: 'noveltea.output' }, inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] } },
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
        ...(includeOptionalBindings ? {
          negativePrompt: { type: 'string', required: false },
          cfg: { type: 'number', required: false },
        } : {}),
      },
      outputs: { images: { type: 'image-list', required: true, primary: 'first' } },
    },
    bindings: {
      prompt: { nodeId: 'prompt', nodeTitle: 'noveltea.prompt', classType: 'PrimitiveStringMultiline', inputName: 'value', valueType: 'string' },
      ...(includeOptionalBindings ? {
        negativePrompt: { nodeId: 'negative', nodeTitle: 'noveltea.negativePrompt', classType: 'PrimitiveStringMultiline', inputName: 'value', valueType: 'string' },
        cfg: { nodeId: 'cfg', nodeTitle: 'noveltea.cfg', classType: 'PrimitiveFloat', inputName: 'value', valueType: 'number' },
      } : {}),
    },
    outputBindings: {
      images: [{ nodeId: 'output', nodeTitle: 'noveltea.output', classType: 'SaveImage', outputName: 'images', valueType: 'image-list', primary: 'first' }],
    },
    outputNodeIds: ['output'],
    defaults: { filenamePrefix: 'NovelTea' },
    requiredNodeClasses: ['PrimitiveStringMultiline', 'PrimitiveFloat', 'SaveImage'],
  };
}

class CompletedWebSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'execution_start', data: { prompt_id: 'job-1' } }) }));
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'executing', data: { prompt_id: 'job-1', node: null } }) }));
    });
  }

  close() {
    // no-op
  }
}

function mockComfyUiFetch(capturedPrompts: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/object_info')) {
      return new Response(JSON.stringify({ PrimitiveStringMultiline: {}, PrimitiveFloat: {}, SaveImage: {} }), { status: 200 });
    }
    if (url.includes('/prompt')) {
      capturedPrompts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ prompt_id: 'job-1', number: 1 }), { status: 200 });
    }
    if (url.includes('/history/job-1')) {
      return new Response(JSON.stringify({ 'job-1': { outputs: { output: { images: [{ filename: 'generated.png', type: 'output' }] } } } }), { status: 200 });
    }
    if (url.includes('/view')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('comfyui generation service', () => {
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
    const submitted = capturedPrompts[0] as { prompt: Record<string, { inputs: Record<string, unknown> }> };
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
    const submitted = capturedPrompts[0] as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    expect(submitted.prompt.prompt.inputs.value).toBe('tea house');
    expect(submitted.prompt.negative.inputs.value).toBe('');
    expect(submitted.prompt.cfg.inputs.value).toBe(0);
  });
});
