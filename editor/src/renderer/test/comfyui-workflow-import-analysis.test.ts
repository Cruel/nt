import { describe, expect, it } from 'vitest';
import bundledTextToImageWorkflow from '../../../assets/comfyui/workflows/flux2-klein-text-to-image.workflow.json';
import {
  analyzeComfyUiApiWorkflow,
  analyzeComfyUiObjectInfoCompatibility,
} from '../../shared/comfyui-workflow-graph';
import { inferComfyUiWorkflowCandidates } from '../../shared/comfyui-workflow-inference';

describe('comfyui workflow import analysis', () => {
  it('detects ComfyUI API workflows and extracts graph links', () => {
    const analysis = analyzeComfyUiApiWorkflow(bundledTextToImageWorkflow);

    expect(analysis.looksLikeApiWorkflow).toBe(true);
    expect(analysis.looksLikeSaveWorkflow).toBe(false);
    expect(analysis.nodes.length).toBeGreaterThan(10);
    expect(analysis.classTypes).toContain('SaveImage');
    expect(analysis.links).toContainEqual({
      fromNodeId: '76',
      fromOutputIndex: 0,
      toNodeId: '75:74',
      toInputName: 'text',
    });
  });

  it('rejects likely ComfyUI save-format workflows with guidance', () => {
    const analysis = analyzeComfyUiApiWorkflow({
      last_node_id: 2,
      nodes: [{ id: 1, type: 'CLIPTextEncode' }],
      links: [],
      groups: [],
    });

    expect(analysis.looksLikeApiWorkflow).toBe(false);
    expect(analysis.looksLikeSaveWorkflow).toBe(true);
    expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('Export Workflow (API)'),
    }));
  });

  it('checks object_info compatibility when server metadata is available', () => {
    const analysis = analyzeComfyUiApiWorkflow({
      a: { class_type: 'SaveImage', inputs: { images: ['b', 0] } },
      b: { class_type: 'CustomSampler', inputs: {} },
    });

    const compatibility = analyzeComfyUiObjectInfoCompatibility(analysis, {
      SaveImage: {},
    });

    expect(compatibility.available).toBe(true);
    expect(compatibility.missingClassTypes).toEqual(['CustomSampler']);
    expect(compatibility.diagnostics[0]).toMatchObject({
      severity: 'error',
      message: 'Current ComfyUI server is missing node class CustomSampler.',
    });
  });

  it('infers high-confidence title marker bindings and image outputs', () => {
    const analysis = analyzeComfyUiApiWorkflow({
      prompt: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.prompt' }, inputs: { value: 'Tea in moonlight' } },
      output: { class_type: 'SaveImage', _meta: { title: 'noveltea.output' }, inputs: { filename_prefix: 'NovelTea', images: ['decode', 0] } },
      decode: { class_type: 'VAEDecode', inputs: {} },
    });
    const candidates = inferComfyUiWorkflowCandidates(analysis, 'image.generate');

    expect(candidates.prompt?.[0]).toMatchObject({
      nodeId: 'prompt',
      inputName: 'value',
      valueType: 'string',
      confidence: 'high',
    });
    expect(candidates.images?.[0]).toMatchObject({
      nodeId: 'output',
      inputName: 'images',
      valueType: 'image-list',
      confidence: 'high',
    });
  });

  it('infers bundled workflow prompt, dimensions, seed, steps, filename prefix, and output candidates', () => {
    const analysis = analyzeComfyUiApiWorkflow(bundledTextToImageWorkflow);
    const candidates = inferComfyUiWorkflowCandidates(analysis, 'image.generate');

    expect(candidates.prompt?.[0]).toMatchObject({ nodeId: '76', inputName: 'value', confidence: 'medium' });
    expect(candidates.width?.[0]).toMatchObject({ nodeId: '75:68', inputName: 'value' });
    expect(candidates.height?.[0]).toMatchObject({ nodeId: '75:69', inputName: 'value' });
    expect(candidates.seed?.[0]).toMatchObject({ nodeId: '75:73', inputName: 'noise_seed', confidence: 'high' });
    expect(candidates.steps?.[0]).toMatchObject({ nodeId: '75:62', inputName: 'steps', confidence: 'medium' });
    expect(candidates.filenamePrefix?.[0]).toMatchObject({ nodeId: '9', inputName: 'filename_prefix', confidence: 'high' });
    expect(candidates.images?.[0]).toMatchObject({ nodeId: '9', inputName: 'images', confidence: 'high' });
  });

  it('lowers confidence when multiple equivalent outputs have no title marker', () => {
    const analysis = analyzeComfyUiApiWorkflow({
      a: { class_type: 'SaveImage', _meta: { title: 'Save Image A' }, inputs: { images: ['x', 0] } },
      b: { class_type: 'SaveImage', _meta: { title: 'Save Image B' }, inputs: { images: ['x', 0] } },
    });
    const candidates = inferComfyUiWorkflowCandidates(analysis, 'image.generate');

    expect(candidates.images).toHaveLength(2);
    expect(candidates.images?.map((candidate) => candidate.confidence)).toEqual(['medium', 'medium']);
  });
});
