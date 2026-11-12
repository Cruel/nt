import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ProjectFieldInput,
  ProjectFieldNumber,
  ProjectFieldSwitch,
  ProjectFieldTextarea,
} from '@/commands/use-project-field';
import { projectEdits } from '@/commands/project-editing';
import {
  discardNativeField,
  flushNativeField,
  flushNativeFields,
  nativeFieldDraftKey,
  nativeFieldKey,
  useNativeFieldDraftStore,
} from '@/commands/native-field-drafts';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { saveProjectAsCopy } from '@/project/project-save-coordinator';
import { PROJECT_SETTINGS_SAVE_UNIT_ID } from '@/project/save-unit-registry';
import { serializeDraftDirtyState, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

function NameField({ tabId = 'project:1' }: { tabId?: string }) {
  const document = useProjectStore((state) => state.document);
  return (
    <ProjectFieldInput
      aria-label={`Project title ${tabId}`}
      tabId={tabId}
      path="/project/name"
      saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
      label="Edit Project title"
      value={isAuthoringProjectView(document) ? document.project.name : ''}
    />
  );
}

function AuthorField() {
  const document = useProjectStore((state) => state.document);
  return (
    <ProjectFieldInput
      aria-label="Project author"
      tabId="project:1"
      path="/project/author"
      saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
      label="Edit Project author"
      value={isAuthoringProjectView(document) ? document.project.author : ''}
    />
  );
}

/** Reads authoritative values so the two mounted controls observe acknowledgments. */
function BuildNumberField({ tabId }: { tabId: string }) {
  const document = useProjectStore((state) => state.document);
  return (
    <ProjectFieldNumber
      aria-label={`Build number ${tabId}`}
      tabId={tabId}
      saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
      path="/settings/app/buildNumber"
      value={isAuthoringProjectView(document) ? (document.settings.app?.buildNumber ?? null) : null}
      label="Edit build number"
      mode="decimal"
    />
  );
}

function admitProject(name = 'Original') {
  const project = createAuthoringProject();
  project.project.name = name;
  return admitNativeRendererCommandFixture(project);
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
});

