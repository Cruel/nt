import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authoredNativePatches, mergeAuthoredValue } from '@/commands/authored-record-fields';
import { projectEdits } from '@/commands/project-editing';
import { nativeFieldDraftKey } from '@/commands/native-field-drafts';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { TestsEditor } from '@/editors/tests/TestsEditor';
import { InteractionEditor } from '@/editors/interactions/InteractionEditor';
import { VerbEditor } from '@/editors/verbs/VerbEditor';
import { renameVerbSlot } from '@/editors/verbs/verb-slot-rename';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultTestData,
  defaultTestStep,
  testCharacterSubject,
  testVerbRef,
} from '../../shared/project-schema/authoring-tests';
import { defaultVerbData, parseVerbData } from '../../shared/project-schema/authoring-verbs';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

const tab = (collection: 'tests' | 'interactions' | 'verbs', id: string): WorkbenchTab => ({
  id: `tab:${collection}:${id}`,
  title: id,
  editorType:
    collection === 'tests'
      ? 'test-detail'
      : collection === 'verbs'
        ? 'verb-detail'
        : 'interaction-detail',
  resource: { kind: 'record', stableId: `record:${collection}:${id}`, collection, entityId: id },
});

function admitRecords() {
  const project = createAuthoringProject();
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: defaultVerbData('Inspect') };
  project.interactions.inspect = {
    id: 'inspect',
    label: 'Inspect',
    data: defaultInteractionData(),
  };
  return admitNativeRendererCommandFixture(project);
}

