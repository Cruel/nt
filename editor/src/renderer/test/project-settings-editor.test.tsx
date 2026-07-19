import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  runDraftActions,
  selectDraftEntriesForTab,
  useDraftDirtyStore,
} from '@/workbench/draft-dirty-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange?: (value: string) => void;
    className?: string;
  }) => (
    <textarea
      aria-label="source-editor"
      className={className}
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
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
  next.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  next.scenes.opening = {
    id: 'opening',
    label: 'Opening Scene',
    data: defaultSceneData('Opening Scene'),
  };
  next.dialogues.intro = {
    id: 'intro',
    label: 'Intro Dialogue',
    data: defaultDialogueData('Intro Dialogue'),
  };
  next.scripts.boot = {
    id: 'boot',
    label: 'Boot Script',
    data: { kind: 'script-module', source: { kind: 'inline-lua', source: '' } },
  };
  next.layouts.main = { id: 'main', label: 'Main Layout', data: defaultLayoutData('Main Layout') };
  next.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    data: {
      kind: 'font',
      source: { type: 'project-file', path: 'assets/fonts/main.ttf' },
      aliases: [],
      extension: '.ttf',
    },
  };
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
    },
  };
  return next;
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useDraftDirtyStore.getState().resetDraftDirty();
});

async function applyProjectSettingsDraft() {
  const entries = selectDraftEntriesForTab(useDraftDirtyStore.getState(), tab.id);
  await act(async () => {
    expect(await runDraftActions(entries, 'apply')).toBe(true);
  });
}

describe('ProjectSettingsEditor', () => {
  it('keeps edits local until save and then applies metadata, entrypoint, and startup script', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByText('Project Settings')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'New Title' } });
    expect(screen.getByLabelText('Project title')).toHaveValue('New Title');
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Old Title' } });
    await waitFor(() =>
      expect(selectDraftEntriesForTab(useDraftDirtyStore.getState(), tab.id)).toHaveLength(1),
    );

    fireEvent.click(screen.getByText('No entrypoint'));
    expect(await screen.findByText('Choose a project entrypoint')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Foyer'));
    fireEvent.change(screen.getByLabelText('source-editor'), { target: { value: 'game.start()' } });
    await applyProjectSettingsDraft();
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { name: 'New Title' },
        entrypoint: { kind: 'room', id: 'foyer' },
        startupHook: { source: 'game.start()' },
      }),
    );
    await waitFor(() =>
      expect(selectDraftEntriesForTab(useDraftDirtyStore.getState(), tab.id)).toHaveLength(0),
    );
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    expect(useCommandStore.getState().history.entries[0]?.type).toBe('project.replaceAtPath');
  });

  it('allows empty intermediate version values without invalidating the loaded project', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Version name'), { target: { value: '' } });

    expect(screen.getByLabelText('Version')).toHaveValue('');
    expect(screen.getByLabelText('Version name')).toHaveValue('');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { version: '0.1.0' },
      settings: { app: { versionName: '0.1.0' } },
    });

    const entries = selectDraftEntriesForTab(useDraftDirtyStore.getState(), tab.id);
    await act(async () => {
      expect(await runDraftActions(entries, 'apply')).toBe(false);
    });
    expect(
      screen.getByRole('heading', { name: 'Project settings could not be saved' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Version name')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Review fields' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Project settings could not be saved' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Version')).toHaveAttribute('aria-invalid', 'true');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { version: '0.1.0' },
      settings: { app: { versionName: '0.1.0' } },
    });
  });

  it('chooses non-room project entrypoints and clears them through the selector', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.click(screen.getByText('No entrypoint'));
    expect(await screen.findByText('Choose a project entrypoint')).toBeInTheDocument();
    expect(screen.getByText('Opening Scene')).toBeInTheDocument();
    expect(screen.getByText('Intro Dialogue')).toBeInTheDocument();
    expect(screen.queryByText('Boot Script')).not.toBeInTheDocument();
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Opening Scene'));
    expect(useProjectStore.getState().document).toMatchObject({ entrypoint: null });

    fireEvent.click(screen.getByText('Clear'));
    await applyProjectSettingsDraft();
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({ entrypoint: null }),
    );
  });

  it('updates runtime defaults, title screen, and icon settings', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Built-in title screen'));
    expect(await screen.findByText('Choose Title screen')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Main Layout'));
    fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'main-font' } });
    fireEvent.change(screen.getByLabelText('Title image'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Start label'), { target: { value: 'Begin' } });

    await applyProjectSettingsDraft();
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: {
          ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'main' } } } },
          text: { defaultFont: { $ref: { collection: 'assets', id: 'main-font' } } },
          titleScreen: {
            titleImage: { $ref: { collection: 'assets', id: 'logo' } },
            startLabel: 'Begin',
          },
          app: { icon: { $ref: { collection: 'assets', id: 'logo' } } },
        },
      }),
    );
  });

  it('keeps ComfyUI connection settings out of project settings', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByText('ComfyUI Workflows')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enable ComfyUI integration')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
    expect(useProjectStore.getState().document).not.toMatchObject({
      settings: { comfyui: expect.anything() },
    });
  });

  it('shows a compact ComfyUI workflow summary and opens the manager', async () => {
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      entries: [
        {
          source: 'project',
          workflowKey: 'project:broken.manifest.json',
          id: 'broken',
          label: 'Broken',
          role: 'image.generate',
          manifestFile: 'broken.manifest.json',
          workflowFile: 'broken.workflow.json',
          manifestPath: '/mock/workflows/broken.manifest.json',
          workflowPath: '/mock/workflows/broken.workflow.json',
          active: false,
          overridden: false,
          offlineStatus: 'invalid',
          onlineStatus: 'unverified',
          repairable: true,
          diagnostics: [],
          verificationDiagnostics: [],
          capabilities: {
            canCopyToEditor: true,
            canCopyToProject: false,
            canDelete: true,
            canRepair: true,
            canReveal: true,
          },
        },
      ],
      activeWorkflows: [],
      overriddenEntries: [],
      summary: {
        sources: [
          {
            source: 'project',
            root: '/mock/workflows',
            writable: true,
            available: true,
            workflowCount: 1,
            activeCount: 0,
            overriddenCount: 0,
            diagnostics: [],
          },
        ],
        totalCount: 3,
        activeCount: 2,
        overriddenCount: 0,
        invalidCount: 1,
        verifiedCount: 0,
        failedVerificationCount: 0,
      },
    });
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(await screen.findByText('Total active workflows')).toBeInTheDocument();
    expect(screen.getByText('Project workflows')).toBeInTheDocument();
    expect(screen.getByText('Invalid project workflows')).toBeInTheDocument();
    expect(screen.queryByText('Import Workflow')).not.toBeInTheDocument();
    expect(screen.queryByText('Save Built-in Workflows to Project')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Manage'));

    expect(useWorkbenchStore.getState().tabsById['tab:comfyui-workflows']).toMatchObject({
      title: 'ComfyUI Workflows',
      editorType: 'comfyui-workflows',
    });
  });
});
