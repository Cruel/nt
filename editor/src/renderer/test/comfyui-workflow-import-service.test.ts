import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import bundledTextToImageWorkflow from '../../../assets/comfyui/workflows/flux2-klein-text-to-image.workflow.json';
import {
  analyzeComfyUiWorkflowImport,
  repairComfyUiWorkflowManifest,
  saveImportedComfyUiWorkflow,
} from '../../main/services/comfyui-workflow-import-service';
import { listComfyUiWorkflows } from '../../main/services/comfyui-service';

const roots: string[] = [];

function projectFilePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-import-'));
  roots.push(root);
  return path.join(root, 'project.json');
}

function simpleWorkflow() {
  return {
    prompt: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'noveltea.prompt' }, inputs: { value: 'Tea' } },
    output: { class_type: 'SaveImage', _meta: { title: 'noveltea.output' }, inputs: { filename_prefix: 'NovelTea', images: ['prompt', 0] } },
  };
}

function simpleManifest(workflowFile = 'custom.workflow.json') {
  return {
    schemaVersion: 2,
    id: 'custom',
    label: 'Custom',
    provider: 'comfyui',
    role: 'image.generate',
    workflowFile,
    contract: {
      inputs: { prompt: { type: 'string', required: true } },
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
    },
    outputBindings: {
      images: [{
        nodeId: 'output',
        nodeTitle: 'noveltea.output',
        classType: 'SaveImage',
        outputName: 'images',
        valueType: 'image-list',
        primary: 'first',
      }],
    },
    outputNodeIds: ['output'],
    defaults: { filenamePrefix: 'NovelTea' },
    requiredNodeClasses: ['PrimitiveStringMultiline', 'SaveImage'],
  };
}

