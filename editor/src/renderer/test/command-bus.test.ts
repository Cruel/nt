import { describe, expect, it, beforeEach } from 'vite-plus/test';
import {
  beginTransaction,
  cancelTransaction,
  commitTransaction,
  createInitialCommandBusState,
  executeCommand,
  redoCommand,
  resetCommandIdsForTests,
  undoCommand,
} from './command-test-utils';
import { executeCommand as executeCommandCore } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';

describe('command bus', () => {
  beforeEach(() => resetCommandIdsForTests());

  it('applies, undoes, and redoes commands', () => {
    let state = createInitialCommandBusState({ room: { foyer: ['foyer'] } });
    const applied = executeCommand(state, {
      type: 'entity.replaceRecord',
      payload: { collection: 'room', entityId: 'foyer', record: ['foyer', 'edited'] },
    });
    expect(applied.ok).toBe(true);
    expect(applied.state.document).toEqual({ room: { foyer: ['foyer', 'edited'] } });

    state = applied.state;
    const undone = undoCommand(state);
    expect(undone.state.document).toEqual({ room: { foyer: ['foyer'] } });

    const redone = redoCommand(undone.state);
    expect(redone.state.document).toEqual({ room: { foyer: ['foyer', 'edited'] } });
  });

  it('does not mutate on failed preconditions', () => {
    const state = createInitialCommandBusState({ room: {} });
    const result = executeCommand(state, {
      type: 'project.replaceAtPath',
      payload: { path: '/room/missing', value: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.projectChanged).toBe(false);
    expect(result.state.document).toEqual({ room: {} });
  });

  it('rejects mutating commands without save-unit attribution', () => {
    const state = createInitialCommandBusState({ room: {} });
    const result = executeCommandCore(state, {
      type: 'project.addAtPath',
      payload: { path: '/room/foyer', value: ['foyer'] },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.projectChanged).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('origin save-unit ID');
  });

  it('retains attribution, canonical affected paths, and atomic grouping in history', () => {
    const state = createInitialCommandBusState({ room: { foyer: ['foyer'] } });
    const result = executeCommand(state, {
      type: 'project.applyPatch',
      payload: [
        { op: 'add', path: '/room/hall', value: ['hall'] },
        { op: 'replace', path: '/room/foyer/0', value: 'entry' },
        { op: 'replace', path: '/room/foyer/0', value: 'foyer' },
      ],
      originSaveUnitId: 'workflow:test-batch',
      persistencePolicy: 'auto-commit',
    });
    expect(result.historyEntry).toMatchObject({
      originSaveUnitId: 'workflow:test-batch',
      persistencePolicy: 'auto-commit',
      affectedPaths: ['/room/foyer/0', '/room/hall'],
      atomicTransactionGroupId: 'atomic:command:1',
    });
  });

  it('retains patch paths omitted from a handler affected-path summary', () => {
    const state = createInitialCommandBusState({ settings: {} });
    const result = executeCommandCore(
      state,
      {
        type: 'test.addNestedSetting',
        payload: null,
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      },
      {
        'test.addNestedSetting': () => ({
          patches: [
            { op: 'add', path: '/settings/ui', value: toJsonValue({}) },
            {
              op: 'add',
              path: '/settings/ui/systemLayouts',
              value: toJsonValue({ title: null }),
            },
          ],
          affectedPaths: ['/settings/ui/systemLayouts/title'],
        }),
      },
    );

    expect(result.historyEntry).toMatchObject({
      affectedPaths: [
        '/settings/ui',
        '/settings/ui/systemLayouts',
        '/settings/ui/systemLayouts/title',
      ],
      atomicTransactionGroupId: 'atomic:command:1',
    });
  });

  it('rejects conflicting atomic transaction-group attribution', () => {
    const state = createInitialCommandBusState({ room: {} });
    const result = executeCommandCore(
      state,
      {
        type: 'test.conflictingAtomicGroup',
        payload: null,
        originSaveUnitId: 'workflow:test',
        persistencePolicy: 'manual-save',
        atomicTransactionGroupId: 'atomic:request',
      },
      {
        'test.conflictingAtomicGroup': () => ({
          patches: [{ op: 'add', path: '/room/foyer', value: ['foyer'] }],
          atomicTransactionGroupId: 'atomic:handler',
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.projectChanged).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('atomic transaction-group ID');
  });

  it('does not begin a transaction without valid ownership attribution', () => {
    const state = createInitialCommandBusState({ room: {} });
    const next = beginTransaction(state, {
      label: 'Invalid transaction',
      originSaveUnitId: '',
      persistencePolicy: 'manual-save',
    });
    expect(next.history.activeTransaction).toBeNull();
  });

  it('commits transactions as one history entry and can cancel them', () => {
    let state = createInitialCommandBusState({ room: { foyer: ['foyer'] } });
    state = beginTransaction(state, 'Batch edit');
    state = executeCommand(state, {
      type: 'project.replaceAtPath',
      payload: { path: '/room/foyer/0', value: 'foyer' },
    }).state;
    state = executeCommand(state, {
      type: 'project.addAtPath',
      payload: { path: '/room/hall', value: ['hall'] },
    }).state;
    const committed = commitTransaction(state);
    expect(committed.state.history.entries).toHaveLength(1);
    expect(committed.historyEntry).toMatchObject({
      originSaveUnitId: 'test:transaction',
      persistencePolicy: 'manual-save',
      affectedPaths: ['/room/foyer/0', '/room/hall'],
      atomicTransactionGroupId: 'transaction:1',
      transactionId: 'transaction:1',
    });
    expect(committed.state.document).toEqual({ room: { foyer: ['foyer'], hall: ['hall'] } });

    state = beginTransaction(committed.state, 'Canceled edit');
    state = executeCommand(state, {
      type: 'project.addAtPath',
      payload: { path: '/room/kitchen', value: ['kitchen'] },
    }).state;
    expect(state.document).toEqual({
      room: { foyer: ['foyer'], hall: ['hall'], kitchen: ['kitchen'] },
    });
    expect(cancelTransaction(state).document).toEqual({
      room: { foyer: ['foyer'], hall: ['hall'] },
    });
  });
});
