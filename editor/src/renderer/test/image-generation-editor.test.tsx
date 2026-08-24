import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageGenerationEditor } from '@/editors/comfyui/ImageGenerationEditor';
import { useComfyUiGenerationStore } from '@/comfyui/comfyui-generation-store';
import { useComfyUiQueueStore } from '@/comfyui/comfyui-queue-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { consumeWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { buildSettingsTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import type {
  ComfyUiWorkflowDefinition,
  ComfyUiWorkflowSource,
} from '../../shared/comfyui-workflows';

const tab: WorkbenchTab = {
  id: 'tab:image-generation',
  title: 'Generate Image',
  editorType: 'image-generation',
  resource: {
    kind: 'tool',
    stableId: 'utility:image-generation',
    collection: 'assets',
    generationMode: 'generate',
  },
};

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
      imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 },
    },
  };
  return next;
}

function workflow(overrides: Partial<ComfyUiWorkflowDefinition>): ComfyUiWorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'workflow',
    label: 'Workflow',
    provider: 'comfyui',
    classification: 'image.generate',
    workflowFile: 'workflow.json',
    contract: {
      inputs: {
        prompt: { type: 'string', required: true },
        filenamePrefix: { type: 'string', required: false, defaultValue: 'NovelTea' },
      },
      outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
    },
    requiredNodeClasses: [],
    bindings: {
      prompt: [{ nodeId: 'prompt', inputName: 'value' }],
      filenamePrefix: [{ nodeId: '9', inputName: 'filename_prefix' }],
    },
    outputBindings: {
      images: [{ nodeId: '9' }],
    },
    manifestFile: 'workflow.manifest.json',
    ...overrides,
  };
}

function mockWorkflowList(
  workflows: ComfyUiWorkflowDefinition[],
  sourceById: Partial<Record<string, ComfyUiWorkflowSource>> = {},
) {
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    entries: [],
    activeWorkflows: workflows.map((definition) => {
      const source = sourceById[definition.id] ?? 'project';
      return {
        workflowKey: `${source}:${definition.id}.manifest.json`,
        source,
        id: definition.id,
        label: definition.label,
        classification: definition.classification,
        definition,
        offlineStatus: 'valid',
        onlineStatus: 'unverified',
        runnable: true,
        diagnostics: [],
        verificationDiagnostics: [],
      };
    }),
    overriddenEntries: [],
    summary: {
      sources: [],
      totalCount: workflows.length,
      activeCount: workflows.length,
      overriddenCount: 0,
      invalidCount: 0,
      verifiedCount: 0,
      failedVerificationCount: 0,
    },
  });
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useProjectStore.getState().loadProjectDocument({
    document: project(),
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
    projectSessionId: '11111111-1111-4111-8111-111111111111',
  });
  usePreferencesStore
    .getState()
    .setComfyUiConfig({ enabled: true, serverUrl: 'http://127.0.0.1:8000' });
  useComfyUiQueueStore.setState({ jobsByPromptId: {}, localJobsByPromptId: {}, order: [] });
  useComfyUiStore.getState().hydrateFromPreferences();
  useComfyUiStore.setState((state) => ({
    status: { ...state.status, state: 'ready', message: 'ComfyUI connected' },
  }));
  useComfyUiGenerationStore.getState().clearProjectSession();
  useWorkbenchStore.getState().resetWorkbench();
  vi.mocked(window.noveltea.generateComfyUiImage).mockClear();
  vi.mocked(window.noveltea.editComfyUiImage).mockClear();
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockClear();
  mockWorkflowList([
    workflow({ id: 'flux2-klein-text-to-image', label: 'Flux 2 Klein Text to Image' }),
    workflow({
      id: 'flux2-klein-image-edit',
      label: 'Flux 2 Klein Image Edit',
      classification: 'image.edit',
      contract: {
        inputs: {
          sourceImage: { type: 'image', required: true },
          prompt: { type: 'string', required: true },
        },
        outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
      },
      bindings: {
        sourceImage: [{ nodeId: 'source', inputName: 'image' }],
        prompt: [{ nodeId: 'prompt', inputName: 'value' }],
      },
    }),
  ]);
});

