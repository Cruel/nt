import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { deleteEntityRecordPreflight } from '@/project/entity-operations';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';

describe('Phase 1 current-behavior characterization', () => {
  it('pins ReferenceIndex output and delete preflight to the same usage records', () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'north',
        label: 'North',
        direction: 'north',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };

    const referenceIndex = buildReferenceIndex(project);
    const usages = findUsages(referenceIndex, { collection: 'rooms', id: 'hall' });
    expect(usages).toEqual([
      {
        sourceCollection: 'rooms',
        sourceId: 'foyer',
        path: '/rooms/foyer/data/exits/0/target/$ref',
        kind: 'explicit-ref',
        target: { collection: 'rooms', id: 'hall' },
      },
    ]);
    expect(
      deleteEntityRecordPreflight({ collection: 'rooms', id: 'hall' }, referenceIndex),
    ).toEqual({
      target: { collection: 'rooms', id: 'hall' },
      usages,
      canDeleteWithoutForce: false,
    });
  });

  it('pins the production Room cutover to the focused native document path', () => {
    const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
    const roomEditor = fs.readFileSync(
      path.resolve('src/renderer/editors/rooms/RoomEditor.tsx'),
      'utf8',
    );
    expect(widget).not.toContain('function buildRoomPreviewRml(data)');
    expect(widget).not.toContain('<title>Room Preview</title>');
    expect(widget).not.toContain("else if (kind === 'room-preview') applyPreviewRml");
    expect(roomEditor).toContain("root={{ kind: 'room-preview', recordId: roomId }}");
    expect(roomEditor).not.toContain('previewDocument={preview}');
    expect(roomEditor).not.toContain('roomPreviewRevision');
    expect(widget).toContain(
      "if (kind === 'layout-preview' || kind === 'shader-preview' || kind === 'room-preview')",
    );
    expect(widget).not.toContain("Module.ccall('noveltea_preview_show_editor_document'");
    expect(widget).toContain("Module.ccall('noveltea_preview_apply_editor_document'");
  });

  it('pushes semantic runtime debugger changes without preview interaction', () => {
    const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
    expect(widget).toContain('function publishRuntimeDebugSnapshotIfChanged()');
    expect(widget).toContain('window.setInterval(publishRuntimeDebugSnapshotIfChanged, 100)');
    expect(widget).toContain(
      "send({ version: protocolVersion, type: 'runtime-debug-snapshot', snapshot })",
    );
    expect(widget).toContain('currentRoomId: snapshot.currentRoomId');
    expect(widget).not.toContain('publication: snapshot.publication');
  });

  it('pins every current authoritative document replacement and patch route', () => {
    const projectStore = fs.readFileSync(
      path.resolve('src/renderer/project/project-store.ts'),
      'utf8',
    );
    expect(projectStore).toContain('loadProjectDocument:');
    expect(projectStore).toContain('loadUnsavedProjectDocument:');
    expect(projectStore).toContain('replaceDocumentFromCommand:');
    expect(projectStore).toContain('markEditorMetadataPersisted:');
    expect(projectStore).toContain('clearProject:');

    const commandStore = fs.readFileSync(
      path.resolve('src/renderer/commands/command-store.ts'),
      'utf8',
    );
    expect(commandStore).toContain(
      'executeCommandCore(busStateFromStores(get().history), request)',
    );
    expect(commandStore).toContain('undoCommandCore(busStateFromStores(get().history))');
    expect(commandStore).toContain('redoCommandCore(busStateFromStores(get().history))');
    expect(commandStore).toContain('cancelTransactionCore(busStateFromStores(get().history))');
    expect(commandStore).toContain('rollbackFailedStructuralPersistence(');
    expect(commandStore).toContain("kind: 'transaction-cancel'");
  });
});

describe('Phase 1 authoritative document route behavior', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('publishes command, transaction cancel, undo, and redo replacements through the project store', () => {
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { label: 'Foyer' } } },
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    const first = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      label: 'Rename',
      payload: { path: '/rooms/foyer/label', value: 'Hall' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(first.ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });

    useCommandStore.getState().beginTransaction({
      label: 'Temporary rename',
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    const step = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      label: 'Temporary rename',
      payload: { path: '/rooms/foyer/label', value: 'Temporary' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(step.ok).toBe(true);
    useCommandStore.getState().cancelTransaction();
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });

    expect(useCommandStore.getState().undo().ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Foyer' } },
    });
    expect(useCommandStore.getState().redo().ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });
  });
});
