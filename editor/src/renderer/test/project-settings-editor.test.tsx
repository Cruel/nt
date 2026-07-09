import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea aria-label="source-editor" className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:project-settings',
  title: 'Project Settings',
  editorType: 'project-settings',
  resource: { kind: 'tool', stableId: 'utility:project-settings' },
};

function project() {
  const next = createAuthoringProject({ name: 'Old Title' });
  next.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
  next.scenes.opening = { id: 'opening', label: 'Opening Scene', tags: [], data: {} };
  next.dialogues.intro = { id: 'intro', label: 'Intro Dialogue', tags: [], data: {} };
  next.scripts.boot = { id: 'boot', label: 'Boot Script', tags: [], data: { language: 'lua', source: '' } };
  next.layouts.main = { id: 'main', label: 'Main Layout', tags: [], data: defaultLayoutData('Main Layout') };
  next.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    tags: [],
    data: { kind: 'font', source: { type: 'project-file', path: 'assets/fonts/main.ttf' }, aliases: [], extension: '.ttf' },
  };
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  return next;
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

describe('ProjectSettingsEditor', () => {
  it('renders project settings and updates metadata, entrypoint, and startup script through commands', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByText('Project Settings')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Old Title'), { target: { value: 'New Title' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'New Title' } }));
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.updateMetadata');

    fireEvent.change(screen.getByDisplayValue('New Title'), { target: { value: '' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ project: { name: '' } }));

    fireEvent.click(screen.getByText('No entrypoint'));
    expect(await screen.findByText('Choose a project entrypoint')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Foyer'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ entrypoint: { collection: 'rooms', id: 'foyer' } }));
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.setEntrypoint');

    fireEvent.change(screen.getByLabelText('source-editor'), { target: { value: 'game.start()' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ settings: { startup: { initScript: 'game.start()' } } }));
  });

  it('chooses non-room project entrypoints and clears them through the selector', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.click(screen.getByText('No entrypoint'));
    expect(await screen.findByText('Choose a project entrypoint')).toBeInTheDocument();
    expect(screen.getByText('Opening Scene')).toBeInTheDocument();
    expect(screen.getByText('Intro Dialogue')).toBeInTheDocument();
    expect(screen.getByText('Boot Script')).toBeInTheDocument();
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Opening Scene'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ entrypoint: { collection: 'scenes', id: 'opening' } }));

    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ entrypoint: null }));
  });

  it('updates runtime defaults, title screen, and icon settings', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Built-in title screen'));
    expect(await screen.findByText('Choose Title screen')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Main Layout'));
    fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'main-font' } });
    fireEvent.change(screen.getByLabelText('Title image'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Start label'), { target: { value: 'Begin' } });

    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      settings: {
        ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'main' } } } },
        text: { defaultFont: { $ref: { collection: 'assets', id: 'main-font' } } },
        titleScreen: { titleImage: { $ref: { collection: 'assets', id: 'logo' } }, startLabel: 'Begin' },
        app: { icon: { $ref: { collection: 'assets', id: 'logo' } } },
      },
    }));
  });

  it('keeps ComfyUI connection settings out of project settings', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByText('ComfyUI Workflows')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enable ComfyUI integration')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
    expect(useProjectStore.getState().document).not.toMatchObject({ settings: { comfyui: expect.anything() } });
  });

  it('imports a ComfyUI API workflow through the Project Settings wizard', async () => {
    const workflowText = JSON.stringify({
      76: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'portrait' }, _meta: { title: 'noveltea.prompt' } },
      9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'NovelTea' }, _meta: { title: 'noveltea.output' } },
    });
    vi.mocked(window.noveltea.analyzeComfyUiWorkflowImport).mockResolvedValue({
      ok: true,
      diagnostics: [{ severity: 'warning', category: 'comfyui-workflows', path: '/object_info', message: 'ComfyUI object_info was unavailable; class compatibility could not be checked.' }],
      analysis: {
        nodes: [
          { id: '76', classType: 'PrimitiveStringMultiline', title: 'noveltea.prompt', inputs: { value: 'portrait' } },
          { id: '9', classType: 'SaveImage', title: 'noveltea.output', inputs: { images: ['8', 0], filename_prefix: 'NovelTea' } },
        ],
        links: [{ fromNodeId: '8', fromOutputIndex: 0, toNodeId: '9', toInputName: 'images' }],
        classTypes: ['PrimitiveStringMultiline', 'SaveImage'],
        diagnostics: [],
        looksLikeApiWorkflow: true,
        looksLikeSaveWorkflow: false,
      },
      roleCandidates: {
        'image.generate': {
          candidates: {
            prompt: [{
              semanticKey: 'prompt',
              nodeId: '76',
              classType: 'PrimitiveStringMultiline',
              nodeTitle: 'noveltea.prompt',
              inputName: 'value',
              valueType: 'string',
              confidence: 'high',
              score: 125,
              reasons: ['title marker', 'primitive text'],
              currentValue: 'portrait',
            }],
            images: [{
              semanticKey: 'images',
              nodeId: '9',
              classType: 'SaveImage',
              nodeTitle: 'noveltea.output',
              inputName: 'images',
              valueType: 'image-list',
              confidence: 'high',
              score: 180,
              reasons: ['title marker', 'SaveImage'],
            }],
          },
        },
      },
    });
    vi.mocked(window.noveltea.saveImportedComfyUiWorkflow).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      workflowFile: 'portrait.workflow.json',
      manifestFile: 'portrait.manifest.json',
    });
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Import Workflow'));
    expect(await screen.findByText('Import ComfyUI Workflow')).toBeInTheDocument();
    const file = new File([workflowText], 'portrait.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(workflowText) });
    fireEvent.change(screen.getByLabelText('API workflow JSON'), { target: { files: [file] } });
    await waitFor(() => expect(window.noveltea.analyzeComfyUiWorkflowImport).toHaveBeenCalledWith(expect.objectContaining({
      projectFilePath: '/mock/project.json',
      workflowJsonText: workflowText,
    })));

    for (let index = 0; index < 6; index += 1) {
      fireEvent.click(screen.getByText('Next'));
    }
    expect(await screen.findByText('Save Import')).toBeEnabled();
    fireEvent.click(screen.getByText('Save Import'));

    await waitFor(() => expect(window.noveltea.saveImportedComfyUiWorkflow).toHaveBeenCalled());
    const request = vi.mocked(window.noveltea.saveImportedComfyUiWorkflow).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      projectFilePath: '/mock/project.json',
      workflowFileName: 'portrait.workflow.json',
      manifestFileName: 'portrait.manifest.json',
      workflowJsonText: workflowText,
      overwrite: false,
    });
    expect(request?.manifest).toMatchObject({
      schemaVersion: 2,
      id: 'portrait',
      label: 'Portrait',
      role: 'image.generate',
      workflowFile: 'portrait.workflow.json',
      bindings: {
        prompt: {
          nodeId: '76',
          nodeTitle: 'noveltea.prompt',
          classType: 'PrimitiveStringMultiline',
          inputName: 'value',
          valueType: 'string',
          selector: { title: 'noveltea.prompt', classType: 'PrimitiveStringMultiline', inputName: 'value' },
        },
      },
      outputBindings: {
        images: [{
          nodeId: '9',
          nodeTitle: 'noveltea.output',
          classType: 'SaveImage',
          outputName: 'images',
          valueType: 'image-list',
          primary: 'first',
        }],
      },
      outputNodeIds: ['9'],
      requiredNodeClasses: ['PrimitiveStringMultiline', 'SaveImage'],
    });
    await waitFor(() => expect(window.noveltea.listComfyUiWorkflows).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Imported portrait.workflow.json.')).toBeInTheDocument();
  });
});
