import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { stripLocalEditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { NativeAuthoringPatchResult } from '../../main/services/native-authoring-worker-contract';
import {
  nativeOwnersForChangedSources,
  projectNativeExternalResult,
} from '../project/native-external-projection';
import type { JsonValue } from '../project/json-value';
import { reconcileExternalProjectChange } from '../project/project-external-reconciliation';

const original = createAuthoringProject({ id: 'native-watch', name: 'Native Watch' });
original.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
const baseRoom = original.rooms.hall!;

function result(
  baseline: unknown,
  source: unknown,
  conflictingPaths: string[] = [],
): NativeAuthoringPatchResult {
  return {
    accepted: true,
    error: '',
    affectedRecords: ['rooms/hall'],
    diagnosticsAdded: [],
    diagnosticsRemoved: [],
    snapshot: {
      workingRevision: 3,
      diskSourceRevision: 'sha256:' + 'a'.repeat(64),
      source: { project: { id: 'native-watch' } },
      baseline: { project: { id: 'native-watch' } },
      normalized: null,
      dirty: true,
      valid: true,
      diagnostics: [],
      recordSnapshots: {
        'rooms/hall': {
          workingRevision: 3,
          diskSourceRevision: 'sha256:' + 'b'.repeat(64),
          source,
          baseline,
          normalized: source,
          dirty: true,
          valid: true,
          diagnostics: [],
          conflictingPaths,
        },
      },
    },
  };
}

const recovery = {
  sequence: 1,
  saveUnitsById: {
    'record:rooms:hall': {
      sequence: 1,
      patches: [{ op: 'replace' as const, path: '/rooms/hall/label', value: 'Mine' }],
      affectedPaths: ['/rooms/hall/label'],
      pendingRawInputByPath: {},
      atomicTransactionGroupIds: [],
    },
  },
};

describe('native editor external projection (#509)', () => {
  it('keeps native Room records effective after a clean watcher reconciliation', () => {
    const sparseRoom = {
      ...baseRoom,
      data: { displayName: 'Updated on disk' },
    };
    const effectiveRoom = {
      ...baseRoom,
      data: { ...defaultRoomData('Hall'), displayName: 'Updated on disk' },
    };
    const acknowledged = result(sparseRoom, sparseRoom);
    const record = acknowledged.snapshot.recordSnapshots!['rooms/hall']!;
    record.normalized = effectiveRoom;
    record.dirty = false;
    const reconciled = projectNativeExternalResult({
      saved: original as JsonValue,
      working: original as JsonValue,
      recovery: { sequence: 0, saveUnitsById: {} },
      result: acknowledged,
    });
    expect((reconciled.working as typeof original).rooms.hall).toEqual(effectiveRoom);
    expect((reconciled.saved as typeof original).rooms.hall).toEqual(effectiveRoom);
    expect(reconciled.conflictingUnitIds).toEqual([]);

    record.dirty = true;
    const dirty = projectNativeExternalResult({
      saved: original as JsonValue,
      working: original as JsonValue,
      recovery: { sequence: 0, saveUnitsById: {} },
      result: acknowledged,
    });
    expect((dirty.working as typeof original).rooms.hall).toEqual(effectiveRoom);
  });

  it('routes physical source notifications to one native owner and ignores unrelated files', () => {
    expect(
      nativeOwnersForChangedSources([
        'records/rooms/hall.yaml',
        'records/rooms/hall.yaml',
        'records/layouts/screen/layout.rml',
        'records/layouts/screen/layout.yaml',
        'i18n/locales/fr-FR.yaml',
        'notes.md',
        'assets/background.webp',
      ]),
    ).toEqual(['i18n/locales/fr-FR.yaml', 'layouts/screen', 'rooms/hall']);
  });

  it('rebases disjoint external fields from native values, retaining local dirty recovery', () => {
    const local = structuredClone(original);
    local.rooms.hall!.label = 'Mine';
    const diskRoom = { ...baseRoom, description: 'On Disk' };
    const mergedRoom = { ...diskRoom, label: 'Mine' };
    const projection = projectNativeExternalResult({
      saved: original as JsonValue,
      working: local as JsonValue,
      recovery,
      result: result(diskRoom, mergedRoom),
    });
    expect((projection.saved as typeof original).rooms.hall).toEqual(diskRoom);
    expect((projection.working as typeof original).rooms.hall).toEqual(mergedRoom);
    expect(projection.conflictingUnitIds).toEqual([]);
    expect(projection.recovery.saveUnitsById['record:rooms:hall']?.patches).toEqual([
      { op: 'replace', path: '/rooms/hall/label', value: 'Mine' },
    ]);
  });

  it('publishes overlapping native paths with B/L/E values rather than performing a TS merge', () => {
    const local = structuredClone(original);
    local.rooms.hall!.label = 'Mine';
    const diskRoom = { ...baseRoom, label: 'Theirs' };
    const projection = projectNativeExternalResult({
      saved: original as JsonValue,
      working: local as JsonValue,
      recovery,
      result: result(diskRoom, local.rooms.hall, ['/label']),
    });
    expect(projection.conflictingUnitIds).toEqual(['record:rooms:hall']);
    expect((projection.saved as typeof original).rooms.hall!.label).toBe('Theirs');
    expect((projection.working as typeof original).rooms.hall!.label).toBe('Mine');
    expect(projection.recovery.saveUnitsById['record:rooms:hall']!.externalConflict).toMatchObject({
      conflictingPaths: ['/rooms/hall/label'],
      baseValueByPath: { '/rooms/hall/label': { exists: true, value: 'Hall' } },
      localValueByPath: { '/rooms/hall/label': { exists: true, value: 'Mine' } },
      externalValueByPath: { '/rooms/hall/label': { exists: true, value: 'Theirs' } },
      externalFileRevisions: { 'records/rooms/hall.yaml': `sha256:${'b'.repeat(64)}` },
    });
  });

  it('matches the independent legacy oracle for disjoint and overlapping owner edits', () => {
    const base = stripLocalEditorProjectState(structuredClone(original)) as JsonValue;
    for (const overlapping of [false, true]) {
      const local = structuredClone(base) as typeof original;
      local.rooms.hall!.label = 'Mine';
      const external = structuredClone(base) as typeof original;
      if (overlapping) external.rooms.hall!.label = 'Theirs';
      else external.rooms.hall!.description = 'External description';
      const nativeWorking = structuredClone(external);
      nativeWorking.rooms.hall!.label = 'Mine';
      const native = projectNativeExternalResult({
        saved: base,
        working: local as JsonValue,
        recovery,
        result: result(
          external.rooms.hall,
          nativeWorking.rooms.hall,
          overlapping ? ['/label'] : [],
        ),
      });
      const legacy = reconcileExternalProjectChange({
        baseDocument: base,
        localDocument: local as JsonValue,
        externalDocument: external as JsonValue,
        recovery,
        externalFileRevisions: { 'records/rooms/hall.yaml': `sha256:${'b'.repeat(64)}` },
      });
      expect(native.saved).toEqual(legacy.savedDocument);
      expect(native.working).toEqual(legacy.workingDocument);
      expect(native.conflictingUnitIds).toEqual(legacy.conflictingSaveUnitIds);
    }
  });

  it('projects a newly discovered native record and a native-owned removal', () => {
    const added = { ...baseRoom, id: 'new-room', label: 'New on Disk' };
    const incoming = result(added, added);
    incoming.affectedRecords = ['rooms/new-room'];
    incoming.snapshot.recordSnapshots = {
      'rooms/new-room': incoming.snapshot.recordSnapshots!['rooms/hall']!,
    };
    const created = projectNativeExternalResult({
      saved: original as JsonValue,
      working: original as JsonValue,
      recovery: { sequence: 0, saveUnitsById: {} },
      result: incoming,
    });
    expect((created.working as typeof original).rooms['new-room']).toEqual(added);
    incoming.snapshot.recordSnapshots = {};
    const removed = projectNativeExternalResult({
      saved: created.saved,
      working: created.working,
      recovery: created.recovery,
      result: incoming,
    });
    expect((removed.working as typeof original).rooms['new-room']).toBeUndefined();
    expect((removed.working as typeof original).rooms.hall).toEqual(baseRoom);
  });

  it('preserves unsaved changes as a whole-owner conflict when an external record is deleted', () => {
    const local = structuredClone(original);
    local.rooms.hall!.label = 'Mine';
    const deleted = result(null, local.rooms.hall, ['/']);
    deleted.snapshot.recordSnapshots!['rooms/hall']!.diskSourceRevision = 'absent';
    const projection = projectNativeExternalResult({
      saved: original as JsonValue,
      working: local as JsonValue,
      recovery,
      result: deleted,
    });
    expect((projection.saved as typeof original).rooms.hall).toBeUndefined();
    expect((projection.working as typeof original).rooms.hall!.label).toBe('Mine');
    expect(projection.conflictingUnitIds).toEqual(['record:rooms:hall']);
    expect(projection.recovery.saveUnitsById['record:rooms:hall']!.externalConflict).toMatchObject({
      conflictingPaths: ['/rooms/hall'],
      externalValueByPath: { '/rooms/hall': { exists: false } },
      externalFileRevisions: { 'records/rooms/hall.yaml': 'absent' },
    });
  });

  it('projects one localization file without clobbering independent localization files', () => {
    const localized = structuredClone(original);
    const key = Object.keys(localized.localization.messages)[0]!;
    const updated = {
      ...localized.localization.messages,
      [key]: { ...localized.localization.messages[key], source: 'Disk message' },
    };
    const incoming = result({ messages: updated }, { messages: updated });
    incoming.affectedRecords = ['i18n/messages.yaml'];
    incoming.snapshot.recordSnapshots = {
      'i18n/messages.yaml': incoming.snapshot.recordSnapshots!['rooms/hall']!,
    };
    const projection = projectNativeExternalResult({
      saved: original as JsonValue,
      working: original as JsonValue,
      recovery: { sequence: 0, saveUnitsById: {} },
      result: incoming,
    });
    expect((projection.working as typeof original).localization.messages).toEqual(updated);
    expect((projection.working as typeof original).localization.locales).toEqual(
      original.localization.locales,
    );
    expect((projection.working as typeof original).localization.defaultLocale).toBe(
      original.localization.defaultLocale,
    );
  });

  it('retains the editor local-state schema while adopting native editor.yaml metadata', () => {
    const saved = structuredClone(original);
    const unit = { tags: { records: { todo: { name: 'To do', color: '#000000' } } } };
    const incoming = result(unit, unit);
    incoming.affectedRecords = ['editor'];
    incoming.snapshot.recordSnapshots = {
      editor: incoming.snapshot.recordSnapshots!['rooms/hall']!,
    };
    // Preserve whichever schema marker the admitted stripped document has;
    // external editor.yaml cannot silently override local state identity.
    const admittedSchema = (stripLocalEditorProjectState(saved) as typeof saved).editor.schema;
    const projection = projectNativeExternalResult({
      saved: saved as JsonValue,
      working: saved as JsonValue,
      recovery: { sequence: 0, saveUnitsById: {} },
      result: incoming,
    });
    expect((projection.working as typeof saved).editor.schema).toBe(admittedSchema);
    expect((projection.working as typeof saved).editor.tags).toEqual(unit.tags);
  });
});
