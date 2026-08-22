import { describe, expect, it } from 'vite-plus/test';
import {
  COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG,
  COMFYUI_WORKFLOW_SCHEMA_VERSION,
  getComfyUiWorkflowExecutionSupport,
  parseComfyUiWorkflowDefinition,
  resolvedComfyUiWorkflowOutputNodeIdList,
  resolvedComfyUiWorkflowOutputNodeIdsById,
  resolveComfyUiWorkflowBinding,
  validateComfyUiWorkflowDefinitionContract,
} from '../../shared/comfyui-workflows';

const v2Manifest = {
  schemaVersion: COMFYUI_WORKFLOW_SCHEMA_VERSION,
  id: 'starter',
  label: 'Starter',
  provider: 'comfyui',
  classification: 'image.generate',
  workflowFile: 'starter.workflow.json',
  contract: {
    inputs: {
      prompt: {
        type: 'string',
        required: true,
        authoring: { label: 'Prompt', editorField: 'textarea' },
      },
      batchCount: { type: 'integer', required: false, defaultValue: 2 },
      usePreview: { type: 'boolean', required: false, defaultValue: true },
    },
    outputs: {
      images: { mediaType: 'image', required: true, cardinality: 'many' },
    },
  },
  bindings: {
    prompt: [
      { nodeId: '76', inputName: 'value' },
      { nodeId: '77', inputName: 'text' },
    ],
    batchCount: [{ nodeId: '10', inputName: 'value' }],
    usePreview: [{ nodeId: '11', inputName: 'enabled' }],
  },
  outputBindings: {
    images: [{ nodeId: '9' }],
  },
  requiredNodeClasses: ['SaveImage'],
};

