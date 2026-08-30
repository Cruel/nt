import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { invokeWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { selectPendingSaveUnitIds, usePendingInputStore } from '@/workbench/pending-input-store';
import { getTabDirtyState } from '@/workbench/dirty-state';
import { captureWorkbenchTabState, clearWorkbenchTabStates } from '@/workbench/workbench-tab-state';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

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
  resource: { kind: 'project', stableId: 'project:settings' },
};

function selectProjectSettingsCategory(name: string) {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Project settings categories' })).getByRole(
      'button',
      { name },
    ),
  );
}

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
  next.interactables.coin = {
    id: 'coin',
    label: 'Coin',
    data: defaultInteractableData('Coin'),
  };
  const credits = defaultInteractableData('Credits');
  credits.stackable = true;
  credits.stackLimit = 10;
  next.interactables.credits = { id: 'credits', label: 'Credits', data: credits };
  next.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    data: {
      kind: 'font',
      source: { type: 'project-file', path: 'assets/fonts/main.ttf' },
      aliases: [],
      extension: '.ttf',
      imageMetadata: null,
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
      imageMetadata: { width: 1024, height: 1024, hasAlpha: true, orientation: 1 },
    },
  };
  return next;
}

function currentRoomNavigationTransition() {
  return (useProjectStore.getState().document as ReturnType<typeof project> | null)?.settings
    .presentation.roomNavigationTransition;
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
  clearWorkbenchTabStates();
  setLoadedEditorProjectState(emptyEditorProjectState());
});

