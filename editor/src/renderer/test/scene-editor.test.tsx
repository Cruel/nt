import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { projectEdits } from '@/commands/project-editing';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import { useCommandStore } from '@/commands/command-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

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
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
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
  admitNativeRendererCommandFixture(project);
  return project;
}

describe('SceneEditor', () => {
  it('rebases sibling Event edits and reorder across a held native acknowledgment', async () => {
    const project = loadTimelineScene();
    const held = holdFirstNativeProjectPatch();
    const nativePatch = window.noveltea.nativeProjectPatch;
    render(<SceneEditor tab={tab} />);
    const label = screen.getByDisplayValue('Opening text');
    fireEvent.change(label, { target: { value: 'Fresh opening' } });
    expect(label).toHaveValue('Fresh opening');
    await waitFor(() => expect(held.isHeld()).toBe(true));

    fireEvent.click(screen.getByTitle('Overlapping note · 300–700 ms'));
    const secondLabel = screen.getByDisplayValue('Overlapping note');
    fireEvent.change(secondLabel, { target: { value: 'Fresh note' } });
    expect(secondLabel).toHaveValue('Fresh note');
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    await act(async () => held.release());
    await waitFor(() => {
      const events = (useProjectStore.getState().document as typeof project).scenes.opening!.data
        .events;
      expect(events.map((event) => event.id)).toEqual([
        'overlapping-note',
        'opening-text',
        'effect-hold',
      ]);
      expect(events.map((event) => event.label)).toEqual([
        'Fresh note',
        'Fresh opening',
        'Effect hold',
      ]);
    });
    expect(nativePatch).toHaveBeenCalled();
  });

  it('retains incomplete Scene timeline numbers and blocks active Save until completed', async () => {
    const project = loadTimelineScene();
    const native = admitNativeRendererCommandFixture(project);
    render(<SceneEditor tab={tab} />);
    const start = screen.getByLabelText('Start (ms)');
    fireEvent.change(start, { target: { value: '-' } });
    expect(start).toHaveValue('-');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:scenes:opening'],
    ).toHaveProperty('/scenes/opening/data/events/@opening-text/timeline/startMs');
    expect((await saveActiveSaveUnit('record:scenes:opening')).success).toBe(false);
    expect(
      (useProjectStore.getState().document as typeof project).scenes.opening!.data.events[0]!
        .timeline.startMs,
    ).toBe(100);

    fireEvent.change(start, { target: { value: '320' } });
    expect(start).toHaveValue('320');
    await act(async () => expect(await projectEdits.flush('record:scenes:opening')).toBe(true));
    expect(
      (useProjectStore.getState().document as typeof project).scenes.opening!.data.events[0]!
        .timeline.startMs,
    ).toBe(320);
    const saved = await saveActiveSaveUnit('record:scenes:opening');
    expect(saved.success).toBe(true);
    expect(native.save).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      'record:scenes:opening',
      expect.any(Object),
    );
  });

  it('stages an Event ID locally and renames only on blur, preserving raw invalid IDs', async () => {
    const project = loadTimelineScene();
    const native = admitNativeRendererCommandFixture(project);
    render(<SceneEditor tab={tab} />);
    const id = screen.getByLabelText('Event ID');
    fireEvent.change(id, { target: { value: 'invalid id' } });
    fireEvent.blur(id);
    expect(id).toHaveValue('invalid id');
    expect(native.patch).not.toHaveBeenCalled();
    expect((await saveActiveSaveUnit('record:scenes:opening')).success).toBe(false);
    fireEvent.change(id, { target: { value: 'opening-renamed' } });
    fireEvent.blur(id);
    await waitFor(() => {
      const events = (useProjectStore.getState().document as typeof project).scenes.opening!.data
        .events;
      expect(events[0]?.id).toBe('opening-renamed');
    });
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:scenes:opening'],
    ).toBeUndefined();
  });

  it('preserves and exposes a native-rejected semantic Event rename for retry', async () => {
    const project = loadTimelineScene();
    const native = admitNativeRendererCommandFixture(project);
    const actualPatch = window.noveltea.nativeProjectPatch;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(async () => ({
      accepted: false,
      error: 'Native rejected Scene identity',
      snapshot: {
        workingRevision: 0,
        diskSourceRevision: `sha256:${'0'.repeat(64)}`,
        source: project,
        normalized: project,
        dirtyPatches: [],
        dirty: false,
        valid: true,
        diagnostics: [],
        inventory: [],
        recordSnapshots: {},
      },
      affectedRecords: [],
      diagnosticsAdded: [],
      diagnosticsRemoved: [],
    }));
    render(<SceneEditor tab={tab} />);
    const id = screen.getByLabelText('Event ID');
    fireEvent.change(id, { target: { value: 'renamed' } });
    fireEvent.blur(id);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Native rejected Scene identity'),
    );
    expect(id).toHaveValue('renamed');
    expect(
      (useProjectStore.getState().document as typeof project).scenes.opening!.data.events[0]!.id,
    ).toBe('opening-text');
    expect((await saveActiveSaveUnit('record:scenes:opening')).success).toBe(false);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    fireEvent.focus(id);
    fireEvent.blur(id);
    await waitFor(() => {
      expect(
        (useProjectStore.getState().document as typeof project).scenes.opening!.data.events[0]!.id,
      ).toBe('renamed');
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(actualPatch).toBeTypeOf('function');
  });

  it.each([500, 1000])(
    'keeps Scene name and independent Event label visible during a %i ms native acknowledgment',
    async (delay) => {
      const project = loadTimelineScene();
      const held = holdFirstNativeProjectPatch();
      const view = render(<SceneEditor tab={tab} />);
      const name = screen.getByDisplayValue('Opening');
      fireEvent.change(name, { target: { value: 'Opening 1' } });
      expect(name).toHaveValue('Opening 1');
      await waitFor(() => expect(held.isHeld()).toBe(true));

      for (const text of ['Opening 12', 'Opening 123', 'Opening 12', 'Opening paste']) {
        fireEvent.change(name, { target: { value: text } });
        expect(name).toHaveValue(text);
      }
      (name as HTMLInputElement).setSelectionRange(3, 3);
      const label = screen.getByDisplayValue('Opening text');
      fireEvent.change(label, { target: { value: 'Updated scene event' } });
      expect(label).toHaveValue('Updated scene event');
      expect(
        (useProjectStore.getState().document as typeof project).scenes.opening!.data.displayName,
      ).toBe('Opening');
      await new Promise((resolve) => setTimeout(resolve, delay));
      expect(name).toHaveValue('Opening paste');
      expect(label).toHaveValue('Updated scene event');
      expect((name as HTMLInputElement).selectionStart).toBe(3);

      await act(async () => held.release());
      await waitFor(() => {
        const current = (useProjectStore.getState().document as typeof project).scenes.opening!
          .data;
        expect(current.displayName).toBe('Opening paste');
        expect(current.events.find((step) => step.id === 'opening-text')?.label).toBe(
          'Updated scene event',
        );
      });
      const nativePaths = vi
        .mocked(window.noveltea.nativeProjectPatch)
        .mock.calls.flatMap((call) => call[2].map((patch) => patch.path));
      expect(nativePaths).toContain('/scenes/opening/data/events/0/label');
      expect(nativePaths).not.toContain('/scenes/opening/data/events');
      expect(name).toHaveValue('Opening paste');
      expect(label).toHaveValue('Updated scene event');
      expect((name as HTMLInputElement).selectionStart).toBe(3);
      expect(vi.mocked(window.noveltea.nativeProjectPatch).mock.calls.length).toBeLessThanOrEqual(
        4,
      );
      view.unmount();
    },
    15000,
  );

  it('shares Scene draft values between views and retains a failed native edit until retry', async () => {
    const project = loadTimelineScene();
    const originalPatch = window.noveltea.nativeProjectPatch;
    const rejected = vi.fn(async (...args: Parameters<typeof originalPatch>) => {
      if (rejected.mock.calls.length === 1)
        return {
          accepted: false,
          error: 'Scene patch rejected',
          snapshot: {
            workingRevision: 0,
            diskSourceRevision: `sha256:${'0'.repeat(64)}`,
            source: project,
            normalized: project,
            dirty: false,
            valid: true,
            diagnostics: [],
            inventory: [],
          },
          affectedRecords: [],
          diagnosticsAdded: [],
          diagnosticsRemoved: [],
        };
      return originalPatch(...args);
    });
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: rejected,
    });
    render(<SceneEditor tab={tab} />);
    const name = screen.getByDisplayValue('Opening');
    fireEvent.change(name, { target: { value: 'Retry me' } });
    render(<SceneEditor tab={{ ...tab, id: 'scene-second-view' }} />);
    expect(screen.getAllByDisplayValue('Retry me')).toHaveLength(2);
    await waitFor(() =>
      expect(screen.getAllByText(/Scene patch rejected/u).length).toBeGreaterThan(0),
    );
    expect(
      (useProjectStore.getState().document as typeof project).scenes.opening!.data.displayName,
    ).toBe('Opening');
    fireEvent.click(screen.getAllByRole('button', { name: /retry/i })[0]!);
    await waitFor(() => {
      expect(
        (useProjectStore.getState().document as typeof project).scenes.opening!.data.displayName,
      ).toBe('Retry me');
    });
    expect(rejected).toHaveBeenCalledTimes(2);
  });
  it('renders strict scene data and keeps selection out of project data', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    admitNativeRendererCommandFixture(project);
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
      projectFilePath: '/mock/project.yaml',
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