describe('shared buffered native field intents', () => {
  it('does not let dependent commands or Undo pass an unresolved raw numeric input', async () => {
    const native = admitProject();
    usePendingInputStore
      .getState()
      .setPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, '/settings/app/buildNumber', { value: '-' });
    const result = await projectEdits.execute({
      type: 'project.replaceAtPath',
      label: 'Change title while numeric input is invalid',
      payload: { path: '/project/name', value: 'Unsafe' },
      originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
      persistencePolicy: 'manual-save',
    });
    expect(result.ok).toBe(false);
    expect((await projectEdits.undo()).ok).toBe(false);
    expect(native.patch).not.toHaveBeenCalled();
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
  });
  it('plans a late-bound atomic transaction after the previous native acknowledgment', async () => {
    const native = admitProject();
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        }),
    );
    const first = projectEdits.execute({
      type: 'project.replaceAtPath',
      label: 'Update title',
      payload: { path: '/project/name', value: 'First' },
      originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
      persistencePolicy: 'manual-save',
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    let planned = 0;
    const batch = projectEdits.batch(
      {
        label: 'Update two settings',
        originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        persistencePolicy: 'manual-save',
      },
      () => {
        planned++;
        const project = useProjectStore.getState().document;
        if (!isAuthoringProjectView(project) || project.project.name !== 'First')
          throw new Error('Planner observed stale Project.');
        return [
          {
            type: 'project.replaceAtPath',
            label: 'Change author',
            payload: { path: '/project/author', value: 'New Author' },
            originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
            persistencePolicy: 'manual-save',
          },
          {
            type: 'project.replaceAtPath',
            label: 'Change version',
            payload: { path: '/project/version', value: '2.1' },
            originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
            persistencePolicy: 'manual-save',
          },
        ];
      },
    );
    expect(planned).toBe(0);
    await act(async () => release!());
    await act(async () => expect((await first).ok).toBe(true));
    await act(async () => expect((await batch).ok).toBe(true));
    expect(planned).toBe(1);
    // The first delayed mock delegates through the same spy, so there are
    // two wrapper calls for the first mutation and one atomic batch call.
    expect(native.patch).toHaveBeenCalledTimes(3);
    expect(native.patch.mock.calls.at(-1)?.[2]).toHaveLength(2);
    expect(useCommandStore.getState().history.entries).toHaveLength(2);
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'First', author: 'New Author', version: '2.1' },
    });
  });

  it('rejects a late-bound transaction as a whole when a later step is invalid', async () => {
    const native = admitProject();
    const result = await projectEdits.batch(
      {
        label: 'Invalid atomic update',
        originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        persistencePolicy: 'manual-save',
      },
      () => [
        {
          type: 'project.replaceAtPath',
          label: 'Valid intermediate change',
          payload: { path: '/project/name', value: 'Should not be published' },
          originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
          persistencePolicy: 'manual-save',
        },
        {
          type: 'project.replaceAtPath',
          label: 'Invalid second step',
          payload: { path: '/project/does-not-exist', value: 'Rejected' },
          originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
          persistencePolicy: 'manual-save',
        },
      ],
    );
    expect(result.ok).toBe(false);
    expect(native.patch).not.toHaveBeenCalled();
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
  });

  it('resolves an ID-based Character expression edit after a queued list insertion and reorder', async () => {
    const project = createAuthoringProject();
    const data = defaultCharacterData('Iris');
    project.characters.iris = { id: 'iris', label: 'Iris', data };
    admitNativeRendererCommandFixture(project);
    const record = { collection: 'characters' as const, id: 'iris' };
    const expression = data.expressions[0]!;
    const pending = projectEdits.recordList({
      record,
      field: '/expressions',
      action: {
        kind: 'replace',
        id: expression.id,
        before: expression,
        after: { ...expression, label: 'Updated after reorder' },
      },
      label: 'Rename expression',
    });
    const inserted = await projectEdits.execute(
      projectEdits.recordList({
        record,
        field: '/expressions',
        action: {
          kind: 'insert',
          item: { id: 'second', label: 'Second', profiles: [] },
          beforeId: expression.id,
        },
        label: 'Add expression',
      }),
    );
    expect(inserted.ok).toBe(true);
    const reordered = await projectEdits.execute(
      projectEdits.recordList({
        record,
        field: '/expressions',
        action: { kind: 'move', id: expression.id, beforeId: 'second' },
        label: 'Reorder expressions',
      }),
    );
    expect(reordered.ok).toBe(true);
    expect((await projectEdits.execute(pending)).ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      characters: {
        iris: {
          data: {
            expressions: [
              expect.objectContaining({ id: expression.id, label: 'Updated after reorder' }),
              expect.objectContaining({ id: 'second' }),
            ],
          },
        },
      },
    });
  });

  it('groups two native acknowledgments from one focused typing session into one Undo step', async () => {
    const native = admitProject();
    render(<NameField />);
    const input = screen.getByRole('textbox', { name: 'Project title project:1' });
    const project = useProjectStore.getState();
    const fieldKey = nativeFieldKey(
      project.projectSessionId!,
      project.projectInstanceId!,
      '/project/name',
    );
    fireEvent.change(input, { target: { value: 'First' } });
    await act(async () => expect(await flushNativeField(fieldKey)).toBe(true));
    fireEvent.change(input, { target: { value: 'Second' } });
    await act(async () => expect(await flushNativeField(fieldKey)).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    await act(async () => expect((await projectEdits.undo()).ok).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
    await act(async () => expect((await projectEdits.redo()).ok).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Second' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: 'Third' } });
    await act(async () => expect(await flushNativeField(fieldKey)).toBe(true));
    expect(useCommandStore.getState().history.entries).toHaveLength(2);
  });

  it('rejects an incorrect Save owner before exposing a field overlay or recoverable draft', () => {
    admitProject();
    expect(() =>
      projectEdits.field({
        tabId: 'second-view',
        saveUnitId: 'record:rooms:foyer',
        path: '/project/name',
        label: 'Wrong owner',
        value: 'Must not stage',
      }),
    ).toThrow(/does not belong/u);
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(0);
    expect(Object.keys(useDraftDirtyStore.getState().entriesByKey)).toHaveLength(0);
  });

  it('uses distinct generations for numeric edits separated by a native acknowledgment', async () => {
    admitProject();
    render(
      <>
        <BuildNumberField tabId="A" />
        <BuildNumberField tabId="B" />
      </>,
    );
    const first = screen.getByRole('textbox', { name: 'Build number A' });
    const second = screen.getByRole('textbox', { name: 'Build number B' });
    const project = useProjectStore.getState();
    const fieldKey = nativeFieldKey(
      project.projectSessionId!,
      project.projectInstanceId!,
      '/settings/app/buildNumber',
    );
    fireEvent.change(first, { target: { value: '1.0' } });
    const firstGeneration = useNativeFieldDraftStore.getState().entries[fieldKey]?.sequence;
    expect(firstGeneration).toBeDefined();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useNativeFieldDraftStore.getState().entries[fieldKey]).toBeUndefined();
    expect(first).toHaveValue('1.0');
    fireEvent.change(second, { target: { value: '23' } });
    const secondGeneration = useNativeFieldDraftStore.getState().entries[fieldKey]?.sequence;
    expect(secondGeneration).toBeGreaterThan(firstGeneration!);
    expect(first).toHaveValue('23');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(first).toHaveValue('23');
  });

  it('never revives superseded numeric presentation when a later acknowledged value matches', async () => {
    admitProject();
    render(
      <>
        <BuildNumberField tabId="A" />
        <BuildNumberField tabId="B" />
      </>,
    );
    const first = screen.getByRole('textbox', { name: 'Build number A' });
    const second = screen.getByRole('textbox', { name: 'Build number B' });
    fireEvent.change(first, { target: { value: '1.0' } });
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(first).toHaveValue('1.0');
    fireEvent.change(second, { target: { value: '23' } });
    expect(first).toHaveValue('23');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    fireEvent.change(second, { target: { value: '1' } });
    expect(first).toHaveValue('1');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    // Matching A's old parsed value is not evidence of editing ownership.
    expect(first).toHaveValue('1');
  });

  it('does not reuse numeric presentation across Project instances with the same field value', async () => {
    const firstProject = createAuthoringProject();
    firstProject.settings.app!.buildNumber = 1;
    admitNativeRendererCommandFixture(firstProject);
    render(<BuildNumberField tabId="A" />);
    const input = screen.getByRole('textbox', { name: 'Build number A' });
    fireEvent.change(input, { target: { value: '1.0' } });
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(input).toHaveValue('1.0');
    const previousInstance = useProjectStore.getState().projectInstanceId;
    act(() => useProjectStore.getState().clearProject());
    const secondProject = createAuthoringProject();
    secondProject.settings.app!.buildNumber = 1;
    act(() => {
      admitNativeRendererCommandFixture(secondProject);
    });
    expect(useProjectStore.getState().projectInstanceId).not.toBe(previousInstance);
    expect(input).toHaveValue('1');
  });
  it('reconciles a blurred invalid number when another view repairs the shared field', async () => {
    admitProject();
    render(
      <>
        <ProjectFieldNumber
          aria-label="Numeric A"
          tabId="A"
          path="/settings/app/buildNumber"
          saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
          label="Build"
          value={12}
        />
        <ProjectFieldNumber
          aria-label="Numeric B"
          tabId="B"
          path="/settings/app/buildNumber"
          saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
          label="Build"
          value={12}
        />
      </>,
    );
    const a = screen.getByRole('textbox', { name: 'Numeric A' });
    const b = screen.getByRole('textbox', { name: 'Numeric B' });
    fireEvent.change(a, { target: { value: '-' } });
    fireEvent.blur(a);
    expect(a).toHaveValue('-');
    fireEvent.change(b, { target: { value: '23' } });
    expect(a).toHaveValue('23');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
    ).toBeUndefined();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { buildNumber: 23 } },
    });
  });

  it('supersedes an active numeric presentation when another view submits a newer generation', async () => {
    admitProject();
    render(
      <>
        <ProjectFieldNumber
          aria-label="Decimal A"
          tabId="A"
          path="/settings/app/buildNumber"
          saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
          label="Build"
          value={12}
          mode="decimal"
        />
        <ProjectFieldNumber
          aria-label="Decimal B"
          tabId="B"
          path="/settings/app/buildNumber"
          saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
          label="Build"
          value={12}
          mode="decimal"
        />
      </>,
    );
    const a = screen.getByRole('textbox', { name: 'Decimal A' });
    const b = screen.getByRole('textbox', { name: 'Decimal B' });
    fireEvent.change(a, { target: { value: '1.0' } });
    expect(a).toHaveValue('1.0');
    fireEvent.change(b, { target: { value: '23' } });
    expect(a).toHaveValue('23');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { buildNumber: 23 } },
    });
  });

  it('restores a conflicted field with its original baseline and resolves Use current', async () => {
    admitProject();
    const view = render(<NameField />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Local' } });
    const saved = serializeDraftDirtyState(useDraftDirtyStore.getState());
    const draft = saved[nativeFieldDraftKey(PROJECT_SETTINGS_SAVE_UNIT_ID, '/project/name')];
    expect(draft?.payload).toMatchObject({
      value: 'Local',
      base: { exists: true, value: 'Original' },
    });
    view.unmount();
    useProjectStore.getState().clearProject();
    useDraftDirtyStore.getState().resetDraftDirty();
    useCommandStore.getState().resetCommandHistory();
    admitProject('External');
    useDraftDirtyStore.getState().restoreSerializedDrafts(saved);
    render(<NameField tabId="restored" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use current' })).toBeVisible());
    expect(await projectEdits.flush()).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title restored' }), {
      target: { value: 'External' },
    });
    // Matching the acknowledged text must not silently resolve a conflict.
    expect(await projectEdits.flush()).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use current' })));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Project title restored' })).toHaveValue(
        'External',
      ),
    );
    expect(
      useDraftDirtyStore.getState().entriesByKey[
        nativeFieldDraftKey(PROJECT_SETTINGS_SAVE_UNIT_ID, '/project/name')
      ],
    ).toBeUndefined();
    expect(await projectEdits.flush()).toBe(true);
  });

  it('rehydrates an unchanged field baseline without a spurious conflict', async () => {
    admitProject();
    const view = render(<NameField />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Recovered value' } });
    const saved = serializeDraftDirtyState(useDraftDirtyStore.getState());
    view.unmount();
    useProjectStore.getState().clearProject();
    useDraftDirtyStore.getState().resetDraftDirty();
    useCommandStore.getState().resetCommandHistory();
    const native = admitProject();
    useDraftDirtyStore.getState().restoreSerializedDrafts(saved);
    render(<NameField tabId="restored" />);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Project title restored' })).toHaveValue(
        'Recovered value',
      ),
    );
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'Recovered value' },
    });
  });

  it('requires explicit Keep mine and uses the new acknowledged baseline after restart', async () => {
    admitProject();
    const view = render(<NameField />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Local' } });
    const saved = serializeDraftDirtyState(useDraftDirtyStore.getState());
    view.unmount();
    useProjectStore.getState().clearProject();
    useDraftDirtyStore.getState().resetDraftDirty();
    useCommandStore.getState().resetCommandHistory();
    const native = admitProject('External');
    useDraftDirtyStore.getState().restoreSerializedDrafts(saved);
    render(<NameField tabId="restored" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep mine' })).toBeVisible());
    const input = screen.getByRole('textbox', { name: 'Project title restored' });
    fireEvent.change(input, { target: { value: 'Local again' } });
    await act(async () => expect(await projectEdits.flush()).toBe(false));
    expect(native.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(input).toHaveValue('Local again'));
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Local again' } });
  });
  it('preserves an overlapping external field change as a recoverable conflict instead of overwriting it', async () => {
    const native = admitProject();
    render(<NameField />);
    const input = screen.getByRole('textbox', { name: 'Project title project:1' });
    fireEvent.change(input, { target: { value: 'My unsent title' } });
    const state = useProjectStore.getState();
    const document = state.document;
    if (!isAuthoringProjectView(document)) throw new Error('Missing native Project fixture');
    const external = structuredClone(document);
    external.project.name = 'External title';
    act(() =>
      useProjectStore.setState({
        document: external,
        projectRevision: state.projectRevision + 1,
      }),
    );
    expect(input).toHaveValue('My unsent title');
    await act(async () => expect(await projectEdits.flush()).toBe(false));
    expect(native.patch).not.toHaveBeenCalled();
    expect(input).toHaveValue('My unsent title');
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'External title' },
    });
  });
  it('keeps nullable field clears visible and recoverable, including after remount', async () => {
    const project = createAuthoringProject();
    project.settings.app!.buildNumber = 12;
    admitNativeRendererCommandFixture(project);
    const view = render(
      <ProjectFieldNumber
        aria-label="Nullable number"
        tabId="project:1"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        path="/settings/app/buildNumber"
        value={12}
        label="Clear build number"
        optional
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Nullable number' }), {
      target: { value: '' },
    });
    expect(screen.getByRole('textbox', { name: 'Nullable number' })).toHaveValue('');
    expect(
      useDraftDirtyStore.getState().entriesByKey[
        nativeFieldDraftKey(PROJECT_SETTINGS_SAVE_UNIT_ID, '/settings/app/buildNumber')
      ]?.payload,
    ).toMatchObject({ value: null, base: { exists: true, value: 12 } });
    view.unmount();
    render(
      <ProjectFieldNumber
        aria-label="Restored nullable number"
        tabId="project:1"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        path="/settings/app/buildNumber"
        value={12}
        label="Clear build number"
        optional
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Restored nullable number' })).toHaveValue('');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { buildNumber: null } },
    });
  });

  it('preserves raw complete numeric text until blur, including decimal and signed values', async () => {
    admitProject();
    render(
      <ProjectFieldNumber
        aria-label="Decimal"
        tabId="project:1"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        path="/settings/app/buildNumber"
        value={12}
        label="Decimal"
        mode="decimal"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Decimal' });
    for (const raw of ['1.0', '1.05', '+1.05', '01.05']) {
      fireEvent.change(input, { target: { value: raw } });
      expect(input).toHaveValue(raw);
    }
    fireEvent.blur(input);
    expect(input).toHaveValue('1.05');
    await act(async () => expect(await projectEdits.flush()).toBe(true));
  });

  it('replaces a queued field value before native dispatch instead of recording obsolete history', async () => {
    const native = admitProject();
    const realPatch = window.noveltea.nativeProjectPatch;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof realPatch>) => {
        if (!first) return realPatch(...args);
        first = false;
        started();
        return new Promise<Awaited<ReturnType<typeof realPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(realPatch(...args)).then(resolve, reject);
        });
      }),
    });
    expect(
      projectEdits.field({
        tabId: 'project:1',
        saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        path: '/project/name',
        value: 'Blocker',
        label: 'Title',
      }),
    ).toBe(true);
    const firstFlush = projectEdits.flushField('/project/name');
    await ready;
    expect(
      projectEdits.field({
        tabId: 'project:1',
        saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        path: '/project/author',
        value: 'Old queued author',
        label: 'Author',
      }),
    ).toBe(true);
    const secondFlush = projectEdits.flushField('/project/author');
    expect(
      projectEdits.field({
        tabId: 'project:1',
        saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        path: '/project/author',
        value: 'Newest author',
        label: 'Author',
      }),
    ).toBe(true);
    await act(async () => {
      release();
      await Promise.all([firstFlush, secondFlush]);
    });
    expect(
      native.patch.mock.calls.flatMap(([, , patches]) =>
        patches.filter((patch) => patch.path === '/project/author'),
      ),
    ).toEqual([{ op: 'replace', path: '/project/author', value: 'Newest author' }]);
    expect(useProjectStore.getState().document).toMatchObject({
      project: { author: 'Newest author' },
    });
  });

  it('does not erase newer typing arriving while a queued discard awaits the worker', async () => {
    const native = admitProject();
    const realPatch = window.noveltea.nativeProjectPatch;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof realPatch>) => {
        if (!first) return realPatch(...args);
        first = false;
        started();
        return new Promise<Awaited<ReturnType<typeof realPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(realPatch(...args)).then(resolve, reject);
        });
      }),
    });
    const edit = (path: string, value: string) =>
      projectEdits.field({
        tabId: 'project:1',
        saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        path,
        value,
        label: 'Queued edit',
      });
    edit('/project/name', 'Busy');
    const firstFlush = projectEdits.flushField('/project/name');
    await ready;
    edit('/project/author', 'To discard');
    const queued = projectEdits.flushField('/project/author');
    const project = useProjectStore.getState();
    const key = nativeFieldKey(
      project.projectSessionId!,
      project.projectInstanceId!,
      '/project/author',
    );
    const discard = discardNativeField(key);
    edit('/project/author', 'Typed during discard');
    await act(async () => {
      release();
      expect(await discard).toBe(false);
      await Promise.all([firstFlush, queued]);
      expect(await projectEdits.flush()).toBe(true);
    });
    expect(
      native.patch.mock.calls.flatMap(([, , patches]) =>
        patches.filter((patch) => patch.path === '/project/author'),
      ),
    ).toEqual([{ op: 'replace', path: '/project/author', value: 'Typed during discard' }]);
    expect(useProjectStore.getState().document).toMatchObject({
      project: { author: 'Typed during discard' },
    });
  });

  it('rejects unsafe discard while native dispatch is in flight without dropping the overlay', async () => {
    admitProject();
    const realPatch = window.noveltea.nativeProjectPatch;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof realPatch>) => {
        started();
        return new Promise<Awaited<ReturnType<typeof realPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(realPatch(...args)).then(resolve, reject);
        });
      }),
    });
    projectEdits.field({
      tabId: 'project:1',
      saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
      path: '/project/name',
      value: 'Pending',
      label: 'Name',
    });
    const flush = projectEdits.flush();
    await ready;
    const session = useProjectStore.getState();
    const fieldKey = nativeFieldKey(
      session.projectSessionId!,
      session.projectInstanceId!,
      '/project/name',
    );
    expect(await discardNativeField(fieldKey)).toBe(false);
    expect(useNativeFieldDraftStore.getState().entries[fieldKey]?.value).toBe('Pending');
    await act(async () => {
      release();
      await flush;
    });
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Pending' } });
  });
  it('adds an optional nested Project setting against the current native Project', async () => {
    const native = admitProject();
    render(
      <ProjectFieldInput
        aria-label="Apple bundle ID"
        tabId="project:1"
        path="/settings/app/desktop/appleBundleId"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update Apple bundle ID"
        value=""
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Apple bundle ID' }), {
      target: { value: 'com.example.game' },
    });
    await act(async () =>
      expect(await projectEdits.flush(PROJECT_SETTINGS_SAVE_UNIT_ID)).toBe(true),
    );
    expect(native.patch.mock.calls.at(-1)?.[2]).toContainEqual({
      op: 'add',
      path: '/settings/app/desktop/appleBundleId',
      value: 'com.example.game',
    });
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { desktop: { appleBundleId: 'com.example.game' } } },
    });
  });

  it('keeps raw textarea input responsive and stages exact final text', async () => {
    const native = admitProject();
    render(
      <ProjectFieldTextarea
        aria-label="Project description"
        tabId="project:1"
        path="/project/description"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update project description"
        value=""
      />,
    );
    const textarea = screen.getByRole('textbox', { name: 'Project description' });
    fireEvent.change(textarea, { target: { value: 'Line one\nLine two' } });
    expect(textarea).toHaveValue('Line one\nLine two');
    expect(native.patch).not.toHaveBeenCalled();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      project: { description: 'Line one\nLine two' },
    });
  });

  it('preserves incomplete numeric text and commits only completed values', async () => {
    const native = admitProject();
    render(
      <ProjectFieldNumber
        aria-label="Build number"
        type="number"
        min={1}
        tabId="project:1"
        path="/settings/app/buildNumber"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update build number"
        value={null}
        optional
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Build number' });
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.change(input, { target: { value: '-' } });
    expect(input).toHaveValue('-');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
    ).toHaveProperty('/settings/app/buildNumber');
    expect(native.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    expect(input).toHaveValue('0');
    expect(native.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '12' } });
    expect(input).toHaveValue('12');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
    ).toBeUndefined();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { buildNumber: 12 } },
    });
  });

  it('uses semantic Project commands to create a missing title screen container', async () => {
    const native = admitProject();
    render(
      <ProjectFieldSwitch
        aria-label="Show author name"
        tabId="project:1"
        path="/settings/titleScreen/showAuthor"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Show author name"
        value={false}
        buildCommand={(next) => ({
          type: 'project.setTitleScreen',
          payload: { showAuthor: next },
          label: 'Show author name',
          originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
          persistencePolicy: 'manual-save',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Show author name' }));
    expect(screen.getByRole('switch', { name: 'Show author name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { titleScreen: { showAuthor: true } },
    });
  });

  it('rebases an explicit event-time whole-Room delta after an earlier buffered field edit', async () => {
    const project = createAuthoringProject();
    const initial = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: initial };
    admitNativeRendererCommandFixture(project);

    expect(
      projectEdits.field({
        tabId: 'room:foyer',
        path: '/rooms/foyer/data/displayName',
        saveUnitId: 'record:rooms:foyer',
        value: 'Latest display name',
        label: 'Change Room display name',
      }),
    ).toBe(true);

    const plan = projectEdits.recordData({
      record: { collection: 'rooms', id: 'foyer' },
      before: initial,
      after: { ...initial, description: inlineTextContent('An updated room') },
      label: 'Update Room description',
    });
    const result = await projectEdits.execute(plan!);

    expect(result.ok).toBe(true);
    const acknowledged = useProjectStore.getState().document;
    expect(isAuthoringProjectView(acknowledged)).toBe(true);
    if (isAuthoringProjectView(acknowledged)) {
      const current = parseRoomData(acknowledged.rooms.foyer?.data);
      expect(current).toMatchObject({
        displayName: 'Latest display name',
        description: { source: { kind: 'inline', text: 'An updated room' } },
      });
    }
  });
  it('preserves a pending Room field when a placement is renamed from an older render', async () => {
    const project = createAuthoringProject();
    const initial = defaultRoomData('Foyer');
    const placement = {
      id: 'desk',
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
    };
    initial.placements = [placement];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: initial };
    admitNativeRendererCommandFixture(project);
    projectEdits.field({
      tabId: 'room:foyer',
      path: '/rooms/foyer/data/displayName',
      saveUnitId: 'record:rooms:foyer',
      value: 'Latest display name',
      label: 'Rename Room',
    });
    const plan = projectEdits.recordData({
      record: { collection: 'rooms', id: 'foyer' },
      before: initial,
      after: { ...initial, placements: [{ ...placement, id: 'writing-desk' }] },
      label: 'Rename Room placement',
    });
    const result = await projectEdits.execute(plan!);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const acknowledged = useProjectStore.getState().document;
    expect(isAuthoringProjectView(acknowledged)).toBe(true);
    if (isAuthoringProjectView(acknowledged))
      expect(parseRoomData(acknowledged.rooms.foyer?.data)).toMatchObject({
        displayName: 'Latest display name',
        placements: [expect.objectContaining({ id: 'writing-desk' })],
      });
  });
  it('preserves pending destination Room fields when inserting and correcting a reciprocal exit', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.rooms.kitchen = { id: 'kitchen', label: 'Kitchen', data: defaultRoomData('Kitchen') };
    admitNativeRendererCommandFixture(project);
    const record = { collection: 'rooms' as const, id: 'kitchen' };
    const exit = {
      id: 'return-exit',
      label: 'To foyer',
      direction: 'north' as const,
      target: { $ref: { collection: 'rooms' as const, id: 'foyer' } },
      condition: { kind: 'always' as const },
      onRejected: [],
      transition: null,
    };
    projectEdits.field({
      tabId: 'room:kitchen',
      path: '/rooms/kitchen/data/displayName',
      saveUnitId: 'record:rooms:kitchen',
      value: 'Latest kitchen name',
      label: 'Rename Kitchen',
    });
    expect(
      (
        await projectEdits.execute(
          projectEdits.recordList({
            record,
            field: '/exits',
            action: { kind: 'insert', item: exit },
            label: 'Add reciprocal exit',
          }),
        )
      ).ok,
    ).toBe(true);
    const latest = useProjectStore.getState().document;
    expect(isAuthoringProjectView(latest)).toBe(true);
    if (!isAuthoringProjectView(latest)) return;
    const before = parseRoomData(latest.rooms.kitchen?.data)?.exits[0];
    expect(before).toBeDefined();
    projectEdits.field({
      tabId: 'room:kitchen',
      path: '/rooms/kitchen/data/displayName',
      saveUnitId: 'record:rooms:kitchen',
      value: 'Newest kitchen name',
      label: 'Rename Kitchen again',
    });
    expect(
      (
        await projectEdits.execute(
          projectEdits.recordList({
            record,
            field: '/exits',
            action: {
              kind: 'replace',
              id: 'return-exit',
              before: before!,
              after: { ...before!, direction: 'south' },
            },
            label: 'Correct reciprocal exit',
          }),
        )
      ).ok,
    ).toBe(true);
    const acknowledged = useProjectStore.getState().document;
    if (isAuthoringProjectView(acknowledged))
      expect(parseRoomData(acknowledged.rooms.kitchen?.data)).toMatchObject({
        displayName: 'Newest kitchen name',
        exits: [expect.objectContaining({ id: 'return-exit', direction: 'south' })],
      });
  });
  it('rejects an overlapping event-time record delta instead of silently replacing a newer field', async () => {
    const project = createAuthoringProject();
    const initial = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: initial };
    admitNativeRendererCommandFixture(project);
    projectEdits.field({
      tabId: 'room:foyer',
      path: '/rooms/foyer/data/displayName',
      saveUnitId: 'record:rooms:foyer',
      value: 'Newly acknowledged',
      label: 'Rename Room',
    });
    const plan = projectEdits.recordData({
      record: { collection: 'rooms', id: 'foyer' },
      before: initial,
      after: { ...initial, displayName: 'Stale rename' },
      label: 'Stale composite edit',
    });
    expect((await projectEdits.execute(plan!)).ok).toBe(false);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { displayName: 'Newly acknowledged' } } },
    });
  });
  it('keeps independent fields and newest typing visible across a blocked native acknowledgment', async () => {
    const native = admitProject();
    const realPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof realPatch>) => {
        if (!first) return realPatch(...args);
        first = false;
        return new Promise<Awaited<ReturnType<typeof realPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(realPatch(...args)).then(resolve, reject);
        });
      }),
    });
    render(
      <>
        <NameField />
        <AuthorField />
      </>,
    );
    const title = screen.getByRole('textbox', { name: 'Project title project:1' });
    const author = screen.getByRole('textbox', { name: 'Project author' });
    fireEvent.change(title, { target: { value: 'One' } });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    for (const input of ['Two', 'Three', 'Four']) {
      fireEvent.change(title, { target: { value: input } });
      expect(title).toHaveValue(input);
    }
    fireEvent.change(author, { target: { value: 'Another author' } });
    expect(author).toHaveValue('Another author');
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
    await act(async () => release!());
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { name: 'Four', author: 'Another author' },
      }),
    );
    expect(title).toHaveValue('Four');
    expect(native.patch.mock.calls.map(([, , patches]) => patches[0])).toEqual([
      { op: 'replace', path: '/project/name', value: 'One' },
      { op: 'replace', path: '/project/name', value: 'Four' },
      { op: 'replace', path: '/project/author', value: 'Another author' },
    ]);
  });

  it('shares one overlay between two live views of the same field', async () => {
    const native = admitProject();
    render(
      <>
        <NameField tabId="first-view" />
        <NameField tabId="second-view" />
      </>,
    );
    const first = screen.getByRole('textbox', { name: 'Project title first-view' });
    const second = screen.getByRole('textbox', { name: 'Project title second-view' });
    fireEvent.change(first, { target: { value: 'From first view' } });
    expect(second).toHaveValue('From first view');
    fireEvent.change(second, { target: { value: 'Final shared value' } });
    expect(first).toHaveValue('Final shared value');
    await act(async () =>
      expect(await flushNativeFields(PROJECT_SETTINGS_SAVE_UNIT_ID)).toBe(true),
    );
    expect(native.patch.mock.calls[0]?.[2][0]?.path).toBe('/project/name');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'Final shared value' },
    });
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(0);
  });
  it('Save As copies a live unacknowledged field as recovery without native synchronization', async () => {
    const native = admitProject();
    const key = nativeFieldDraftKey(PROJECT_SETTINGS_SAVE_UNIT_ID, '/project/name');
    expect(
      projectEdits.field({
        tabId: 'project:1',
        path: '/project/name',
        saveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        value: 'Unacknowledged title',
        label: 'Update Project title',
      }),
    ).toBe(true);
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(1);
    expect((await saveProjectAsCopy()).success).toBe(true);
    expect(native.patch).not.toHaveBeenCalled();
    const copy = vi.mocked(window.noveltea.saveProjectCopyAs).mock.calls.at(-1)?.[1];
    expect(copy).toMatchObject({
      project: { name: 'Original' },
      editor: {
        draftsByKey: {
          [key]: { payload: { value: 'Unacknowledged title' } },
        },
      },
    });
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
  });

  it('preserves an actionable draft on native failure instead of pretending Save succeeded', async () => {
    admitProject();
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockRejectedValueOnce(new Error('Worker lost'));
    const view = render(<NameField />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title project:1' }), {
      target: { value: 'Unacknowledged work' },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Worker lost'));
    expect(screen.getByRole('textbox', { name: 'Project title project:1' })).toHaveValue(
      'Unacknowledged work',
    );
    expect(await flushNativeFields()).toBe(false);
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
    view.unmount();
    render(<NameField />);
    expect(screen.getByRole('textbox', { name: 'Project title project:1' })).toHaveValue(
      'Unacknowledged work',
    );
  });

  it('flushes pending fields before dependent commands are constructed', async () => {
    const native = admitProject();
    render(<NameField />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title project:1' }), {
      target: { value: 'Typed before structural command' },
    });
    await act(async () => {
      const result = await useCommandStore.getState().executeCommandAsync({
        type: 'project.setEntrypoint',
        label: 'Select entrypoint',
        payload: { target: null },
        originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        persistencePolicy: 'manual-save',
      });
      expect(result.ok).toBe(true);
    });
    expect(native.patch.mock.calls[0]?.[2][0]?.path).toBe('/project/name');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'Typed before structural command' },
    });
  });

  it('rebases a whole-Room control onto the latest buffered Room field', async () => {
    const project = createAuthoringProject();
    const baseline = defaultRoomData('Original Room');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: baseline };
    admitNativeRendererCommandFixture(project);
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof originalPatch>) => {
        if (!first) return originalPatch(...args);
        first = false;
        return new Promise<Awaited<ReturnType<typeof originalPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        });
      }),
    });
    render(
      <ProjectFieldInput
        aria-label="Room display name"
        tabId="room:foyer"
        path="/rooms/foyer/data/displayName"
        saveUnitId="record:rooms:foyer"
        label="Update room name"
        value={baseline.displayName}
        buildCommand={(next) =>
          projectEdits.recordField({
            record: { collection: 'rooms', id: 'foyer' },
            field: '/displayName',
            value: next,
            label: 'Update room name',
          })
        }
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Room display name' }), {
      target: { value: 'New buffered name' },
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const update = projectEdits.recordData({
      record: { collection: 'rooms', id: 'foyer' },
      before: baseline,
      after: {
        ...baseline,
        description: {
          ...baseline.description,
          source: { kind: 'inline', text: 'New description' },
        },
      },
      label: 'Update room description via whole-Room control',
    });
    expect(update).not.toBeNull();
    const pending = useCommandStore.getState().executeCommandAsync(update!);
    await act(async () => release!());
    await act(async () => expect((await pending).ok).toBe(true));
    const document = useProjectStore.getState().document;
    expect(isAuthoringProjectView(document)).toBe(true);
    if (isAuthoringProjectView(document)) {
      expect(parseRoomData(document.rooms.foyer?.data)).toMatchObject({
        displayName: 'New buffered name',
        description: { source: { kind: 'inline', text: 'New description' } },
      });
    }
  });
});