describe('ImageGenerationEditor', () => {
  it('shows a ComfyUI settings link when image generation is disabled', async () => {
    useComfyUiStore.setState((state) => ({
      config: { ...state.config, enabled: false },
      status: { ...state.status, state: 'disabled', message: 'ComfyUI disabled' },
    }));

    render(<ImageGenerationEditor tab={tab} />);

    expect(screen.getByText('Image generation requires ComfyUI.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open ComfyUI Settings'));
    expect(useWorkbenchStore.getState().tabsById['tab:settings']).toBeTruthy();
    expect(consumeWorkbenchRevealTarget(buildSettingsTab())).toMatchObject({
      id: 'settings.comfyui',
      block: 'center',
      flash: true,
    });
    expect(screen.queryByLabelText('Generate workflow')).not.toBeInTheDocument();
  });

  it('shows a configuration error when ComfyUI is enabled but unavailable', async () => {
    useComfyUiStore.setState((state) => ({
      status: { ...state.status, state: 'error', message: 'Connection refused' },
    }));

    render(<ImageGenerationEditor tab={tab} />);

    expect(
      screen.getByText(
        'Image generation requires ComfyUI, but the current configuration is not working.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('distinguishes unsaved project output availability from workflow availability', async () => {
    useProjectStore.getState().clearProject();

    render(<ImageGenerationEditor tab={tab} />);

    expect(
      await screen.findByText(
        'Save the project before generating or editing images. Generated output files need a project asset folder.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Generate workflow')).toHaveValue(
      'project:flux2-klein-text-to-image.manifest.json',
    );
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.queryByText('No valid ComfyUI workflows are available.')).not.toBeInTheDocument();
  });

  it('shows a separate workflow availability message when no valid workflows exist', async () => {
    mockWorkflowList([]);

    render(<ImageGenerationEditor tab={tab} />);

    expect(
      await screen.findByText('No valid ComfyUI workflows are available.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Generated output files need a project asset folder/),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Generate workflow')).toHaveValue('');
    expect(screen.getByLabelText('Edit workflow')).toHaveValue('');
  });

  it('queues image generation instead of immediately importing it', async () => {
    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByLabelText('Generate workflow');
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'a tea cup in a rainstorm' },
    });
    fireEvent.click(screen.getByText('Generate'));

    expect(window.noveltea.generateComfyUiImage).not.toHaveBeenCalled();
    const queue = useComfyUiQueueStore.getState();
    expect(queue.order).toHaveLength(1);
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.kind).toBe('generate');
    expect(job?.request).toMatchObject({
      projectFilePath: '/mock/project/game.json',
      workflowKey: 'project:flux2-klein-text-to-image.manifest.json',
      prompt: 'a tea cup in a rainstorm',
    });
    expect(screen.getByText('Added to queue!')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('resolves logical default workflow IDs to the active source-specific workflow key', async () => {
    usePreferencesStore.getState().setComfyUiConfig({
      defaultWorkflows: {
        'image.generate': 'flux2-klein-text-to-image',
        'image.edit': 'flux2-klein-image-edit',
      },
    });
    useComfyUiStore.getState().hydrateFromPreferences();
    mockWorkflowList(
      [
        workflow({ id: 'other-generate', label: 'Other Generate' }),
        workflow({ id: 'flux2-klein-text-to-image', label: 'Project Override Generate' }),
        workflow({
          id: 'flux2-klein-image-edit',
          label: 'User Override Edit',
          classification: 'image.edit',
          contract: {
            inputs: {
              sourceImage: { type: 'image', required: true },
              prompt: { type: 'string', required: true },
            },
            outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
          },
          bindings: {
            sourceImage: [{ nodeId: 'source', inputName: 'image' }],
            prompt: [{ nodeId: 'prompt', inputName: 'value' }],
          },
        }),
      ],
      {
        'flux2-klein-text-to-image': 'project',
        'flux2-klein-image-edit': 'user',
        'other-generate': 'built-in',
      },
    );

    render(<ImageGenerationEditor tab={tab} />);

    await waitFor(() =>
      expect(screen.getByLabelText('Generate workflow')).toHaveValue(
        'project:flux2-klein-text-to-image.manifest.json',
      ),
    );
    expect(screen.getByLabelText('Edit workflow')).toHaveValue(
      'user:flux2-klein-image-edit.manifest.json',
    );

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a default override' } });
    fireEvent.click(screen.getByText('Generate'));

    const queue = useComfyUiQueueStore.getState();
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.request).toMatchObject({
      workflowId: 'flux2-klein-text-to-image',
      workflowKey: 'project:flux2-klein-text-to-image.manifest.json',
      prompt: 'a default override',
    });
  });

  it('adds a staged revision to assets only when Add is clicked', async () => {
    useComfyUiGenerationStore.getState().appendRevisions(tab.id, [
      {
        id: 'revision-1',
        asset: {
          originalPath: 'comfyui:generated.png',
          originalName: 'generated.png',
          projectRelativePath: 'assets/generated/generated.png',
          kind: 'image',
          extension: '.png',
          mimeType: 'image/png',
          byteSize: 4,
          contentHash: 'sha256:mock',
          importedAt: 'now',
          imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 },
        },
        promptId: 'prompt-1',
        workflowId: 'flux2-klein-text-to-image',
        mode: 'generate',
        prompt: 'a tea cup in a rainstorm',
        seed: 1,
        projectRelativePath: 'assets/generated/generated.png',
        previewUrl: 'data:image/png;base64,bW9jaw==',
        absolutePath: '/mock/project/assets/generated/generated.png',
        createdAt: 'now',
      },
    ]);

    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByText(/assets\/generated\/generated.png/);
    fireEvent.click(screen.getByRole('button', { name: 'Add revision to assets' }));

    const revision = useComfyUiGenerationStore.getState().revisionsByTabId[tab.id]?.[0];
    expect(revision?.assetAddedAt).toBeTruthy();
  });

  it('queues image edits using the selected staged revision path', async () => {
    useComfyUiGenerationStore.getState().appendRevisions(tab.id, [
      {
        id: 'revision-1',
        asset: {
          originalPath: 'comfyui:generated.png',
          originalName: 'generated.png',
          projectRelativePath: 'assets/generated/generated.png',
          kind: 'image',
          extension: '.png',
          mimeType: 'image/png',
          byteSize: 4,
          contentHash: 'sha256:mock',
          importedAt: 'now',
          imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 },
        },
        promptId: 'prompt-1',
        workflowId: 'flux2-klein-text-to-image',
        mode: 'generate',
        prompt: 'a tea cup in a rainstorm',
        seed: 1,
        projectRelativePath: 'assets/generated/generated.png',
        previewUrl: 'data:image/png;base64,bW9jaw==',
        absolutePath: '/mock/project/assets/generated/generated.png',
        createdAt: 'now',
      },
    ]);

    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByText(/assets\/generated\/generated.png/);
    fireEvent.change(screen.getByLabelText('Edit selected image'), {
      target: { value: 'make it night' },
    });
    fireEvent.click(screen.getByText('Edit Selected Image'));

    expect(window.noveltea.editComfyUiImage).not.toHaveBeenCalled();
    expect(useComfyUiQueueStore.getState().order).toHaveLength(0);
    expect(
      screen.getByText('Add the source image to the Project before editing it.'),
    ).toBeInTheDocument();
  });

  it('shows and submits only bound generate controls', async () => {
    mockWorkflowList([
      workflow({
        id: 'bound-generate',
        label: 'Bound Generate',
        contract: {
          inputs: {
            prompt: { type: 'string', required: true },
            negativePrompt: { type: 'string', required: false, defaultValue: 'blur' },
            width: { type: 'integer', required: false, defaultValue: 768 },
            cfg: { type: 'number', required: false, defaultValue: 6.5 },
          },
          outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
        },
        bindings: {
          prompt: [{ nodeId: 'prompt', inputName: 'value' }],
          negativePrompt: [{ nodeId: 'negative', inputName: 'value' }],
          width: [{ nodeId: 'width', inputName: 'value' }],
          cfg: [{ nodeId: 'cfg', inputName: 'value' }],
        },
      }),
    ]);

    render(<ImageGenerationEditor tab={tab} />);

    await screen.findByLabelText('Negative prompt');
    await waitFor(() => expect(screen.getByLabelText('Negative prompt')).toHaveValue('blur'));
    expect(screen.getByLabelText('Width')).toHaveValue('768');
    expect(screen.getByLabelText('CFG')).toHaveValue('6.5');
    expect(screen.queryByLabelText('Height')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Generate steps')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Generate seed')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a lantern' } });
    fireEvent.change(screen.getByLabelText('Negative prompt'), { target: { value: 'noise' } });
    fireEvent.change(screen.getByLabelText('CFG'), { target: { value: '7.25' } });
    fireEvent.click(screen.getByText('Generate'));

    const queue = useComfyUiQueueStore.getState();
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.request).toMatchObject({
      prompt: 'a lantern',
      negativePrompt: 'noise',
      width: 768,
      cfg: 7.25,
    });
    expect(job?.request).not.toHaveProperty('height');
    expect(job?.request).not.toHaveProperty('steps');
    expect(job?.request).not.toHaveProperty('seed');
  });

  it('clears hidden generate values when switching to a workflow without those bindings', async () => {
    mockWorkflowList([
      workflow({
        id: 'full-generate',
        label: 'Full Generate',
        contract: {
          inputs: {
            prompt: { type: 'string', required: true },
            negativePrompt: { type: 'string', required: false, defaultValue: 'old default' },
            cfg: { type: 'number', required: false, defaultValue: 4 },
          },
          outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
        },
        bindings: {
          prompt: [{ nodeId: 'prompt', inputName: 'value' }],
          negativePrompt: [{ nodeId: 'negative', inputName: 'value' }],
          cfg: [{ nodeId: 'cfg', inputName: 'value' }],
        },
      }),
      workflow({
        id: 'prompt-only',
        label: 'Prompt Only',
        contract: {
          inputs: { prompt: { type: 'string', required: true } },
          outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
        },
        bindings: { prompt: [{ nodeId: 'prompt', inputName: 'value' }] },
      }),
    ]);

    render(<ImageGenerationEditor tab={tab} />);

    expect(await screen.findByLabelText('Negative prompt')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Negative prompt'), {
      target: { value: 'stale negative' },
    });
    fireEvent.change(screen.getByLabelText('CFG'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Generate workflow'), {
      target: { value: 'project:prompt-only.manifest.json' },
    });
    await waitFor(() => expect(screen.queryByLabelText('Negative prompt')).not.toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a clean prompt' } });
    fireEvent.click(screen.getByText('Generate'));

    const queue = useComfyUiQueueStore.getState();
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.request).toMatchObject({ workflowId: 'prompt-only', prompt: 'a clean prompt' });
    expect(job?.request).not.toHaveProperty('negativePrompt');
    expect(job?.request).not.toHaveProperty('cfg');
  });

  it('shows and submits bound edit controls', async () => {
    mockWorkflowList([
      workflow({ id: 'generate-only', label: 'Generate Only' }),
      workflow({
        id: 'bound-edit',
        label: 'Bound Edit',
        classification: 'image.edit',
        contract: {
          inputs: {
            sourceImage: { type: 'image', required: true },
            prompt: { type: 'string', required: true },
            negativePrompt: { type: 'string', required: false, defaultValue: 'low quality' },
            steps: { type: 'integer', required: false, defaultValue: 12 },
            cfg: { type: 'number', required: false, defaultValue: 5.5 },
          },
          outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
        },
        bindings: {
          sourceImage: [{ nodeId: 'source', inputName: 'image' }],
          prompt: [{ nodeId: 'prompt', inputName: 'value' }],
          negativePrompt: [{ nodeId: 'negative', inputName: 'value' }],
          steps: [{ nodeId: 'steps', inputName: 'value' }],
          cfg: [{ nodeId: 'cfg', inputName: 'value' }],
        },
      }),
    ]);
    const editTab: WorkbenchTab = {
      ...tab,
      id: 'tab:image-edit',
      resource: {
        kind: 'tool',
        stableId: 'utility:image-generation:logo',
        collection: 'assets',
        entityId: 'logo',
        generationMode: 'edit',
      },
    };

    render(<ImageGenerationEditor tab={editTab} />);

    await screen.findByLabelText('Edit negative prompt');
    await waitFor(() =>
      expect(screen.getByLabelText('Edit negative prompt')).toHaveValue('low quality'),
    );
    expect(screen.getByLabelText('Edit steps')).toHaveValue('12');
    expect(screen.getByLabelText('Edit CFG')).toHaveValue('5.5');
    expect(screen.queryByLabelText('Edit seed')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Edit selected image'), {
      target: { value: 'make it warmer' },
    });
    fireEvent.change(screen.getByLabelText('Edit negative prompt'), {
      target: { value: 'harsh shadows' },
    });
    fireEvent.click(screen.getByText('Edit Selected Image'));

    const queue = useComfyUiQueueStore.getState();
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.request).toMatchObject({
      workflowId: 'bound-edit',
      sourceAssetId: 'logo',
      prompt: 'make it warmer',
      negativePrompt: 'harsh shadows',
      steps: 12,
      cfg: 5.5,
    });
    expect(job?.request).not.toHaveProperty('seed');
  });
});
