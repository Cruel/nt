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
  externalRevision: `sha256:${string}` = REVISION,
) {
  return reconcileExternalProjectChange({
    baseDocument,
    localDocument,
    externalDocument,
    recovery: recoveryState,
    externalWorkspaceRevision: externalRevision,
    externalFileRevisions: { 'records/rooms/hall.json': externalRevision },
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

  it('applies an external change to another dirty record without creating a conflict', () => {
    const base = {
      rooms: {
        hall: { description: 'Old' },
        kitchen: { description: 'Kitchen' },
      },
    };
    const local = {
      rooms: {
        hall: { description: 'Local' },
        kitchen: { description: 'Kitchen' },
      },
    };
    const external = {
      rooms: {
        hall: { description: 'Old' },
        kitchen: { description: 'External kitchen' },
      },
    };
    const result = reconcile(base, local, external, recovery('/rooms/hall/description'));

    expect(result.workingDocument).toEqual({
      rooms: {
        hall: { description: 'Local' },
        kitchen: { description: 'External kitchen' },
      },
    });
    expect(result.conflictingSaveUnitIds).toEqual([]);
  });

  it('treats external deletion of a dirty record as a conflict', () => {
    const base = { rooms: { hall: { description: 'Old' } } };
    const local = { rooms: { hall: { description: 'Local' } } };
    const external = { rooms: {} };
    const result = reconcile(base, local, external, recovery('/rooms/hall/description'));

    expect(result.workingDocument).toEqual(local);
    expect(result.savedDocument).toEqual(external);
    expect(result.conflictingSaveUnitIds).toEqual(['record:rooms:hall']);
    expect(result.conflictingPaths).toEqual(['/rooms/hall/description']);
  });

  it('treats competing array edits as a conservative conflict', () => {
    const base = { rooms: { hall: { tags: ['a', 'b'] } } };
    const local = { rooms: { hall: { tags: ['local', 'b'] } } };
    const external = { rooms: { hall: { tags: ['b', 'a'] } } };
    const result = reconcile(base, local, external, recovery('/rooms/hall/tags'));

    expect(result.workingDocument).toEqual(local);
    expect(result.conflictingSaveUnitIds).toEqual(['record:rooms:hall']);
    expect(result.conflictingPaths).toEqual(['/rooms/hall/tags']);
  });

  it('re-conflicts against a newer external value while preserving the original common base', () => {
    const newerRevision = `sha256:${'b'.repeat(64)}` as const;
    const base = { rooms: { hall: { description: 'Old' } } };
    const local = { rooms: { hall: { description: 'Local' } } };
    const firstExternal = { rooms: { hall: { description: 'Disk 1' } } };
    const first = reconcile(base, local, firstExternal, recovery('/rooms/hall/description'));
    const secondExternal = { rooms: { hall: { description: 'Disk 2' } } };
    const second = reconcile(
      first.savedDocument,
      first.workingDocument,
      secondExternal,
      first.recovery,
      newerRevision,
    );
    const conflict = second.recovery.saveUnitsById['record:rooms:hall']?.externalConflict;

    expect(second.workingDocument).toEqual(local);
    expect(second.savedDocument).toEqual(secondExternal);
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
      value: 'Disk 2',
    });
    expect(conflict?.externalWorkspaceRevision).toBe(newerRevision);
  });
});
