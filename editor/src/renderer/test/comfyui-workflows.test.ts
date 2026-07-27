import { describe, expect, it } from 'vite-plus/test';
import {
  COMFYUI_WORKFLOW_ROLE_CATALOG,
  COMFYUI_WORKFLOW_SCHEMA_VERSION,
  parseComfyUiWorkflowDefinition,
  resolvedComfyUiWorkflowOutputNodeIdList,
  resolveComfyUiWorkflowBinding,
} from '../../shared/comfyui-workflows';

const v2Manifest = {
  schemaVersion: COMFYUI_WORKFLOW_SCHEMA_VERSION,
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
  outputBindings: {
    images: [
      {
        nodeId: '9',
        valueType: 'image-list',
        primary: 'first',
      },
    ],
  },
  requiredNodeClasses: ['SaveImage'],
};

describe('comfyui workflow manifests', () => {
  it('parses strict v2 exact-node manifests', () => {
    const definition = parseComfyUiWorkflowDefinition(v2Manifest, 'starter.manifest.json');

    expect(definition.schemaVersion).toBe(COMFYUI_WORKFLOW_SCHEMA_VERSION);
    expect(definition.bindings.prompt).toMatchObject({ nodeId: '76', inputName: 'value' });
    expect(definition.outputBindings.images?.[0]).toMatchObject({ nodeId: '9' });
    expect(definition.manifestFile).toBe('starter.manifest.json');
  });

  it('parses v2 selector metadata and output bindings', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
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
            valueType: 'image-list',
            primary: 'first',
          },
        ],
      },
    });

    expect(definition.schemaVersion).toBe(COMFYUI_WORKFLOW_SCHEMA_VERSION);
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
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, role: 'video.generate' })).toThrow(
      "role 'video.generate' is not supported",
    );
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, schemaVersion: 3 })).toThrow(
      "schemaVersion '3' is not supported",
    );
  });

  it('validates required role contract fields from the role catalog', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
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
      }),
    ).toThrow('image.edit workflows must declare required contract.inputs.sourceImage as image');
  });

  it('rejects bindings that are not declared by the manifest contract', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        bindings: {
          ...v2Manifest.bindings,
          width: { nodeId: 'width', inputName: 'value', valueType: 'integer' },
        },
      }),
    ).toThrow('bindings.width must be declared by contract.inputs.width');
  });

  it('rejects fields that are not supported by the selected workflow role', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        contract: {
          inputs: {
            ...v2Manifest.contract.inputs,
            sourceImage: { type: 'image', required: false },
          },
          outputs: v2Manifest.contract.outputs,
        },
        bindings: {
          ...v2Manifest.bindings,
          sourceImage: {
            nodeId: 'source',
            inputName: 'image',
            valueType: 'image-upload-reference',
          },
        },
      }),
    ).toThrow('image.generate workflows do not support contract.inputs.sourceImage');
  });

  it('rejects binding value types that do not match the semantic contract type', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        contract: {
          inputs: {
            ...v2Manifest.contract.inputs,
            width: { type: 'integer', required: false },
          },
          outputs: v2Manifest.contract.outputs,
        },
        bindings: {
          ...v2Manifest.bindings,
          width: { nodeId: 'width', inputName: 'value', valueType: 'string' },
        },
      }),
    ).toThrow(
      "bindings.width.valueType 'string' is not compatible with contract.inputs.width.type 'integer'",
    );
  });

  it('rejects missing and excessive image output mappings for current image roles', () => {
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        outputBindings: { images: [] },
      }),
    ).toThrow('outputBindings.images must contain exactly one binding');

    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        outputBindings: {
          images: [
            { nodeId: '9', valueType: 'image-list', primary: 'first' },
            { nodeId: '10', valueType: 'image-list', primary: 'first' },
          ],
        },
      }),
    ).toThrow('outputBindings.images must contain exactly one binding');
  });

  it('rejects missing version, v1, legacy output fields, unknown fields, and missing locators', () => {
    const { schemaVersion: _schemaVersion, ...missingVersion } = v2Manifest;
    expect(() => parseComfyUiWorkflowDefinition(missingVersion)).toThrow('expected 2');
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, schemaVersion: 1 })).toThrow(
      'expected 2',
    );
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, outputNodeIds: ['9'] })).toThrow(
      'manifest.outputNodeIds is not supported',
    );
    expect(() => parseComfyUiWorkflowDefinition({ ...v2Manifest, unknown: true })).toThrow(
      'manifest.unknown is not supported',
    );
    expect(() =>
      parseComfyUiWorkflowDefinition({
        ...v2Manifest,
        outputBindings: {
          images: [{ valueType: 'image-list', primary: 'first' }],
        },
      }),
    ).toThrow('must include nodeId, nodeTitle, or classType');
  });

  it('exposes initial image workflow roles through the role catalog', () => {
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.generate'].contract.inputs.prompt).toMatchObject({
      type: 'string',
      required: true,
    });
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.edit'].contract.inputs.sourceImage).toMatchObject({
      type: 'image',
      required: true,
    });
    expect(COMFYUI_WORKFLOW_ROLE_CATALOG['image.generate'].contract.outputs.images).toMatchObject({
      type: 'image-list',
      required: true,
      primary: 'first',
    });
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
        valueType: 'string',
      }),
    ).toMatchObject({
      ok: true,
      nodeId: '41',
    });
    expect(
      resolveComfyUiWorkflowBinding(graph, {
        nodeId: '76',
        nodeTitle: 'noveltea.prompt',
        classType: 'PrimitiveStringMultiline',
        inputName: 'value',
        valueType: 'string',
        selector: {
          title: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
        },
      }),
    ).toMatchObject({
      ok: true,
      nodeId: '41',
      rebased: true,
    });
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
        valueType: 'string',
      }),
    ).toMatchObject({ ok: false });
  });

  it('resolves the canonical output binding', () => {
    const definition = parseComfyUiWorkflowDefinition({
      ...v2Manifest,
      outputBindings: {
        images: [
          {
            nodeTitle: 'noveltea.output',
            classType: 'SaveImage',
            valueType: 'image-list',
            primary: 'first',
          },
        ],
      },
    });
    const graph = {
      'selected-output': {
        class_type: 'SaveImage',
        _meta: { title: 'noveltea.output' },
        inputs: { images: ['8', 0] },
      },
    };

    expect(resolvedComfyUiWorkflowOutputNodeIdList(graph, definition)).toEqual(['selected-output']);
  });
});
