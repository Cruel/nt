import { describe, expect, it } from 'vite-plus/test';
import { reconcileExternalProjectChange } from '@/project/project-external-reconciliation';
import type { EditorRecoveryState } from '../../shared/project-schema/editor-project-state';
import type { JsonValue } from '@/project/json-value';

const REVISION = `sha256:${'a'.repeat(64)}` as const;

function recovery(path: string): EditorRecoveryState {
  return {
    sequence: 1,
    saveUnitsById: {
      'record:rooms:hall': {
        sequence: 1,
        patches: [],
        affectedPaths: [path],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    },
  };
}

function reconcile(
  baseDocument: JsonValue,
  localDocument: JsonValue,
  externalDocument: JsonValue,
  recoveryState: EditorRecoveryState,
) {
  return reconcileExternalProjectChange({
    baseDocument,
    localDocument,
    externalDocument,
    recovery: recoveryState,
    externalWorkspaceRevision: REVISION,
    externalFileRevisions: { 'records/rooms/hall.json': REVISION },
  });
}

describe('external project reconciliation', () => {
  it('adopts clean external changes immediately', () => {
    const base = { rooms: { hall: { name: 'Hall' } } };
    const external = { rooms: { hall: { name: 'Hallway' } } };
    const result = reconcile(base, base, external, { sequence: 0, saveUnitsById: {} });

    expect(result.workingDocument).toEqual(external);
    expect(result.savedDocument).toEqual(external);
    expect(result.conflictingSaveUnitIds).toEqual([]);
  });

  it('rebases disjoint local and external edits to the same record', () => {
    const base = { rooms: { hall: { name: 'Hall', description: 'Old' } } };
    const local = { rooms: { hall: { name: 'Hall', description: 'Local' } } };
    const external = { rooms: { hall: { name: 'Hallway', description: 'Old' } } };
    const result = reconcile(base, local, external, recovery('/rooms/hall/description'));

    expect(result.workingDocument).toEqual({
      rooms: { hall: { name: 'Hallway', description: 'Local' } },
    });
    expect(result.savedDocument).toEqual(external);
    expect(result.conflictingSaveUnitIds).toEqual([]);
    expect(result.recovery.saveUnitsById['record:rooms:hall']?.patches).toEqual([
      { op: 'replace', path: '/rooms/hall/description', value: 'Local' },
    ]);
  });

  it('keeps local state active and records an overlapping conflict', () => {
    const base = { rooms: { hall: { description: 'Old' } } };
    const local = { rooms: { hall: { description: 'Local' } } };
    const external = { rooms: { hall: { description: 'Disk' } } };
    const result = reconcile(base, local, external, recovery('/rooms/hall/description'));
    const conflict = result.recovery.saveUnitsById['record:rooms:hall']?.externalConflict;

    expect(result.workingDocument).toEqual(local);
    expect(result.savedDocument).toEqual(external);
    expect(result.conflictingPaths).toEqual(['/rooms/hall/description']);
    expect(conflict?.baseValueByPath['/rooms/hall/description']).toEqual({
      exists: true,
      value: 'Old',
    });
    expect(conflict?.localValueByPath['/rooms/hall/description']).toEqual({
      exists: true,
      value: 'Local',
    });
    expect(conflict?.externalValueByPath['/rooms/hall/description']).toEqual({
      exists: true,
      value: 'Disk',
    });
    expect(conflict?.externalWorkspaceRevision).toBe(REVISION);
  });
});
