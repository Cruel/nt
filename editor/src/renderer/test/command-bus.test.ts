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
} from '@/commands/command-bus';

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
