import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import {
  defaultArchetypeData,
  resolveGameplayInstanceRecord,
} from '../../shared/project-schema/authoring-archetypes';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  dispatchWorkspaceToolbarCommand,
  WORKSPACE_TOOLBAR_COMMAND_EVENT,
  type WorkspaceToolbarCommandDetail,
} from '@/workspace/workspace-toolbar-events';
import { useProjectExplorerStore } from '@/workspace/project-explorer-store';
import { authoringDependencyGraphService } from '@/project/authoring-dependency-graph-runtime';
import { useWorkspaceStore } from '@/stores/workspace-store';

function loadProject(project: AuthoringProject = createAuthoringProject()) {
  useProjectStore.getState().loadUnsavedProjectDocument(project);
}

describe('ProjectExplorer', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useWorkbenchStore.getState().resetWorkbench();
    useProjectExplorerStore.getState().hydrate(undefined, undefined);
    useRecentProjectsStore.setState({ recentProjects: [] });
    useWorkspaceStore.getState().setDiagnostics([]);
  });

  it('shows warning and error counts on collection categories', () => {
    const project = createAuthoringProject();
    project.rooms.bedroom = {
      id: 'bedroom',
      label: 'Bedroom',
      data: defaultRoomData('Bedroom'),
    };
    project.rooms.home = { id: 'home', label: 'Home', data: defaultRoomData('Home') };
    loadProject(project);
    useWorkspaceStore.getState().setDiagnostics([
      {
        severity: 'warning',
        path: '/rooms/home/data/description',
        message: 'Room description is empty.',
      },
      {
        severity: 'warning',
        path: '/rooms/bedroom/data/description',
        message: 'Room description is empty.',
      },
      {
        severity: 'error',
        path: '/rooms/home/data/layout',
        message: 'Layout does not exist.',
      },
    ]);

    render(<ProjectExplorer nodes={[]} />);

    const rooms = screen.getByRole('button', { name: /^rooms/i });
    expect(rooms).toHaveTextContent('2');
    expect(rooms.querySelector('[aria-label="2 warnings"]')).toBeInTheDocument();
    expect(rooms.querySelector('[aria-label="1 errors"]')).toBeInTheDocument();
  });

  it('shows recent projects in the sidebar when no project is open', () => {
    useRecentProjectsStore.setState({
      recentProjects: [
        {
          projectPath: '/projects/demo',
          projectFilePath: '/projects/demo/game.json',
          label: 'Demo Project',
          openedAt: 1,
        },
      ],
    });
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);

    render(<ProjectExplorer nodes={[]} />);

    expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByText('Recent Projects')).toBeInTheDocument();
    expect(screen.getByText('Demo Project')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Demo Project'));

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    if (!(event instanceof CustomEvent)) throw new Error('Expected a workspace toolbar event.');
    expect((event as CustomEvent<WorkspaceToolbarCommandDetail>).detail).toEqual({
      command: 'open-project',
      projectPath: '/projects/demo',
    });
    window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);
  });

  it('opens the generic wizard and auto-generates IDs until manually edited', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));

    const labelInput = screen.getByLabelText('Entity label');
    const idInput = screen.getByLabelText('Entity ID');
    await user.clear(labelInput);
    await user.type(labelInput, 'Entry Hall');
    expect(idInput).toHaveValue('entry-hall');

    await user.clear(idInput);
    await user.type(idInput, 'custom-id');
    await user.clear(labelInput);
    await user.type(labelInput, 'Changed Label');
    expect(idInput).toHaveValue('custom-id');
  });

  it('opens a collection-specific wizard from the explorer context menu', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    fireEvent.contextMenu(screen.getByRole('button', { name: /characters/i }));
    await user.click(screen.getByRole('button', { name: /create character/i }));

    expect(screen.getByText('Character setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create character/i })).toBeInTheDocument();
  });

  it('persists the hide-empty-categories explorer option from the menu', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    fireEvent.keyDown(screen.getByRole('button', { name: /project explorer menu/i }), {
      key: 'ArrowDown',
    });
    await user.click(await screen.findByText('Hide Empty Categories'));

    expect(useProjectStore.getState().document).toMatchObject({
      editor: { explorer: { hideEmptyCategories: true } },
    });
    expect(await screen.findByText('Empty Content')).toBeInTheDocument();
  });

  it('preserves search and tag filters when toggling explorer options', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    await user.type(screen.getByPlaceholderText('Search project'), 'needle');
    act(() => {
      useProjectExplorerStore.getState().setShowTagFilter(true);
      useProjectExplorerStore.getState().setFilterTags(['important']);
    });

    fireEvent.keyDown(screen.getByRole('button', { name: /project explorer menu/i }), {
      key: 'ArrowDown',
    });
    await user.click(await screen.findByText('Hide Empty Categories'));

    expect(screen.getByPlaceholderText('Search project')).toHaveValue('needle');
    expect(useProjectExplorerStore.getState()).toMatchObject({
      searchQuery: 'needle',
      showTagFilter: true,
      filterTags: ['important'],
      hideEmptyCategories: true,
    });
  });

  it('renders create command diagnostics for duplicate IDs', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    loadProject(project);
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Foyer');
    await user.click(screen.getByRole('button', { name: /create room/i }));

    expect(await screen.findByText('A record with this ID already exists.')).toBeInTheDocument();
  });

  it('creates typed Interactables and opens their editor tab', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));
    await user.click(screen.getByRole('button', { name: /^interactable/i }));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Silver Key');
    await user.click(screen.getByRole('button', { name: /create interactable/i }));

    const document = useProjectStore.getState().document as AuthoringProject;
    expect(document.interactables['silver-key']).toMatchObject({
      id: 'silver-key',
      label: 'Silver Key',
      data: { kind: 'interactable', initialState: { enabled: true, visible: true } },
    });
    expect(
      useWorkbenchStore.getState().tabsById['tab:interactable-detail:interactables:silver-key'],
    ).toMatchObject({
      editorType: 'interactable-detail',
      resource: { collection: 'interactables', entityId: 'silver-key' },
    });
  });

  it('creates an Interactable from only identity, Archetype, and sprite choices', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.properties.serial = {
      id: 'serial',
      label: 'Serial',
      type: 'string',
      nullable: false,
      ownerKinds: ['interactable'],
    };
    project.traits.tracked = {
      id: 'tracked',
      label: 'Tracked',
      ownerKinds: ['interactable'],
      properties: [{ kind: 'required', propertyId: 'serial' }],
    };
    project.archetypes['prop-template'] = {
      id: 'prop-template',
      label: 'Prop Template',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/traits': ['tracked'],
          '/properties/serial': 'template-serial',
          '/data/displayName': 'Template Prop',
          '/data/inventories': [{ id: 'pocket', label: 'Pocket' }],
          '/data/presentation/sprite': {
            $ref: { collection: 'assets', id: 'template-sprite' },
          },
          '/data/presentation/hotspots': {
            kind: 'custom',
            hotspots: [
              {
                ...defaultHotspotBehavior('Template Hotspot'),
                id: 'template-hotspot',
                shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
              },
            ],
          },
        },
      },
    };
    project.assets['template-sprite'] = {
      id: 'template-sprite',
      label: 'Template Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/template.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets['key-sprite'] = {
      id: 'key-sprite',
      label: 'Key Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/key.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    loadProject(project);
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));
    await user.click(screen.getByRole('button', { name: /^interactable/i }));

    expect(screen.queryByPlaceholderText('Add tag')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Entity color')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Optional description')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Interactable archetype' }));
    await user.click(screen.getByRole('button', { name: /Prop Template/ }));
    await user.click(screen.getByRole('button', { name: 'Interactable sprite' }));
    await user.click(screen.getByRole('button', { name: /Key Sprite/ }));

    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Silver Key');
    await user.click(screen.getByRole('button', { name: /create interactable/i }));

    const document = useProjectStore.getState().document as AuthoringProject;
    expect(document.interactables['silver-key']).toMatchObject({
      archetype: { $ref: { collection: 'archetypes', id: 'prop-template' } },
      data: {
        displayName: 'Template Prop',
        inventories: [{ id: 'pocket', label: 'Pocket' }],
        presentation: {
          sprite: { $ref: { collection: 'assets', id: 'key-sprite' } },
          hotspots: {
            kind: 'custom',
            hotspots: [expect.objectContaining({ id: 'template-hotspot' })],
          },
        },
      },
    });
    const created = document.interactables['silver-key']!;
    expect(created.archetypeOverrides).not.toHaveProperty('/traits');
    expect(created.archetypeOverrides).not.toHaveProperty('/properties/serial');
    expect(resolveGameplayInstanceRecord(document, 'interactable', created)).toMatchObject({
      traits: ['tracked'],
      properties: { serial: 'template-serial' },
    });

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));
    await user.click(screen.getByRole('button', { name: /^interactable/i }));
    await user.click(screen.getByRole('button', { name: 'Interactable archetype' }));
    await user.click(screen.getByRole('button', { name: /Prop Template/ }));
    expect(screen.getByRole('button', { name: 'Interactable sprite' })).toHaveTextContent(
      'From archetype',
    );
    const inheritedLabelInput = screen.getByLabelText('Entity label');
    await user.clear(inheritedLabelInput);
    await user.type(inheritedLabelInput, 'Brass Key');
    await user.click(screen.getByRole('button', { name: /create interactable/i }));

    const updatedDocument = useProjectStore.getState().document as AuthoringProject;
    const inherited = updatedDocument.interactables['brass-key']!;
    expect(inherited.archetypeOverrides).not.toHaveProperty('/data/presentation/sprite');
    expect(resolveGameplayInstanceRecord(updatedDocument, 'interactable', inherited)).toMatchObject(
      {
        data: {
          presentation: {
            sprite: { $ref: { collection: 'assets', id: 'template-sprite' } },
            hotspots: {
              kind: 'custom',
              hotspots: [expect.objectContaining({ id: 'template-hotspot' })],
            },
          },
        },
      },
    );
  });

  it('creates a room and can set it as the project entrypoint', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Entry Room');
    await user.click(screen.getByLabelText(/set as project entrypoint/i));
    await user.click(screen.getByRole('button', { name: /create room/i }));

    const document = useProjectStore.getState().document as AuthoringProject;
    expect(document.entrypoint).toEqual({ kind: 'room', id: 'entry-room' });
  });

  it('opens the wizard from the new-entity toolbar command used by Ctrl+N', async () => {
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));

    expect(await screen.findByText('New Entity Wizard')).toBeInTheDocument();
  });

  it('shows graph-only blockers and Force Delete in the delete dialog', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.rooms.target = {
      id: 'target',
      label: 'Target',
      data: defaultRoomData('Target'),
    };
    const layout = defaultLayoutData('HUD');
    layout.script.additionalDependencies = {
      targets: [{ kind: 'record', collection: 'rooms', id: 'target' }],
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    loadProject(project);
    const publication = useProjectStore.getState().lastMutationPublication;
    if (!publication) throw new Error('Expected a project mutation publication.');
    await authoringDependencyGraphService.publish(publication);

    render(<ProjectExplorer nodes={[]} />);
    await user.click(screen.getByRole('button', { name: /^rooms/i }));
    const target = screen.getByText('Target').closest('button');
    if (!target) throw new Error('Expected the target Room explorer button.');
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/lua-explicit-reference:/i)).toBeInTheDocument();
    const forceDelete = screen.getByLabelText(
      /force delete and let validation report missing references/i,
    );
    expect(forceDelete).toBeInTheDocument();
    expect(
      screen.getByText('Explicit Lua dependency fallback must be updated manually.'),
    ).toBeInTheDocument();
    await user.click(forceDelete);
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });
});
