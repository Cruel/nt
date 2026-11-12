import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  defaultCharacterData,
  parseCharacterData,
} from '../../shared/project-schema/authoring-characters';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: () => <div data-testid="character-derived-preview" />,
}));

const tab: WorkbenchTab = {
  id: 'tab:character-detail:characters:iris',
  title: 'Iris',
  editorType: 'character-detail',
  resource: {
    kind: 'record',
    stableId: 'record:characters:iris',
    collection: 'characters',
    entityId: 'iris',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('CharacterEditor', () => {
  it('shows a new initial Room selection before native acknowledgment and preserves independent toggles', async () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const native = admitNativeRendererCommandFixture(project);
    const held = holdFirstNativeProjectPatch();
    render(<CharacterEditor tab={tab} />);
    const location = within(screen.getByText('Location').parentElement!).getByRole('combobox');
    const user = userEvent.setup();
    await user.click(location);
    await user.click(screen.getByRole('option', { name: /Foyer \(foyer\)/u }));
    await waitFor(() => expect(held.isHeld()).toBe(true));
    const enabled = screen.getByRole('checkbox', { name: 'Enabled' });
    fireEvent.click(enabled);
    expect(location).toHaveTextContent('Foyer');
    expect(enabled).not.toBeChecked();
    expect(native.patch).not.toHaveBeenCalled();
    await act(async () => held.release());
    await waitFor(() => {
      const doc = useProjectStore.getState().document;
      expect(isAuthoringProject(doc)).toBe(true);
      if (!isAuthoringProject(doc)) return;
      const character = parseCharacterData(doc.characters.iris?.data);
      expect(character?.initialWorldState).toMatchObject({
        location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
        enabled: false,
      });
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
  });
  it('renders typed character defaults', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    admitNativeRendererCommandFixture(project);

    render(<CharacterEditor tab={tab} />);

    expect(screen.getByText('Iris')).toBeInTheDocument();
    expect(screen.getByText('Poses')).toBeInTheDocument();
    expect(screen.getByText('Expressions')).toBeInTheDocument();
    expect(screen.getByTestId('character-derived-preview')).toBeInTheDocument();
  });

  it('dispatches command-backed dialogue and pose updates', async () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    admitNativeRendererCommandFixture(project);

    render(<CharacterEditor tab={tab} />);

    const dialogueName = screen.getAllByDisplayValue('Iris')[1]!;
    fireEvent.change(dialogueName, { target: { value: 'Iris V.' } });

    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        characters: { iris: { data: { dialogue: { name: 'Iris V.' } } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.replaceAtPath');
    expect(useCommandStore.getState().history.entries.at(-1)?.patches).toMatchObject([
      { op: 'replace', path: '/characters/iris/data/dialogue/name', value: 'Iris V.' },
    ]);

    fireEvent.click(screen.getByText('Add Pose'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        characters: {
          iris: {
            data: {
              profiles: expect.arrayContaining([
                expect.objectContaining({
                  id: 'stage',
                  poses: expect.arrayContaining([expect.objectContaining({ id: 'pose' })]),
                }),
              ]),
            },
          },
        },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('character.replaceData');
  });

  it('selects a named Animation Visual while Gesture audio remains an Asset reference', async () => {
    const project = createAuthoringProject();
    project.assets.frame = {
      id: 'frame',
      label: 'Frame',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/frame.png' },
        aliases: [],
        imageMetadata: { width: 64, height: 96, hasAlpha: true, orientation: 1 },
      },
    };
    for (const id of ['first', 'second'])
      project.assets[id] = {
        id,
        label: id === 'first' ? 'First' : 'Second',
        data: {
          kind: 'audio',
          source: { type: 'project-file', path: `audio/${id}.ogg` },
          aliases: [],
          imageMetadata: null,
        },
      };
    project.animations.portrait = {
      id: 'portrait',
      label: 'Portrait',
      data: {
        kind: 'animation',
        canvas: { width: 64, height: 96 },
        defaultMotionId: 'idle',
        motions: [
          {
            id: 'idle',
            kind: 'sprite-sequence',
            markers: [],
            frames: [{ image: { $ref: { collection: 'assets', id: 'frame' } }, durationMs: 100 }],
          },
        ],
      },
    };
    const data = defaultCharacterData('Iris');
    data.profiles[0]!.animationClips = [
      { id: 'wave', label: 'Wave', clock: 'gameplay', frames: [{ durationMs: 100, layers: [] }] },
    ];
    data.gestures = [
      {
        id: 'wave',
        label: 'Wave',
        profiles: [
          {
            profileId: 'stage',
            clipId: 'wave',
            cues: [
              {
                kind: 'audio',
                id: 'sound',
                atMs: 0,
                asset: { $ref: { collection: 'assets', id: 'first' } },
                gain: 1,
                pan: 0,
              },
            ],
          },
        ],
      },
    ];
    project.characters.iris = { id: 'iris', label: 'Iris', data };
    admitNativeRendererCommandFixture(project);
    render(<CharacterEditor tab={tab} />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('combobox', { name: 'Character pose default layer body Visual' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Portrait · idle (animation:portrait:idle)' }),
    );
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        characters: {
          iris: {
            data: {
              profiles: [
                {
                  poses: [
                    {
                      layers: [
                        {
                          visual: {
                            kind: 'animation',
                            animation: { $ref: { collection: 'animations', id: 'portrait' } },
                            motionId: 'idle',
                            playback: null,
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
    );
    await user.click(
      screen.getByRole('combobox', { name: 'Character Gesture wave cue sound audio Asset' }),
    );
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        characters: {
          iris: {
            data: {
              gestures: [
                {
                  profiles: [
                    { cues: [{ asset: { $ref: { collection: 'assets', id: 'second' } } }] },
                  ],
                },
              ],
            },
          },
        },
      }),
    );
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('character.replaceData');
  });

  it('captures scroll tab state for the inspector', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    admitNativeRendererCommandFixture(project);

    const view = render(<CharacterEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>(
      '[data-character-editor-scroll]',
    )!;
    scrollContainer.scrollTop = 72;

    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.character',
      payload: {
        scroll: { scrollTop: 72, scrollLeft: 0 },
      },
    });
  });
});
