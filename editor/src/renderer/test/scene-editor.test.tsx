import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: ({
    previewDocument,
  }: {
    previewDocument: { kind: string; data: { selectedStepId?: string | null } };
  }) => (
    <div
      data-testid="scene-derived-preview"
      data-kind={previewDocument.kind}
      data-selected={previewDocument.data.selectedStepId ?? ''}
    />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:scene-detail:scenes:opening',
  title: 'Opening',
  editorType: 'scene-detail',
  resource: {
    kind: 'record',
    stableId: 'record:scenes:opening',
    collection: 'scenes',
    entityId: 'opening',
  },
};

beforeEach(() => {
  window.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

afterEach(() => {
  vi.useRealTimers();
});

function loadTimelineScene() {
  const project = createAuthoringProject();
  const data = defaultSceneData('Opening');
  const opening = defaultSceneStep('show-text', 'Opening text');
  opening.id = 'opening-text';
  opening.timeline = { trackId: 'dialogue', startMs: 100, durationMs: 500 };
  const overlap = defaultSceneStep('comment', 'Overlapping note');
  overlap.id = 'overlapping-note';
  overlap.timeline = { trackId: 'dialogue', startMs: 300, durationMs: 400 };
  const hold = defaultSceneStep('wait', 'Effect hold');
  hold.id = 'effect-hold';
  hold.timeline = { trackId: 'effects', startMs: 750, durationMs: 150 };
  data.events = [opening, overlap, hold];
  project.scenes.opening = { id: 'opening', label: 'Opening', data };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  return project;
}

describe('SceneEditor', () => {
  it('renders strict scene data and keeps selection out of project data', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<SceneEditor tab={tab} />);
    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute(
      'data-kind',
      'scene-preview',
    );
    fireEvent.change(screen.getByDisplayValue('Opening'), { target: { value: 'Opening Scene' } });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        scenes: { opening: { data: { displayName: 'Opening Scene' } } },
      }),
    );
    expect(
      (useProjectStore.getState().document as typeof project).scenes.opening!.data,
    ).not.toHaveProperty('preview');
  });

  it('uses the shared Gameplay Command editor for Scene mutation batches', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      localProperties: [
        { id: 'locked', label: 'Locked', type: 'boolean', nullable: false, value: true },
      ],
      data: defaultRoomData('Foyer'),
    };
    const data = defaultSceneData('Opening');
    const step = defaultSceneStep('gameplay-effect-batch');
    step.operations = [
      {
        id: 'set-locked',
        kind: 'set-property',
        owner: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
        propertyId: 'locked',
        value: false,
      },
    ];
    data.events = [step];
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<SceneEditor tab={tab} />);

    expect(screen.getByText('Atomic Gameplay Commands')).toBeInTheDocument();
    expect(screen.getByDisplayValue('set-locked')).toBeInTheDocument();
    expect(screen.getByDisplayValue('locked')).toBeInTheDocument();
  });

  it('renders authored timeline tracks and overlapping clips and selects clips directly', () => {
    loadTimelineScene();

    render(<SceneEditor tab={tab} />);

    expect(screen.getByTitle('dialogue')).toBeInTheDocument();
    expect(screen.getByTitle('effects')).toBeInTheDocument();
    const opening = screen.getByTitle('Opening text · 100–600 ms');
    const overlap = screen.getByTitle('Overlapping note · 300–700 ms');
    const hold = screen.getByTitle('Effect hold · 750–900 ms');
    expect(opening).toHaveStyle({ left: '10%', width: '50%' });
    expect(overlap).toHaveStyle({ left: '30%', width: '40%' });
    expect(hold).toHaveStyle({ left: '75%', width: '15%' });
    expect(
      Number.parseFloat(opening.style.left) + Number.parseFloat(opening.style.width),
    ).toBeGreaterThan(Number.parseFloat(overlap.style.left));

    fireEvent.click(overlap);

    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute(
      'data-selected',
      'overlapping-note',
    );
    expect(overlap).toHaveClass('bg-accent');
    expect(screen.getByRole('slider')).toHaveValue('300');
    expect(screen.getByText('0.30s / 1.00s')).toBeInTheDocument();
  });

  it('scrubs deterministically, updates active preview selection, and keeps playback state transient', () => {
    const project = loadTimelineScene();
    const authoredSceneBeforePlayback = structuredClone(project.scenes.opening!.data);

    render(<SceneEditor tab={tab} />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '150' } });
    expect(slider).toHaveValue('150');
    expect(screen.getByText('0.15s / 1.00s')).toBeInTheDocument();
    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute(
      'data-selected',
      'opening-text',
    );

    fireEvent.change(slider, { target: { value: '500' } });
    expect(slider).toHaveValue('500');
    expect(screen.getByText('0.50s / 1.00s')).toBeInTheDocument();
    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute(
      'data-selected',
      'overlapping-note',
    );

    expect((useProjectStore.getState().document as typeof project).scenes.opening!.data).toEqual(
      authoredSceneBeforePlayback,
    );
  });

  it('plays, pauses, and resets the timeline using controlled time without authoring mutations', () => {
    vi.useFakeTimers();
    const project = loadTimelineScene();
    const authoredSceneBeforePlayback = structuredClone(project.scenes.opening!.data);

    render(<SceneEditor tab={tab} />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(slider).toHaveValue('300');
    expect(screen.getByText('0.30s / 1.00s')).toBeInTheDocument();
    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute(
      'data-selected',
      'overlapping-note',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(slider).toHaveValue('300');
    expect(screen.getByText('0.30s / 1.00s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(slider).toHaveValue('0');
    expect(screen.getByText('0.00s / 1.00s')).toBeInTheDocument();
    expect((useProjectStore.getState().document as typeof project).scenes.opening!.data).toEqual(
      authoredSceneBeforePlayback,
    );
  });
});
