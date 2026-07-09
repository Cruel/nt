import { describe, expect, it } from 'vitest';
import {
  COMFYUI_WORKFLOW_ROLE_CATALOG,
  parseComfyUiWorkflowDefinition,
  resolvedComfyUiWorkflowOutputNodeIdList,
  resolveComfyUiWorkflowBinding,
} from '../../shared/comfyui-workflows';

const v1Manifest = {
  id: 'starter',
  label: 'Starter',
  provider: 'comfyui',
  role: 'image.generate',
  workflowFile: 'starter.workflow.json',
  contract: {
    inputs: {
      prompt: { type: 'string', required: true },
    },
    outputs: {
      images: { type: 'image-list', required: true, primary: 'first' },
    },
  },
  bindings: {
    prompt: { nodeId: '76', inputName: 'value', valueType: 'string' },
  },
  defaults: {
    filenamePrefix: 'NovelTea',
  },
  outputNodeIds: ['9'],
  requiredNodeClasses: ['SaveImage'],
};

describe('comfyui workflow manifests', () => {
  it('parses existing v1 exact-node manifests and defaults the schema version', () => {
    const definition = parseComfyUiWorkflowDefinition(v1Manifest, 'starter.manifest.json');

    expect(definition.schemaVersion).toBe(1);
    expect(definition.bindings.prompt).toMatchObject({ nodeId: '76', inputName: 'value' });
    expect(definition.outputNodeIds).toEqual(['9']);
    expect(definition.outputBindings).toEqual({});
    expect(definition.manifestFile).toBe('starter.manifest.json');
  });

  it('parses v2 selector metadata and output bindings', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v1Manifest,
      schemaVersion: 2,
      bindings: {
        prompt: {
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
          valueType: 'string',
          selector: {
            title: 'noveltea.prompt',
            classType: 'PrimitiveStringMultiline',
            inputName: 'value',
            downstreamClassType: 'CLIPTextEncode',
          },
          resolvedNodeId: '76',
        },
      },
      outputBindings: {
        images: [
          {
            nodeTitle: 'noveltea.output',
            classType: 'SaveImage',
            outputName: 'images',
            valueType: 'image-list',
            primary: 'first',
          },
        ],
      },
    });

    expect(definition.schemaVersion).toBe(2);
    expect(definition.bindings.prompt).toMatchObject({
      nodeTitle: 'noveltea.prompt',
      classType: 'PrimitiveStringMultiline',
      resolvedNodeId: '76',
      selector: {
        title: 'noveltea.prompt',
        downstreamClassType: 'CLIPTextEncode',
      },
    });
    expect(definition.outputBindings.images?.[0]).toMatchObject({
      nodeTitle: 'noveltea.output',
      classType: 'SaveImage',
      valueType: 'image-list',
      primary: 'first',
    });
  });

  it('rejects unsupported roles and schema versions', () => {
    expect(() => parseComfyUiWorkflowDefinition({ ...v1Manifest, role: 'video.generate' })).toThrow("role 'video.generate' is not supported");
    expect(() => parseComfyUiWorkflowDefinition({ ...v1Manifest, schemaVersion: 3 })).toThrow("schemaVersion '3' is not supported");
  });

  it('validates required role contract fields from the role catalog', () => {
    expect(() => parseComfyUiWorkflowDefinition({
      ...v1Manifest,
      role: 'image.edit',
      contract: {
        inputs: {
          prompt: { type: 'string', required: true },
        },
        outputs: {
          images: { type: 'image-list', required: true, primary: 'first' },
        },
      },
      bindings: {
        prompt: { nodeId: '76', inputName: 'value', valueType: 'string' },
      },
    })).toThrow('image.edit workflows must declare required contract.inputs.sourceImage as image');
  });

  it('exposes initial image workflow roles through the role catalog', () => {
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.generate'].contract.inputs.prompt).toMatchObject({ type: 'string', required: true });
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.edit'].contract.inputs.sourceImage).toMatchObject({ type: 'image', required: true });
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.generate'].contract.outputs.images).toMatchObject({ type: 'image-list', required: true, primary: 'first' });
  });

  it('resolves bindings by exact id first and rebases stale ids through selector metadata', () => {
    const graph = {
      '41': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.prompt' }, inputs: { value: '' } },
      '76': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'old.prompt' }, inputs: { other: '' } },
    };

    expect(resolveComfyUiWorkflowBinding(graph, { nodeId: '41', nodeTitle: 'noveltea.prompt', classType: 'PrimitiveStringMultiline', inputName: 'value', valueType: 'string' })).toMatchObject({
      ok: true,
      nodeId: '41',
    });
    expect(resolveComfyUiWorkflowBinding(graph, {
      nodeId: '76',
      nodeTitle: 'noveltea.prompt',
      classType: 'PrimitiveStringMultiline',
      inputName: 'value',
      valueType: 'string',
      selector: { title: 'noveltea.prompt', classType: 'PrimitiveStringMultiline', inputName: 'value' },
    })).toMatchObject({
      ok: true,
      nodeId: '41',
      rebased: true,
    });
  });

  it('does not guess when selector metadata matches multiple nodes', () => {
    const graph = {
      '10': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'Prompt' }, inputs: { value: '' } },
      '11': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'Prompt' }, inputs: { value: '' } },
    };

    expect(resolveComfyUiWorkflowBinding(graph, {
      nodeTitle: 'Prompt',
      classType: 'PrimitiveStringMultiline',
      inputName: 'value',
      valueType: 'string',
    })).toMatchObject({ ok: false });
  });

  it('resolves explicit output bindings ahead of legacy output node ids', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v1Manifest,
      schemaVersion: 2,
      outputNodeIds: ['legacy-output'],
      outputBindings: {
        images: [
          { nodeTitle: 'noveltea.output', classType: 'SaveImage', outputName: 'images', valueType: 'image-list', primary: 'first' },
        ],
      },
    });
    const graph = {
      'selected-output': { class_type: 'SaveImage', _meta: { title: 'noveltea.output' }, inputs: { images: ['8', 0] } },
      'legacy-output': { class_type: 'SaveImage', _meta: { title: 'old.output' }, inputs: { images: ['7', 0] } },
    };

    expect(resolvedComfyUiWorkflowOutputNodeIdList(graph, definition)).toEqual(['selected-output']);
  });

  it('preserves legacy output node id resolution for v1 manifests', () => {
    const definition = parseComfyUiWorkflowDefinition(v1Manifest);
    const graph = {
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
      '10': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
    };

    expect(resolvedComfyUiWorkflowOutputNodeIdList(graph, definition)).toEqual(['9']);
  });
});