describe('ProjectSettingsEditor', () => {
  it('restores the selected category on the first remount render', () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const firstRender = render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Display');

    act(() => {
      captureWorkbenchTabState(tab.id);
    });
    firstRender.unmount();

    render(<ProjectSettingsEditor tab={tab} />);
    expect(screen.getByRole('button', { name: 'Display' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('selects the owning category for a project settings target', () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    act(() => {
      invokeWorkbenchTargetHandler(tab.id, {
        id: 'projectSettings.field.appDisplayName',
        requestId: 1,
      });
    });

    expect(screen.getByRole('button', { name: 'App Identity' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
  });

  it('authors semantic Purpose mixing and Voice ducking from the Audio category', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Audio');

    const musicVolume = screen.getByLabelText('Music volume');
    expect(musicVolume).toHaveValue('1');
    fireEvent.change(musicVolume, { target: { value: '0.65' } });
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as ReturnType<typeof project>).settings.audio.purposes
          .music.volume,
      ).toBe(0.65),
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Ambience muted' }));
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as ReturnType<typeof project>).settings.audio.purposes
          .ambience.muted,
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    fireEvent.change(screen.getByLabelText('Music gain while Voice is active'), {
      target: { value: '0.3' },
    });
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as ReturnType<typeof project>).settings.audio
          .voiceDucking,
      ).toMatchObject({ enabled: true, musicGain: 0.3 }),
    );
  });

  it('preserves inactive room transition fields while showing only active controls', async () => {
    const nextProject = project();
    nextProject.settings.presentation.roomNavigationTransition = {
      kind: 'cut',
      durationMs: 750,
      color: '#112233',
      skippable: true,
    };
    useProjectStore.getState().loadProjectDocument({
      document: nextProject,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Transitions');

    const kind = screen.getByLabelText('Kind');
    expect(screen.queryByLabelText('Duration (ms)')).not.toBeInTheDocument();
    expect(screen.queryByText('Fade color')).not.toBeInTheDocument();

    fireEvent.change(kind, { target: { value: 'fade' } });
    await waitFor(() =>
      expect(currentRoomNavigationTransition()).toMatchObject({
        kind: 'fade',
        durationMs: 750,
        color: '#112233',
      }),
    );
    expect(screen.getByLabelText('Duration (ms)')).toBeInTheDocument();
    expect(screen.getByText('Fade color')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose fade color' })).toBeInTheDocument();

    fireEvent.change(kind, { target: { value: 'dissolve' } });
    await waitFor(() =>
      expect(currentRoomNavigationTransition()).toMatchObject({
        kind: 'dissolve',
        durationMs: 750,
        color: '#112233',
      }),
    );
    expect(screen.getByLabelText('Duration (ms)')).toBeInTheDocument();
    expect(screen.queryByText('Fade color')).not.toBeInTheDocument();

    fireEvent.change(kind, { target: { value: 'cut' } });
    await waitFor(() =>
      expect(currentRoomNavigationTransition()).toMatchObject({
        kind: 'cut',
        durationMs: 750,
        color: '#112233',
      }),
    );
    expect(screen.queryByLabelText('Duration (ms)')).not.toBeInTheDocument();

    fireEvent.change(kind, { target: { value: 'fade' } });
    await waitFor(() =>
      expect(currentRoomNavigationTransition()).toMatchObject({
        kind: 'fade',
        durationMs: 750,
        color: '#112233',
      }),
    );
    expect(screen.getByRole('button', { name: 'Choose fade color' })).toHaveTextContent('#112233');
  });

  it('writes metadata, entrypoint, and startup script directly through focused commands', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'New Title' } });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'New Title' } }),
    );

    fireEvent.click(screen.getByText('No entrypoint'));
    expect(await screen.findByText('Choose a project entrypoint')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Foyer'));
    fireEvent.click(screen.getByText('Bootstrap'));
    expect(await screen.findByText('Choose Bootstrap Module')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Boot Script'));
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { name: 'New Title' },
        entrypoint: { kind: 'room', id: 'foyer' },
        bootstrapModule: { $ref: { collection: 'scripts', id: 'boot' } },
      }),
    );
    expect(useDraftDirtyStore.getState().entriesByKey).toEqual({});
    expect(useCommandStore.getState().history.entries.map((entry) => entry.type)).toEqual([
      'project.updateMetadata',
      'project.setEntrypoint',
      'project.setBootstrapModule',
    ]);
    expect(useCommandStore.getState().history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originSaveUnitId: 'project:settings',
          persistencePolicy: 'manual-save',
        }),
      ]),
    );
  });

  it('keeps representable semantic errors authoritative and visible through field diagnostics', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '' } });
    expect(screen.getByLabelText('Version')).toHaveValue('');
    await waitFor(() =>
      expect(screen.getByLabelText('Version')).toHaveAttribute('aria-invalid', 'true'),
    );
    selectProjectSettingsCategory('App Identity');
    fireEvent.change(screen.getByLabelText('Version name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Short name'), { target: { value: 'Temporary' } });
    fireEvent.change(screen.getByLabelText('Short name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Theme color'), { target: { value: 'not-a-color' } });

    expect(screen.getByLabelText('Version name')).toHaveValue('');
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { version: '' },
        settings: { app: { versionName: '', shortName: '', themeColor: 'not-a-color' } },
      }),
    );
    expect(screen.getByLabelText('Version name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Short name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Theme color')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Project settings could not be saved')).not.toBeInTheDocument();
    expect(useDraftDirtyStore.getState().entriesByKey).toEqual({});
  });

  it('preserves exact pending numeric text through recovery and clears it on a valid commit', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const firstRender = render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Display');

    fireEvent.change(screen.getByLabelText('UI scale minimum'), { target: { value: '1.' } });
    await waitFor(() =>
      expect(
        usePendingInputStore.getState().entriesBySaveUnitId['project:settings']?.[
          '/settings/accessibility/uiScale/minimum'
        ],
      ).toEqual({ value: '1.', diagnosticCode: 'editor.pending-input.number.invalid' }),
    );
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { accessibility: { uiScale: { minimum: 1 } } },
    });
    expect(
      getTabDirtyState(
        tab,
        useProjectStore.getState().document,
        useProjectStore.getState().savedDocument,
        {},
        selectPendingSaveUnitIds(usePendingInputStore.getState()),
      ),
    ).toMatchObject({ dirty: true, pendingInputDirty: true, saveUnitId: 'project:settings' });
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings']
        ?.pendingRawInputByPath,
    ).toEqual({
      '/settings/accessibility/uiScale/minimum': {
        value: '1.',
        diagnosticCode: 'editor.pending-input.number.invalid',
      },
    });

    firstRender.unmount();
    render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Display');
    expect(screen.getByLabelText('UI scale minimum')).toHaveValue('1.');
    expect(screen.getByLabelText('UI scale minimum')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('UI scale minimum'), { target: { value: '0.5' } });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: { accessibility: { uiScale: { minimum: 0.5 } } },
      }),
    );
    expect(usePendingInputStore.getState().entriesBySaveUnitId['project:settings']).toBeUndefined();
    expect(screen.getByLabelText('UI scale minimum')).toHaveValue('0.5');

    fireEvent.change(screen.getByLabelText('UI scale minimum'), { target: { value: '1.5' } });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: { accessibility: { uiScale: { minimum: 1.5 } } },
      }),
    );
    expect(usePendingInputStore.getState().entriesBySaveUnitId['project:settings']).toBeUndefined();
    expect(screen.getByLabelText('UI scale minimum')).toHaveAttribute('aria-invalid', 'true');
  });

  it('changes reference resolution only after explicit valid confirmation', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Display');

    fireEvent.click(screen.getByRole('button', { name: 'Change Reference Resolution...' }));
    expect(screen.getByLabelText('Width')).toHaveValue('1920');
    expect(screen.getByLabelText('Height')).toHaveValue('1080');

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Confirm Resolution Change' })).toBeDisabled();
    expect(useProjectStore.getState().document).toMatchObject({
      settings: {
        display: {
          referenceResolution: { width: 1920, height: 1080 },
          worldRasterPolicy: 'capped',
          barColor: '#000000',
        },
      },
    });

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1280' } });
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '720' } });
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { display: { referenceResolution: { width: 1920, height: 1080 } } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Resolution Change' }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: {
          display: {
            referenceResolution: { width: 1280, height: 720 },
            worldRasterPolicy: 'capped',
            barColor: '#000000',
          },
        },
      }),
    );
    expect(useCommandStore.getState().history.entries.at(-1)).toMatchObject({
      type: 'project.setReferenceResolution',
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
    });
    act(() => {
      useCommandStore.getState().undo();
    });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: { display: { referenceResolution: { width: 1920, height: 1080 } } },
      }),
    );
  });

  it('uses standard Undo and Redo and survives editor remounts without a whole-form draft', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const firstRender = render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Project title'), {
      target: { value: 'Authoritative Title' },
    });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { name: 'Authoritative Title' },
      }),
    );
    firstRender.unmount();
    render(<ProjectSettingsEditor tab={tab} />);
    expect(screen.getByLabelText('Project title')).toHaveValue('Authoritative Title');

    act(() => {
      useCommandStore.getState().undo();
    });
    await waitFor(() => expect(screen.getByLabelText('Project title')).toHaveValue('Old Title'));
    act(() => {
      useCommandStore.getState().redo();
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Project title')).toHaveValue('Authoritative Title'),
    );
  });

  it('chooses non-room project entrypoints and clears them through the selector immediately', async () => {
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
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        entrypoint: { kind: 'scene', id: 'opening' },
      }),
    );

    fireEvent.click(screen.getByText('Clear'));
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
    selectProjectSettingsCategory('Runtime');

    fireEvent.click(screen.getByText('Built-in title screen'));
    expect(await screen.findByText('Choose Title screen')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Main Layout'));
    fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'main-font' } });
    fireEvent.change(screen.getByLabelText('Default Inventory Layout'), {
      target: { value: 'main' },
    });
    fireEvent.change(screen.getByLabelText('Default Verb Menu Layout'), {
      target: { value: 'main' },
    });
    selectProjectSettingsCategory('Title Screen');
    fireEvent.change(screen.getByLabelText('Title image'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Start label'), { target: { value: 'Begin' } });
    selectProjectSettingsCategory('App Identity');
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: 'logo' } });

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        settings: {
          ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'main' } } } },
          inventory: {
            defaultLayout: { $ref: { collection: 'layouts', id: 'main' } },
          },
          interaction: {
            defaultVerbMenuLayout: { $ref: { collection: 'layouts', id: 'main' } },
          },
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

  it('authors starting contents for the single default Inventory', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<ProjectSettingsEditor tab={tab} />);
    selectProjectSettingsCategory('Runtime');

    expect(screen.queryByLabelText('Player Inventory')).toBeNull();
    fireEvent.change(screen.getByLabelText('Inventory Interactable'), {
      target: { value: 'credits' },
    });
    fireEvent.change(screen.getByLabelText('New inventory quantity'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const document = useProjectStore.getState().document;
      expect(document).toMatchObject({
        inventories: [{ id: 'inventory', label: 'Inventory' }],
        interactableInstances: {
          credits: {
            id: 'credits',
            definition: { $ref: { collection: 'interactables', id: 'credits' } },
            quantity: 4,
            location: {
              kind: 'inventory',
              inventory: { owner: { kind: 'project' }, inventoryId: 'inventory' },
            },
          },
        },
      });
    });

    expect(screen.getByLabelText('Quantity for credits')).toHaveValue(4);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        interactableInstances: { credits: { location: { kind: 'unplaced' } } },
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
    selectProjectSettingsCategory('Integrations');

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
          classification: 'image.generate',
          manifestFile: 'broken.manifest.json',
          workflowFile: 'broken.workflow.json',
          manifestPath: '/mock/workflows/broken.manifest.json',
          workflowPath: '/mock/workflows/broken.workflow.json',
          active: false,
          overridden: false,
          offlineStatus: 'invalid',
          onlineStatus: 'unverified',
          runnable: true,
          repairable: true,
          diagnostics: [],
          verificationDiagnostics: [],
          capabilities: {
            canCopyToUser: true,
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
    selectProjectSettingsCategory('Integrations');

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
