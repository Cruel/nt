import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';

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
  it('renders typed character defaults', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<CharacterEditor tab={tab} />);

    expect(screen.getByText('Iris')).toBeInTheDocument();
    expect(screen.getByText('Poses')).toBeInTheDocument();
    expect(screen.getByText('Expressions')).toBeInTheDocument();
    expect(screen.getByTestId('character-derived-preview')).toBeInTheDocument();
  });

  it('dispatches command-backed dialogue and pose updates', async () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<CharacterEditor tab={tab} />);

    const dialogueName = screen.getAllByDisplayValue('Iris')[1]!;
    fireEvent.change(dialogueName, { target: { value: 'Iris V.' } });

    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        characters: { iris: { data: { dialogue: { name: 'Iris V.' } } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('character.replaceData');

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
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<CharacterEditor tab={tab} />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('combobox', { name: 'Character pose default layer body Visual' }),
    );
    await user.click(
      screen.getByRole('option', { name: 'Portrait · idle (animation:portrait:idle)' }),
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
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

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
