import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageGenerationEditor } from '@/editors/comfyui/ImageGenerationEditor';
import { useComfyUiGenerationStore } from '@/comfyui/comfyui-generation-store';
import { useComfyUiQueueStore } from '@/comfyui/comfyui-queue-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = {
  id: 'tab:image-generation',
  title: 'Generate Image',
  editorType: 'image-generation',
  resource: { kind: 'tool', stableId: 'utility:image-generation', collection: 'assets', generationMode: 'generate' },
};

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  return next;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
  usePreferencesStore.getState().setComfyUiConfig({ enabled: true, serverUrl: 'http://127.0.0.1:8000' });
  useComfyUiQueueStore.setState({ jobsByPromptId: {}, localJobsByPromptId: {}, order: [] });
  useComfyUiStore.getState().hydrateFromPreferences();
  useComfyUiStore.setState((state) => ({ status: { ...state.status, state: 'ready', message: 'ComfyUI connected' } }));
  useComfyUiGenerationStore.getState().clearProjectSession();
  vi.mocked(window.noveltea.generateComfyUiImage).mockClear();
  vi.mocked(window.noveltea.editComfyUiImage).mockClear();
});

describe('ImageGenerationEditor', () => {
  it('shows a ComfyUI settings link when image generation is disabled', async () => {
    useComfyUiStore.setState((state) => ({ config: { ...state.config, enabled: false }, status: { ...state.status, state: 'disabled', message: 'ComfyUI disabled' } }));

    render(<ImageGenerationEditor tab={tab} />);

    expect(screen.getByText('Image generation requires ComfyUI.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open ComfyUI Settings'));
    expect(screen.queryByLabelText('Generate workflow')).not.toBeInTheDocument();
  });

  it('shows a configuration error when ComfyUI is enabled but unavailable', async () => {
    useComfyUiStore.setState((state) => ({ status: { ...state.status, state: 'error', message: 'Connection refused' } }));

    render(<ImageGenerationEditor tab={tab} />);

    expect(screen.getByText('Image generation requires ComfyUI, but the current configuration is not working.')).toBeInTheDocument();
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('queues image generation instead of immediately importing it', async () => {
    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByLabelText('Generate workflow');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a tea cup in a rainstorm' } });
    fireEvent.click(screen.getByText('Generate'));

    expect(window.noveltea.generateComfyUiImage).not.toHaveBeenCalled();
    const queue = useComfyUiQueueStore.getState();
    expect(queue.order).toHaveLength(1);
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.kind).toBe('generate');
    expect(job?.request).toMatchObject({ projectFilePath: '/mock/project/game.json', prompt: 'a tea cup in a rainstorm' });
    expect(screen.getByText('Added to queue!')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('adds a staged revision to assets only when Add is clicked', async () => {
    useComfyUiGenerationStore.getState().appendRevisions(tab.id, [{
      id: 'revision-1',
      asset: { originalPath: 'comfyui:generated.png', originalName: 'generated.png', projectRelativePath: 'assets/generated/generated.png', kind: 'image', extension: '.png', mimeType: 'image/png', byteSize: 4, contentHash: 'sha256:mock', importedAt: 'now' },
      promptId: 'prompt-1',
      workflowId: 'flux2-klein-text-to-image',
      mode: 'generate',
      prompt: 'a tea cup in a rainstorm',
      seed: 1,
      projectRelativePath: 'assets/generated/generated.png',
      previewUrl: 'data:image/png;base64,bW9jaw==',
      absolutePath: '/mock/project/assets/generated/generated.png',
      createdAt: 'now',
    }]);

    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByText(/assets\/generated\/generated.png/);
    fireEvent.click(screen.getByRole('button', { name: 'Add revision to assets' }));

    const revision = useComfyUiGenerationStore.getState().revisionsByTabId[tab.id]?.[0];
    expect(revision?.assetAddedAt).toBeTruthy();
  });

  it('queues image edits using the selected staged revision path', async () => {
    useComfyUiGenerationStore.getState().appendRevisions(tab.id, [{
      id: 'revision-1',
      asset: { originalPath: 'comfyui:generated.png', originalName: 'generated.png', projectRelativePath: 'assets/generated/generated.png', kind: 'image', extension: '.png', mimeType: 'image/png', byteSize: 4, contentHash: 'sha256:mock', importedAt: 'now' },
      promptId: 'prompt-1',
      workflowId: 'flux2-klein-text-to-image',
      mode: 'generate',
      prompt: 'a tea cup in a rainstorm',
      seed: 1,
      projectRelativePath: 'assets/generated/generated.png',
      previewUrl: 'data:image/png;base64,bW9jaw==',
      absolutePath: '/mock/project/assets/generated/generated.png',
      createdAt: 'now',
    }]);

    render(<ImageGenerationEditor tab={tab} />);
    await screen.findByText(/assets\/generated\/generated.png/);
    fireEvent.change(screen.getByLabelText('Edit selected image'), { target: { value: 'make it night' } });
    fireEvent.click(screen.getByText('Edit Selected Image'));

    expect(window.noveltea.editComfyUiImage).not.toHaveBeenCalled();
    const queue = useComfyUiQueueStore.getState();
    expect(queue.order).toHaveLength(1);
    const job = queue.localJobsByPromptId[queue.order[0]!];
    expect(job?.kind).toBe('edit');
    expect(job?.request).toMatchObject({ sourceProjectRelativePath: 'assets/generated/generated.png', prompt: 'make it night' });
  });
});