function verbWithLinkedSlot() {
  const data = defaultVerbData('Inspect');
  data.slots = [
    {
      id: 'subject',
      label: { source: { kind: 'inline', text: 'Subject' }, markup: 'plain' },
      prompt: { source: { kind: 'inline', text: 'Choose subject' }, markup: 'plain' },
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  data.bindingOrder = ['subject'];
  data.offers = [
    {
      id: 'offer-1',
      slotId: 'subject',
      rank: 0,
      primary: true,
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  return data;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
  vi.restoreAllMocks();
});

describe('authored stable-member editing', () => {
  it('remaps Verb slot placeholders and nested interaction-slot references atomically', () => {
    const data = verbWithLinkedSlot();
    data.completedCommandText = {
      source: { kind: 'inline', text: 'Inspect {subject}' },
      markup: 'plain',
    };
    data.slots[0]!.prompt = {
      source: { kind: 'inline', text: 'Choose {subject}' },
      markup: 'plain',
    };
    const updated = renameVerbSlot(data, 'subject', 'target');
    expect(updated.completedCommandText.source).toMatchObject({ text: 'Inspect {target}' });
    expect(updated.slots[0]?.prompt.source).toMatchObject({ text: 'Choose {target}' });
    expect(updated.offers[0]?.slotId).toBe('target');
    expect(updated.bindingOrder).toEqual(['target']);
    expect(parseVerbData(updated)).not.toBeNull();
  });
  it('sends narrow native paths for a changed member of a normalized legacy source list', () => {
    const rules = [
      { id: 'specific', verb: { $ref: { collection: 'verbs', id: 'inspect' } }, priority: 2 },
      { id: 'generic', verb: { $ref: { collection: 'verbs', id: 'inspect' } }, priority: 0 },
    ];
    const patches = authoredNativePatches(
      rules,
      [{ ...rules[0]!, priority: 3 }, rules[1]!],
      '/interactions/inspect/data/rules',
    );
    expect(patches).toEqual([
      {
        op: 'replace',
        path: '/interactions/inspect/data/rules/0/priority',
        value: 3,
      },
    ]);
    expect(
      authoredNativePatches(
        rules,
        [rules[0]!, { id: 'new', priority: 4 }, rules[1]!],
        '/interactions/inspect/data/rules',
      ),
    ).toEqual([
      {
        op: 'add',
        path: '/interactions/inspect/data/rules/1',
        value: { id: 'new', priority: 4 },
      },
    ]);
    const swapped = authoredNativePatches(
      rules,
      [rules[1]!, rules[0]!],
      '/interactions/inspect/data/rules',
    );
    expect(swapped).toEqual([
      { op: 'replace', path: '/interactions/inspect/data/rules/0/id', value: 'generic' },
      { op: 'replace', path: '/interactions/inspect/data/rules/0/priority', value: 0 },
      { op: 'replace', path: '/interactions/inspect/data/rules/1/id', value: 'specific' },
      { op: 'replace', path: '/interactions/inspect/data/rules/1/priority', value: 2 },
    ]);
    expect(
      authoredNativePatches(
        rules,
        [{ ...rules[0]!, id: 'renamed' }, rules[1]!],
        '/interactions/inspect/data/rules',
      ),
    ).toEqual([{ op: 'replace', path: '/interactions/inspect/data/rules/0/id', value: 'renamed' }]);
  });
  it('preserves disjoint fields and the exact stable-ID order after append and reorder', () => {
    const before = [
      { id: 'a', label: 'A', enabled: true },
      { id: 'b', label: 'B', enabled: true },
    ];
    const draft = mergeAuthoredValue(
      before,
      [{ ...before[0]!, label: 'A typed' }, before[1]],
      before,
    );
    const inserted = mergeAuthoredValue(
      before,
      [before[0], { id: 'c', label: 'C', enabled: true }, before[1]],
      draft,
    );
    const reordered = mergeAuthoredValue(
      [before[0], { id: 'c', label: 'C', enabled: true }, before[1]],
      [before[1], before[0], { id: 'c', label: 'C', enabled: true }],
      inserted,
    ) as typeof before;
    expect(reordered.map(({ id }) => id)).toEqual(['b', 'a', 'c']);
    expect(reordered.find(({ id }) => id === 'a')).toMatchObject({ label: 'A typed' });
    expect(
      mergeAuthoredValue(
        before,
        [before[0], before[1]],
        [{ ...before[0]!, label: 'External' }, before[1]],
      ),
    ).toMatchObject([{ label: 'External' }, { label: 'B' }]);
  });

  it('merges a change to one nested step without overwriting another', () => {
    const before = [
      { id: 'a', tick: { deltaSeconds: 1 }, label: 'A' },
      { id: 'b', tick: { deltaSeconds: 2 }, label: 'B' },
    ];
    const latest = [before[0], { ...before[1]!, label: 'B changed' }];
    const merged = mergeAuthoredValue(
      before,
      [{ ...before[0]!, tick: { deltaSeconds: 3 } }, before[1]],
      latest,
    );
    expect(merged).toMatchObject([
      { id: 'a', tick: { deltaSeconds: 3 }, label: 'A' },
      { id: 'b', tick: { deltaSeconds: 2 }, label: 'B changed' },
    ]);
  });

  it('rejects a duplicate member identity rather than silently overwriting it', () => {
    expect(() =>
      mergeAuthoredValue([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]),
    ).toThrow(/already exists/);
  });

  it('keeps Test text, step input, and selection responsive while native acknowledgment is held', async () => {
    const native = admitRecords();
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        }),
    );
    render(<TestsEditor tab={tab('tests', 'smoke')} />);
    const name = screen.getByDisplayValue('Smoke');
    fireEvent.change(name, { target: { value: 'Smoke A' } });
    const firstFlush = projectEdits.flush('record:tests:smoke');
    await waitFor(() => expect(release).toBeTypeOf('function'));

    fireEvent.change(name, { target: { value: 'Smoke ABC' } });
    fireEvent.change(screen.getByDisplayValue('Start'), { target: { value: 'First step edited' } });
    fireEvent.change(screen.getByLabelText('Tick delta seconds'), { target: { value: '0.75' } });
    expect(name).toHaveValue('Smoke ABC');
    expect(screen.getByDisplayValue('First step edited')).toBeInTheDocument();
    expect(screen.getByLabelText('Tick delta seconds')).toHaveValue('0.75');
    expect(useProjectStore.getState().document).toMatchObject({
      tests: { smoke: { data: { displayName: 'Smoke' } } },
    });

    await act(async () => release!());
    await act(async () => expect(await firstFlush).toBe(true));
    await act(async () => expect(await projectEdits.flush('record:tests:smoke')).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      tests: {
        smoke: {
          data: {
            displayName: 'Smoke ABC',
            steps: [
              expect.objectContaining({ label: 'First step edited', tick: { deltaSeconds: 0.75 } }),
            ],
          },
        },
      },
    });
    expect(native.patch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('keeps Verb text controls independent under a held native acknowledgment', async () => {
    const native = admitRecords();
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        }),
    );
    render(<VerbEditor tab={tab('verbs', 'inspect')} />);
    const action = screen.getAllByDisplayValue('Inspect')[0]!;
    fireEvent.change(action, { target: { value: 'Look' } });
    const firstFlush = projectEdits.flush('record:verbs:inspect');
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const completed = screen.getByDisplayValue('Inspect');
    fireEvent.change(completed, { target: { value: 'Looked at object' } });
    fireEvent.change(action, { target: { value: 'Look closely' } });
    expect(action).toHaveValue('Look closely');
    expect(completed).toHaveValue('Looked at object');
    expect(useProjectStore.getState().document).toMatchObject({
      verbs: { inspect: { data: { actionText: { source: { text: 'Inspect' } } } } },
    });
    await act(async () => release!());
    await act(async () => expect(await firstFlush).toBe(true));
    await act(async () => expect(await projectEdits.flush('record:verbs:inspect')).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      verbs: {
        inspect: {
          data: {
            actionText: { source: { text: 'Look closely' } },
            completedCommandText: { source: { text: 'Looked at object' } },
          },
        },
      },
    });
    expect(native.patch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('preserves an empty in-progress Verb Lua expression rather than coercing the text', async () => {
    const project = createAuthoringProject();
    const data = defaultVerbData('Inspect');
    data.actionText = {
      source: { kind: 'lua-expression', source: 'return "hello"' },
      markup: 'plain',
    };
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data };
    admitNativeRendererCommandFixture(project);
    render(<VerbEditor tab={tab('verbs', 'inspect')} />);
    const expression = screen.getByDisplayValue('return "hello"');
    fireEvent.change(expression, { target: { value: 'return' } });
    expect(expression).toHaveValue('return');
    fireEvent.change(expression, { target: { value: '' } });
    expect(expression).toHaveValue('');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:verbs:inspect'],
    ).toMatchObject({
      '/verbs/inspect/data/actionText/source/source': { value: '' },
    });
    await act(async () => expect(await projectEdits.flush('record:verbs:inspect')).toBe(false));
    fireEvent.change(expression, { target: { value: 'return "ok"' } });
    expect(expression).toHaveValue('return "ok"');
    await act(async () => expect(await projectEdits.flush('record:verbs:inspect')).toBe(true));
    expect(
      (useProjectStore.getState().document as typeof project).verbs.inspect.data.actionText,
    ).toMatchObject({ source: { kind: 'lua-expression', source: 'return "ok"' } });
  });

  it('renames a Verb subject slot and its binding and Offer referents atomically', async () => {
    const project = createAuthoringProject();
    const data = verbWithLinkedSlot();
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data };
    admitNativeRendererCommandFixture(project);
    render(<VerbEditor tab={tab('verbs', 'inspect')} />);

    const input = screen.getByRole('textbox', { name: 'Subject slot ID' });
    fireEvent.change(input, { target: { value: 'target' } });
    expect(input).toHaveValue('target');
    // Renaming an identity does not mutate any referent before blur.
    expect(
      (useProjectStore.getState().document as typeof project).verbs.inspect.data.bindingOrder,
    ).toEqual(['subject']);
    fireEvent.blur(input);
    await waitFor(() => {
      const latest = (useProjectStore.getState().document as typeof project).verbs.inspect.data;
      expect(latest.slots.map((slot) => slot.id)).toEqual(['target']);
      expect(latest.bindingOrder).toEqual(['target']);
      expect(latest.offers[0]?.slotId).toBe('target');
    });
    const last = useCommandStore.getState().history.entries.at(-1);
    expect(last).toMatchObject({
      type: 'project.applyPatch',
      originSaveUnitId: 'record:verbs:inspect',
    });
    expect(last?.patches.map(({ path }) => path)).toEqual([
      '/verbs/inspect/data/slots/0/id',
      '/verbs/inspect/data/bindingOrder/0',
      '/verbs/inspect/data/offers/0/slotId',
    ]);
  });

  it('updates linked Interaction rule slots in the same atomic Verb rename command', async () => {
    const project = createAuthoringProject();
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: verbWithLinkedSlot() };
    const data = defaultInteractionData();
    data.rules = [
      {
        id: 'inspect-rule',
        verb: { $ref: { collection: 'verbs', id: 'inspect' } },
        slots: [{ slotId: 'subject', selectors: [{ kind: 'any-subject' }] }],
        offer: { slotId: 'subject', rank: 0, primary: false },
        guard: { kind: 'always' },
        priority: 0,
        program: defaultInteractionProgram(),
      },
    ];
    project.interactions.inspect = { id: 'inspect', label: 'Inspect', data };
    const test = defaultTestData('Smoke');
    test.steps = [
      {
        ...defaultTestStep('run-interaction'),
        id: 'inspect-step',
        runInteraction: {
          verb: testVerbRef('inspect'),
          bindings: [{ slotId: 'subject', subject: testCharacterSubject('iris') }],
        },
      },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: test };
    admitNativeRendererCommandFixture(project);
    render(<VerbEditor tab={tab('verbs', 'inspect')} />);
    const field = screen.getByRole('textbox', { name: 'Subject slot ID' });
    fireEvent.change(field, { target: { value: 'target' } });
    fireEvent.blur(field);
    await waitFor(() => {
      const document = useProjectStore.getState().document as typeof project;
      expect(document.verbs.inspect.data.slots[0]?.id).toBe('target');
      expect(document.interactions.inspect.data.rules[0]?.slots[0]?.slotId).toBe('target');
      expect(document.interactions.inspect.data.rules[0]?.offer?.slotId).toBe('target');
      expect(document.tests.smoke.data.steps[0]?.runInteraction.bindings[0]?.slotId).toBe('target');
    });
    const last = useCommandStore.getState().history.entries.at(-1);
    expect(last?.type).toBe('project.applyPatch');
    expect(
      last?.patches.some(({ path }) => path.startsWith('/interactions/inspect/data/rules/0/')),
    ).toBe(true);
    expect(last?.patches.some(({ path }) => path.startsWith('/tests/smoke/data/steps/0/'))).toBe(
      true,
    );
  });

  it('recovers a rejected atomic Verb rename and retries the complete reference update', async () => {
    const project = createAuthoringProject();
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: verbWithLinkedSlot() };
    admitNativeRendererCommandFixture(project);
    // An explicitly rejected native result is safe to retry. An IPC exception
    // could have applied remotely and must instead poison the session until
    // authoritative reconciliation, not blindly resend the command.
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockResolvedValueOnce({
      accepted: false,
      error: 'Native atomic rename rejected',
    } as Awaited<ReturnType<typeof window.noveltea.nativeProjectPatch>>);
    render(<VerbEditor tab={tab('verbs', 'inspect')} />);
    const field = screen.getByRole('textbox', { name: 'Subject slot ID' });
    fireEvent.change(field, { target: { value: 'target' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/native atomic rename rejected/i),
    );
    const before = (useProjectStore.getState().document as typeof project).verbs.inspect.data;
    expect(before.slots[0]?.id).toBe('subject');
    expect(before.bindingOrder).toEqual(['subject']);
    expect(before.offers[0]?.slotId).toBe('subject');
    const persisted = usePendingInputStore.getState().entriesBySaveUnitId['record:verbs:inspect'];
    expect(persisted?.['/verbs/inspect/data/@semantic']?.value).toContain('"target"');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      const data = (useProjectStore.getState().document as typeof project).verbs.inspect.data;
      expect(data.slots[0]?.id).toBe('target');
      expect(data.bindingOrder).toEqual(['target']);
      expect(data.offers[0]?.slotId).toBe('target');
    });
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:verbs:inspect']?.[
        '/verbs/inspect/data/@semantic'
      ],
    ).toBeUndefined();
  });

  it('rebases a queued Test step append over independent edits under held acknowledgment', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps.push({ ...defaultTestStep('tick'), id: 'second', label: 'Second' });
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };
    admitNativeRendererCommandFixture(project);
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        }),
    );
    render(<TestsEditor tab={tab('tests', 'smoke')} />);
    fireEvent.change(screen.getByDisplayValue('Start'), { target: { value: 'First updated' } });
    const firstFlush = projectEdits.flush('record:tests:smoke');
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(screen.getByText('Second'));
    fireEvent.change(screen.getByDisplayValue('Second'), { target: { value: 'Second updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => release!());
    await act(async () => expect(await firstFlush).toBe(true));
    await waitFor(() => {
      const record = (useProjectStore.getState().document as typeof project).tests.smoke;
      expect(record.data.steps.map((step) => step.label)).toEqual([
        'First updated',
        'Second updated',
        'Continue',
      ]);
      expect(record.data.preview.selectedStepId).toBe('continue');
    });
    await act(async () => expect(await projectEdits.flush('record:tests:smoke')).toBe(true));
  });

  it('presents Interaction rule numeric and switch edits without waiting for native', async () => {
    admitRecords();
    render(<InteractionEditor tab={tab('interactions', 'inspect')} />);
    fireEvent.click(screen.getByText('Add rule'));
    expect(screen.getByLabelText('Priority')).toHaveValue('0');
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '-' } });
    expect(screen.getByLabelText('Priority')).toHaveValue('-');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:interactions:inspect'],
    ).toBeDefined();
    await act(async () =>
      expect(await projectEdits.flush('record:interactions:inspect')).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '3' } });
    expect(screen.getByLabelText('Priority')).toHaveValue('3');
    await act(async () =>
      expect(await projectEdits.flush('record:interactions:inspect')).toBe(true),
    );
    expect(useProjectStore.getState().document).toMatchObject({
      interactions: { inspect: { data: { rules: [expect.objectContaining({ priority: 3 })] } } },
    });
  });

  it('retains a rejected Interaction rule edit and an actionable native error', async () => {
    admitRecords();
    render(<InteractionEditor tab={tab('interactions', 'inspect')} />);
    fireEvent.click(screen.getByText('Add rule'));
    await act(async () =>
      expect(await projectEdits.flush('record:interactions:inspect')).toBe(true),
    );
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockRejectedValueOnce(
      new Error('Interaction native rejection'),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Priority' }), {
      target: { value: '7' },
    });
    await act(async () =>
      expect(await projectEdits.flush('record:interactions:inspect')).toBe(false),
    );
    expect(screen.getByRole('textbox', { name: 'Priority' })).toHaveValue('7');
    expect(screen.getByRole('alert')).toHaveTextContent(/interaction native rejection/i);
    expect(Object.keys(useDraftDirtyStore.getState().entriesByKey)).toContain(
      nativeFieldDraftKey('record:interactions:inspect', '/interactions/inspect/data/rules'),
    );
  });

  it('keeps a rejected Test field visible and recoverable instead of claiming success', async () => {
    admitRecords();
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockRejectedValueOnce(
      new Error('Simulated native rejection'),
    );
    render(<TestsEditor tab={tab('tests', 'smoke')} />);
    const name = screen.getByDisplayValue('Smoke');
    fireEvent.change(name, { target: { value: 'Unsaved latest intent' } });
    await act(async () => expect(await projectEdits.flush('record:tests:smoke')).toBe(false));
    expect(name).toHaveValue('Unsaved latest intent');
    expect(screen.getByRole('alert')).toHaveTextContent(/native rejection/i);
    expect(Object.keys(useDraftDirtyStore.getState().entriesByKey)).toContain(
      nativeFieldDraftKey('record:tests:smoke', '/tests/smoke/data/displayName'),
    );
    // A rejected draft is retained for recovery; no synthetic successful write.
    expect(useProjectStore.getState().document).toMatchObject({
      tests: { smoke: { data: { displayName: 'Smoke' } } },
    });
  });

  it('synchronizes duplicate views and preserves an exact field edit through Undo and Redo', async () => {
    admitRecords();
    const secondary: WorkbenchTab = { ...tab('tests', 'smoke'), id: 'tab:tests:smoke:secondary' };
    render(
      <>
        <TestsEditor tab={tab('tests', 'smoke')} />
        <TestsEditor tab={secondary} />
      </>,
    );
    const names = screen.getAllByDisplayValue('Smoke');
    expect(names).toHaveLength(2);
    fireEvent.change(names[0]!, { target: { value: 'Edited in either tab' } });
    expect(names[1]).toHaveValue('Edited in either tab');
    await act(async () => expect(await projectEdits.flush('record:tests:smoke')).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      tests: { smoke: { data: { displayName: 'Edited in either tab' } } },
    });
    await act(async () => expect((await projectEdits.undo()).ok).toBe(true));
    expect(names[0]).toHaveValue('Smoke');
    expect(names[1]).toHaveValue('Smoke');
    await act(async () => expect((await projectEdits.redo()).ok).toBe(true));
    expect(names[0]).toHaveValue('Edited in either tab');
    expect(names[1]).toHaveValue('Edited in either tab');
  });
});