describe('comfyui workflow manifests', () => {
  it('parses strict generic v2 manifests without changing the selected schema version', () => {
    const definition = parseComfyUiWorkflowDefinition(v2Manifest, 'starter.manifest.json');

    expect(definition.schemaVersion).toBe(2);
    expect(definition.schemaVersion).toBe(COMFYUI_WORKFLOW_SCHEMA_VERSION);
    expect(definition.classification).toBe('image.generate');
    expect(definition.bindings.prompt).toHaveLength(2);
    expect(definition.contract.inputs.usePreview).toMatchObject({
      type: 'boolean',
      defaultValue: true,
    });
    expect(definition.contract.outputs.images).toEqual({
      mediaType: 'image',
      required: true,
      cardinality: 'many',
    });
    expect(definition.manifestFile).toBe('starter.manifest.json');
  });

  it('accepts arbitrary CLI-safe public IDs and optional extensible classification', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
      classification: 'video.experimental',
      contract: {
        inputs: {
          user_prompt: { type: 'string', required: true },
          strength2: { type: 'number', required: false, defaultValue: 0.5 },
          'source-image': { type: 'image', required: false },
        },
        outputs: {
          primary_image: { mediaType: 'image', required: true, cardinality: 'one' },
        },
      },
      bindings: {
        user_prompt: [{ nodeId: '1', inputName: 'text' }],
        strength2: [{ nodeId: '2', inputName: 'value' }],
        'source-image': [{ nodeId: '3', inputName: 'image' }],
      },
      outputBindings: { primary_image: [{ nodeId: '4' }] },
    });
    expect(definition.classification).toBe('video.experimental');
    expect(Object.keys(definition.contract.inputs)).toEqual([
      'user_prompt',
      'strength2',
      'source-image',
    ]);

    const unclassified = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
      classification: undefined,
    });
    expect(unclassified.classification).toBeUndefined();
  });

  it('rejects unsafe public IDs and malformed classifications', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        contract: {
          ...v2Manifest.contract,
          inputs: { 'bad.id': { type: 'string', required: true } },
        },
        bindings: { 'bad.id': [{ nodeId: '1', inputName: 'text' }] },
      }),
    ).toThrow('not a CLI-safe public identifier');
    expect(() =>
      parseComfyUiWorkflowDefinition({ ...v2Manifest, classification: 'image' }),
    ).toThrow('not a dotted classification identifier');
  });

  it('validates typed defaults including boolean and integer semantics', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        contract: {
          ...v2Manifest.contract,
          inputs: {
            count: { type: 'integer', required: false, defaultValue: 1.5 },
          },
        },
        bindings: { count: [{ nodeId: '1', inputName: 'value' }] },
      }),
    ).toThrow('defaultValue must be an integer');
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        contract: {
          ...v2Manifest.contract,
          inputs: {
            enabled: { type: 'boolean', required: false, defaultValue: 'true' },
          },
        },
        bindings: { enabled: [{ nodeId: '1', inputName: 'enabled' }] },
      }),
    ).toThrow('defaultValue must be a boolean');
  });

  it('requires every declared public input and output to have graph bindings', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        bindings: { ...v2Manifest.bindings, prompt: undefined },
      }),
    ).toThrow();

    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        bindings: {
          ...v2Manifest.bindings,
          extra: [{ nodeId: '100', inputName: 'value' }],
        },
      }),
    ).toThrow('bindings.extra must be declared by contract.inputs.extra');

    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, outputBindings: {} })).toThrow(
      'contract.outputs.images must declare at least one graph binding',
    );
  });

  it('keeps unsupported future output media discoverable but reports it non-runnable', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
      contract: {
        inputs: { prompt: { type: 'string', required: true } },
        outputs: {
          audio: { mediaType: 'audio', required: true, cardinality: 'one' },
        },
      },
      bindings: { prompt: [{ nodeId: '1', inputName: 'text' }] },
      outputBindings: { audio: [{ nodeId: '2' }] },
    });
    const diagnostics = validateComfyUiWorkflowDefinitionContract(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', path: '/contract/outputs/audio/mediaType' }),
    );
    expect(getComfyUiWorkflowExecutionSupport(definition)).toEqual({
      runnable: false,
      unsupportedOutputMediaTypes: ['audio'],
    });
  });

  it('rejects unsupported schema versions and the replaced same-version shape', () => {
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, schemaVersion: 3 })).toThrow(
      "schemaVersion '3' is not supported",
    );

    const replacedShape = {
      schemaVersion: 2,
      id: 'old-v2',
      label: 'Old V2',
      provider: 'comfyui',
      role: 'image.generate',
      workflowFile: 'old-v2.workflow.json',
      contract: {
        inputs: { prompt: { type: 'string', required: true } },
        outputs: { images: { type: 'image-list', required: true, primary: 'first' } },
      },
      bindings: {
        prompt: { nodeId: '1', inputName: 'text', valueType: 'string' },
      },
      defaults: { filenamePrefix: 'NovelTea' },
      outputBindings: {
        images: [{ nodeId: '2', valueType: 'image-list', primary: 'first' }],
      },
      requiredNodeClasses: ['SaveImage'],
    };
    expect(() => parseComfyUiWorkflowDefinition(replacedShape)).toThrow(
      'manifest.role is not supported',
    );
  });

  it('rejects the retired output-node compatibility field', () => {
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, outputNodeIds: ['9'] })).toThrow(
      'manifest.outputNodeIds is not supported',
    );
  });

  it('exposes known image classifications only as authoring/inference metadata', () => {
    expect(
      COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG['image.generate'].contract.inputs.prompt,
    ).toMatchObject({ type: 'string', required: true });
    expect(
      COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG['image.edit'].contract.inputs.sourceImage,
    ).toMatchObject({ type: 'image', required: true });
    expect(
      COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG['image.generate'].contract.outputs.images,
    ).toMatchObject({ mediaType: 'image', required: true, cardinality: 'many' });
  });

  it('resolves bindings by exact id first and rebases stale ids through selector metadata', () => {
    const graph = {
      '41': {
        class_type: 'PrimitiveStringMultiline',
        _meta: { title: 'noveltea.prompt' },
        inputs: { value: '' },
      },
      '76': {
        class_type: 'PrimitiveStringMultiline',
        _meta: { title: 'old.prompt' },
        inputs: { other: '' },
      },
    };

    expect(
      resolveComfyUiWorkflowBinding(graph, {
        nodeId: '41',
        nodeTitle: 'noveltea.prompt',
        classType: 'PrimitiveStringMultiline',
        inputName: 'value',
      }),
    ).toMatchObject({ ok: true, nodeId: '41' });
    expect(
      resolveComfyUiWorkflowBinding(graph, {
        nodeId: '76',
        nodeTitle: 'noveltea.prompt',
        classType: 'PrimitiveStringMultiline',
        inputName: 'value',
        selector: {
          title: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
        },
      }),
    ).toMatchObject({ ok: true, nodeId: '41', rebased: true });
  });

  it('does not guess when selector metadata matches multiple nodes', () => {
    const graph = {
      '10': {
        class_type: 'PrimitiveStringMultiline',
        _meta: { title: 'Prompt' },
        inputs: { value: '' },
      },
      '11': {
        class_type: 'PrimitiveStringMultiline',
        _meta: { title: 'Prompt' },
        inputs: { value: '' },
      },
    };

    expect(
      resolveComfyUiWorkflowBinding(graph, {
        nodeTitle: 'Prompt',
        classType: 'PrimitiveStringMultiline',
        inputName: 'value',
      }),
    ).toMatchObject({ ok: false });
  });

  it('resolves named output bindings independently', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
      contract: {
        inputs: { prompt: { type: 'string', required: true } },
        outputs: {
          primary: { mediaType: 'image', required: true, cardinality: 'one' },
          alternates: { mediaType: 'image', required: false, cardinality: 'many' },
        },
      },
      bindings: { prompt: [{ nodeId: '76', inputName: 'value' }] },
      outputBindings: {
        primary: [{ nodeTitle: 'primary', classType: 'SaveImage' }],
        alternates: [{ nodeTitle: 'alternate', classType: 'PreviewImage' }],
      },
    });
    const graph = {
      'selected-output': {
        class_type: 'SaveImage',
        _meta: { title: 'primary' },
        inputs: { images: ['8', 0] },
      },
      'preview-output': {
        class_type: 'PreviewImage',
        _meta: { title: 'alternate' },
        inputs: { images: ['8', 0] },
      },
    };

    expect(resolvedComfyUiWorkflowOutputNodeIdList(graph, definition, 'primary')).toEqual([
      'selected-output',
    ]);
    expect(resolvedComfyUiWorkflowOutputNodeIdsById(graph, definition)).toEqual({
      primary: ['selected-output'],
      alternates: ['preview-output'],
    });
  });
});