function writeWorkflowPair(project: string, manifest: unknown, workflow: unknown = simpleWorkflow()) {
  const workflowsRoot = path.join(path.dirname(project), 'workflows');
  fs.mkdirSync(workflowsRoot, { recursive: true });
  fs.writeFileSync(path.join(workflowsRoot, 'custom.workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
  fs.writeFileSync(path.join(workflowsRoot, 'custom.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('comfyui workflow import service', () => {
  it('analyzes bundled API workflows offline and returns role candidates', async () => {
    const response = await analyzeComfyUiWorkflowImport({
      projectFilePath: projectFilePath(),
      workflowJsonText: JSON.stringify(bundledTextToImageWorkflow),
    });

    expect(response.ok).toBe(true);
    expect(response.analysis?.looksLikeApiWorkflow).toBe(true);
    expect(response.roleCandidates['image.generate']?.candidates.prompt?.length).toBeGreaterThan(0);
    expect(response.roleCandidates['image.generate']?.candidates.images?.length).toBeGreaterThan(0);
    expect(response.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      message: expect.stringContaining('object_info was unavailable'),
    }));
  });

  it('rejects save-format workflow analysis with API export guidance', async () => {
    const response = await analyzeComfyUiWorkflowImport({
      projectFilePath: projectFilePath(),
      workflowJsonText: JSON.stringify({ last_node_id: 1, nodes: [], links: [], groups: [] }),
    });

    expect(response.ok).toBe(false);
    expect(response.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('Export Workflow (API)'),
    }));
  });

  it('rejects invalid workflow JSON', async () => {
    const response = await analyzeComfyUiWorkflowImport({
      projectFilePath: projectFilePath(),
      workflowJsonText: '{',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBeTruthy();
    expect(response.diagnostics[0]?.message).toContain('Workflow JSON is invalid');
  });

  it('saves valid workflow and manifest files', async () => {
    const project = projectFilePath();
    const response = await saveImportedComfyUiWorkflow({
      projectFilePath: project,
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: JSON.stringify(simpleWorkflow()),
      manifest: simpleManifest(),
      overwrite: false,
    });

    expect(response).toMatchObject({
      ok: true,
      success: true,
      workflowFile: 'custom.workflow.json',
      manifestFile: 'custom.manifest.json',
      definition: { id: 'custom' },
    });
    expect(fs.existsSync(path.join(path.dirname(project), 'workflows', 'custom.workflow.json'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(project), 'workflows', 'custom.manifest.json'))).toBe(true);
  });

  it('rejects collisions unless overwrite is enabled', async () => {
    const project = projectFilePath();
    const request = {
      projectFilePath: project,
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: JSON.stringify(simpleWorkflow()),
      manifest: simpleManifest(),
      overwrite: false,
    };

    expect((await saveImportedComfyUiWorkflow(request)).success).toBe(true);
    const collision = await saveImportedComfyUiWorkflow(request);
    expect(collision.success).toBe(false);
    expect(collision.error).toContain('overwrite');

    const overwrite = await saveImportedComfyUiWorkflow({ ...request, overwrite: true });
    expect(overwrite.success).toBe(true);
  });

  it('rejects unsafe import file names', async () => {
    const base = {
      projectFilePath: projectFilePath(),
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: JSON.stringify(simpleWorkflow()),
      manifest: simpleManifest(),
      overwrite: false,
    };

    for (const workflowFileName of ['../x.workflow.json', '/tmp/x.workflow.json', 'nested/x.workflow.json', 'x.json']) {
      const response = await saveImportedComfyUiWorkflow({ ...base, workflowFileName });
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/safe file name|must end/);
    }
  });

  it('rejects manifest and workflow filename mismatches', async () => {
    const response = await saveImportedComfyUiWorkflow({
      projectFilePath: projectFilePath(),
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: JSON.stringify(simpleWorkflow()),
      manifest: simpleManifest('other.workflow.json'),
      overwrite: false,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('does not match');
  });

  it('lists valid and invalid installed workflow entries while keeping workflows valid-only', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, simpleManifest());
    const workflowsRoot = path.join(path.dirname(project), 'workflows');
    fs.writeFileSync(path.join(workflowsRoot, 'broken.manifest.json'), '{');

    const response = await listComfyUiWorkflows(project);

    expect(response.entries).toHaveLength(2);
    expect(response.entries).toContainEqual(expect.objectContaining({ manifestFile: 'custom.manifest.json', status: 'valid', repairable: true }));
    expect(response.entries).toContainEqual(expect.objectContaining({ manifestFile: 'broken.manifest.json', status: 'invalid', repairable: false }));
    expect(response.workflows).toHaveLength(1);
    expect(response.workflows[0]?.id).toBe('custom');
  });

  it('reports missing workflow files as invalid installed entries', async () => {
    const project = projectFilePath();
    const workflowsRoot = path.join(path.dirname(project), 'workflows');
    fs.mkdirSync(workflowsRoot, { recursive: true });
    fs.writeFileSync(path.join(workflowsRoot, 'custom.manifest.json'), `${JSON.stringify(simpleManifest(), null, 2)}\n`);

    const response = await listComfyUiWorkflows(project);

    expect(response.entries[0]).toMatchObject({ manifestFile: 'custom.manifest.json', status: 'invalid', repairable: false });
    expect(response.entries[0]?.diagnostics[0]?.message).toContain('no such file');
    expect(response.workflows).toHaveLength(0);
  });

  it('reports stale node id rebases through selector metadata', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, {
      ...simpleManifest(),
      bindings: {
        prompt: {
          nodeId: 'old-prompt',
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
          valueType: 'string',
          selector: { title: 'noveltea.prompt', classType: 'PrimitiveStringMultiline', inputName: 'value' },
        },
      },
    });

    const response = await listComfyUiWorkflows(project);

    expect(response.entries[0]).toMatchObject({ status: 'warning' });
    expect(response.entries[0]?.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      message: expect.stringContaining('Rebased stale node id old-prompt'),
    }));
  });

  it('reports ambiguous selector bindings as invalid', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, {
      ...simpleManifest(),
      bindings: {
        prompt: {
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
          valueType: 'string',
          selector: { classType: 'PrimitiveStringMultiline', inputName: 'value' },
        },
      },
    }, {
      promptA: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'A' }, inputs: { value: 'Tea' } },
      promptB: { class_type: 'PrimitiveStringMultiline', _meta: { title: 'B' }, inputs: { value: 'Tea' } },
      output: simpleWorkflow().output,
    });

    const response = await listComfyUiWorkflows(project);

    expect(response.entries[0]).toMatchObject({ status: 'invalid' });
    expect(response.entries[0]?.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('matches multiple workflow nodes'),
    }));
    expect(response.workflows).toHaveLength(0);
  });

  it('repairs a manifest without rewriting the workflow file', async () => {
    const project = projectFilePath();
    writeWorkflowPair(project, { ...simpleManifest(), label: 'Old Label' });
    const workflowPath = path.join(path.dirname(project), 'workflows', 'custom.workflow.json');
    const beforeWorkflow = fs.readFileSync(workflowPath, 'utf8');

    const response = await repairComfyUiWorkflowManifest({
      projectFilePath: project,
      manifestFileName: 'custom.manifest.json',
      manifest: { ...simpleManifest(), label: 'New Label' },
      overwrite: true,
    });

    expect(response).toMatchObject({ success: true, definition: { label: 'New Label' } });
    expect(fs.readFileSync(workflowPath, 'utf8')).toBe(beforeWorkflow);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(project), 'workflows', 'custom.manifest.json'), 'utf8')).label).toBe('New Label');
  });
});
