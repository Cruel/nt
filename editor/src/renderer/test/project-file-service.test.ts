import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
const dialogs = vi.hoisted(() => ({ destination: '' }));
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dialogs.destination] }),
    showMessageBox: async () => ({ response: 1 }),
  },
}));
import {
  createProject,
  saveActiveProjectContent,
  saveProjectContent,
  saveProjectEditorMetadata,
  saveProjectCopyAs,
} from '../../main/services/project-file-service';
import { ActiveProjectWorkspaceSession } from '../../main/services/active-project-workspace-session';
import { filterExternallyChangedAuthoringPaths } from '../../main/services/project-workspace-watcher-service';
import { ProjectWorkspaceService, projectWorkspaceFiles } from '../../shared/project-workspace';
import {
  createNodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceFileSystem,
} from '../../shared/project-workspace/node-project-workspace-file-system';
import { NOVELTEA_PROJECT_AGENTS_BOOTSTRAP } from '../../shared/project-workspace/agent-bootstrap';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { ProjectContentSaveRequest } from '../../shared/editor-tooling';

const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-save-project-'));
  roots.push(root);
  return root;
}
function tempProjectRoot() {
  return path.join(tempRoot(), 'project');
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project-file-service workspace-v1', () => {
  it('creates the canonical segmented project root and ignored local namespace', async () => {
    const root = tempRoot();
    const projectDirectory = path.join(root, 'my-project');
    const result = await createProject({ projectName: 'My Project', projectDirectory });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'properties.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectDirectory, 'localization.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'editor.json'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDirectory, '.gitignore'), 'utf8')).toBe(
      '/.noveltea/\n/dist/\n',
    );
    expect(fs.readFileSync(path.join(projectDirectory, 'AGENTS.md'), 'utf8')).toBe(
      NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
    );
    expect(fs.existsSync(path.join(projectDirectory, 'records'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'assets'))).toBe(true);
  });

  it('creates projects in new spaced destinations and rejects every existing destination', async () => {
    const parent = tempRoot();
    const spaced = path.join(parent, 'my spaced project');
    expect(
      (await createProject({ projectName: 'Spaced Project', projectDirectory: spaced })).success,
    ).toBe(true);

    const empty = path.join(parent, 'empty-project');
    fs.mkdirSync(empty);
    const emptyRejected = await createProject({ projectName: 'Empty', projectDirectory: empty });
    expect(emptyRejected.success).toBe(false);
    expect(emptyRejected.error).toContain('already exists');

    const emptyTarget = path.join(parent, 'empty-target');
    const linked = path.join(parent, 'linked-project');
    fs.mkdirSync(emptyTarget);
    fs.symlinkSync(emptyTarget, linked, 'dir');
    const rejected = await createProject({ projectName: 'Linked', projectDirectory: linked });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('symbolic link');
    expect(fs.readdirSync(emptyTarget)).toEqual([]);
  });

  it('does not discover retired game.json projects', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'game.json'), '{}');
    const opened = await new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem()).open(
      root,
    );
    expect(opened.ok).toBe(false);
  });

  it('writes project content as segmented files and only changes affected files', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Save', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const beforeEditor = fs.readFileSync(path.join(root, 'editor.json'), 'utf8');
    const candidate = {
      ...opened.snapshot.project,
      project: { ...opened.snapshot.project.project, name: 'After' },
    };
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).project.name).toBe(
      'After',
    );
    expect(fs.readFileSync(path.join(root, 'editor.json'), 'utf8')).toBe(beforeEditor);
  });

  it('does not write project content when active-session authority is lost before commit', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Authority', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const before = fs.readFileSync(path.join(root, 'project.json'), 'utf8');
    const candidate = structuredClone(opened.snapshot.project);
    candidate.project.name = 'Must Not Commit';
    let authorityChecks = 0;

    const result = await saveProjectContent(
      root,
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      {},
      undefined,
      () => {
        authorityChecks += 1;
        if (authorityChecks > 1) throw new Error('Project session is stale or unknown.');
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project session is stale or unknown.');
    expect(authorityChecks).toBe(2);
    expect(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).toBe(before);
  });

  it('persists a scoped Room record save to its segmented record file', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Room Save', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const withRoom = structuredClone(initial.snapshot.project);
    withRoom.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Before',
      data: defaultRoomData('Hall'),
    };
    await service.write(
      root,
      initial.snapshot.workspaceRevision,
      withRoom,
      initial.editorState,
      {},
    );
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const candidate = structuredClone(opened.snapshot.project);
    candidate.rooms.hall!.description = 'After';

    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        saveUnitIds: ['record:rooms:hall'],
        baselineProject: opened.snapshot.project,
        operationLabel: 'save Room hall',
      },
    );

    expect(result.success).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'records/rooms/hall.json'), 'utf8')),
    ).toMatchObject({ description: 'After' });
  });

  it('round-trips scoped Trait and Room-owned Interactable Instance saves', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Trait Instance Save', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const seeded = structuredClone(initial.snapshot.project);
    seeded.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    seeded.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    await service.write(root, initial.snapshot.workspaceRevision, seeded, initial.editorState, {});

    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);

    const trait = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['interactable'] as const,
      properties: [],
    };
    const traitSaved = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['collection:traits'],
        affectedPaths: ['/traits/inspectable'],
        baseValueByPath: { '/traits/inspectable': { exists: false } },
        localValueByPath: { '/traits/inspectable': { exists: true, value: trait } },
        operationLabel: 'save Trait inspectable',
      },
      opened.editorState,
    );
    expect(traitSaved.success).toBe(true);

    const instance = defaultInteractableInstanceData('key-instance', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    const placement = {
      id: 'key-placement',
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      order: 0,
      presentation: { label: null, layout: null },
    };
    const occurrence = {
      id: 'key-instance',
      interactable: { $ref: { registry: 'interactableInstances' as const, id: 'key-instance' } },
      condition: { kind: 'always' as const },
      placementId: 'key-placement',
      visible: true,
      order: 0,
    };
    const roomSaved = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['record:rooms:foyer'],
        affectedPaths: [
          '/interactableInstances/key-instance',
          '/rooms/foyer/data/interactables',
          '/rooms/foyer/data/placements',
        ],
        baseValueByPath: {
          '/interactableInstances/key-instance': { exists: false },
          '/rooms/foyer/data/interactables': { exists: true, value: [] },
          '/rooms/foyer/data/placements': { exists: true, value: [] },
        },
        localValueByPath: {
          '/interactableInstances/key-instance': { exists: true, value: instance },
          '/rooms/foyer/data/interactables': { exists: true, value: [occurrence] },
          '/rooms/foyer/data/placements': { exists: true, value: [placement] },
        },
        operationLabel: 'place Interactable instance in Room',
      },
      traitSaved.editorState ?? opened.editorState,
    );
    expect(roomSaved.success).toBe(true);

    const reopened = await new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem()).open(
      root,
    );
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.snapshot.project.traits.inspectable).toEqual(trait);
    expect(reopened.snapshot.project.interactableInstances['key-instance']).toEqual(instance);
    expect(reopened.snapshot.project.rooms.foyer?.data.interactables).toEqual([occurrence]);
  });

  it('does not reopen or revision unrelated sources for one active scoped content save', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Fast Save', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(initial);
    const openSpy = vi.spyOn(ProjectWorkspaceService.prototype, 'open');
    const revisionSpy = vi.spyOn(NodeProjectWorkspaceFileSystem.prototype, 'readFileRevision');
    try {
      const result = await saveActiveProjectContent(
        session,
        {
          saveUnitIds: ['project:settings'],
          affectedPaths: ['/project/name'],
          baseValueByPath: {
            '/project/name': { exists: true, value: initial.snapshot.project.project.name },
          },
          localValueByPath: { '/project/name': { exists: true, value: 'Saved' } },
          operationLabel: 'save Project Settings',
        },
        initial.editorState,
      );

      expect(result.success).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();
      expect(revisionSpy).toHaveBeenCalled();
      expect(
        revisionSpy.mock.calls.map(([file]) => path.relative(root, file).replaceAll(path.sep, '/')),
      ).toEqual(expect.arrayContaining(['project.json']));
      expect(
        revisionSpy.mock.calls.every(
          ([file]) => path.relative(root, file).replaceAll(path.sep, '/') === 'project.json',
        ),
      ).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).project.name,
      ).toBe('Saved');
      expect(await filterExternallyChangedAuthoringPaths(session, ['project.json'])).toEqual([]);
    } finally {
      openSpy.mockRestore();
      revisionSpy.mockRestore();
    }
  });

  it('keeps active-session baselines coherent across two structural Room creates and reciprocal exit saves', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'New Room Navigation', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);

    for (const [roomId, label] of [
      ['foyer', 'Foyer'],
      ['hall', 'Hall'],
    ] as const) {
      const room = {
        id: roomId,
        label,
        archetype: null,
        archetypeOverrides: {},
        traits: [],
        localProperties: [],
        data: defaultRoomData(label),
      };
      const created = await saveActiveProjectContent(
        session,
        {
          saveUnitIds: ['workflow:new-entity'],
          affectedPaths: [`/rooms/${roomId}`],
          baseValueByPath: { [`/rooms/${roomId}`]: { exists: false } },
          localValueByPath: { [`/rooms/${roomId}`]: { exists: true, value: room } },
          operationLabel: `create Room ${roomId}`,
          structural: true,
        },
        session.editorState(),
      );
      expect(created.success).toBe(true);
    }

    const foyerBase = structuredClone(session.project().rooms.foyer!.data);
    const foyerLocal = structuredClone(foyerBase);
    foyerLocal.exits = [
      {
        id: 'to-hall',
        label: 'To Hall',
        direction: 'east',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    const foyerSaved = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['record:rooms:foyer'],
        affectedPaths: ['/rooms/foyer/data/exits'],
        baseValueByPath: { '/rooms/foyer/data/exits': { exists: true, value: foyerBase.exits } },
        localValueByPath: { '/rooms/foyer/data/exits': { exists: true, value: foyerLocal.exits } },
        operationLabel: 'save foyer exit',
      },
      session.editorState(),
    );
    expect(foyerSaved.success).toBe(true);

    const hallBase = structuredClone(session.project().rooms.hall!.data);
    const hallLocal = structuredClone(hallBase);
    hallLocal.exits = [
      {
        id: 'to-foyer',
        label: 'To Foyer',
        direction: 'west',
        target: roomRoomRef('foyer'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    const hallSaved = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['record:rooms:hall'],
        affectedPaths: ['/rooms/hall/data/exits'],
        baseValueByPath: { '/rooms/hall/data/exits': { exists: true, value: hallBase.exits } },
        localValueByPath: { '/rooms/hall/data/exits': { exists: true, value: hallLocal.exits } },
        operationLabel: 'save reciprocal hall exit',
      },
      session.editorState(),
    );
    expect(hallSaved.success).toBe(true);
    expect(session.project().rooms.foyer!.data.exits).toHaveLength(1);
    expect(session.project().rooms.hall!.data.exits).toHaveLength(1);
  });

  it('returns actual structural target revisions and advances a shared editor.json recovery baseline', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Structural recovery revision', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Hall',
      data: defaultRoomData('Hall'),
    };
    project.editor.recordMetadata.rooms = {
      hall: { tags: ['temporary'], color: null },
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, project.editor);
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    const editorRevisionBefore = opened.snapshot.fileRevisions['editor.json']!.contentHash;
    const editorState = structuredClone(opened.editorState);
    delete editorState.recordMetadata.rooms!.hall;
    editorState.recovery = {
      sequence: 1,
      saveUnitsById: {
        'project:tags': {
          sequence: 1,
          patches: [
            {
              op: 'add',
              path: '/editor/tags/records/local',
              value: { name: 'Local', color: '#123456' },
            },
          ],
          affectedPaths: ['/editor/tags'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
          baselineFileRevisions: { 'editor.json': editorRevisionBefore },
        },
      },
    };

    const result = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['structure:rooms'],
        affectedPaths: ['/rooms/hall', '/editor/recordMetadata/rooms/hall'],
        baseValueByPath: {
          '/rooms/hall': { exists: true, value: opened.snapshot.project.rooms.hall },
          '/editor/recordMetadata/rooms/hall': {
            exists: true,
            value: opened.snapshot.project.editor.recordMetadata.rooms!.hall,
          },
        },
        localValueByPath: {
          '/rooms/hall': { exists: false },
          '/editor/recordMetadata/rooms/hall': { exists: false },
        },
        recoveryFileOwnershipHints: { 'project:tags': ['editor.json'] },
        operationLabel: 'delete Room hall',
        structural: true,
      },
      editorState,
    );

    expect(result.success).toBe(true);
    const editorRevisionAfter = session.snapshot().fileRevisions['editor.json']!.contentHash;
    expect(editorRevisionAfter).not.toBe(editorRevisionBefore);
    expect(result.fileRevisions).toMatchObject({
      'editor.json': editorRevisionAfter,
      'records/rooms/hall.json': 'absent',
    });
    expect(
      result.editorState?.recovery.saveUnitsById['project:tags']?.baselineFileRevisions?.[
        'editor.json'
      ],
    ).toBe(editorRevisionAfter);
  });

  it('does not hash referenced binary assets while establishing a cold authoring snapshot', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Asset Hash Boundary', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.writeFileSync(path.join(root, 'assets/logo.bin'), Buffer.alloc(1024 * 1024, 7));
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState);

    const revisionSpy = vi.spyOn(NodeProjectWorkspaceFileSystem.prototype, 'readFileRevision');
    try {
      const opened = await new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem()).open(
        root,
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.snapshot.canonicalSourceFiles).not.toContain('assets/logo.bin');
      expect(
        revisionSpy.mock.calls.map(([file]) => path.relative(root, file).replaceAll(path.sep, '/')),
      ).not.toContain('assets/logo.bin');
    } finally {
      revisionSpy.mockRestore();
    }
  });

  it('blocks only mutations that own or depend on an invalid external authoring source', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Invalid source scope', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const kitchenData = defaultRoomData('Kitchen');
    kitchenData.exits = [
      {
        id: 'to-hall',
        label: 'Hall',
        direction: 'north',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
      },
    ];
    project.rooms.kitchen = {
      id: 'kitchen',
      label: 'Kitchen',
      description: 'Kitchen',
      data: kitchenData,
    };
    project.rooms.garden = {
      id: 'garden',
      label: 'Garden',
      description: 'Garden',
      data: defaultRoomData('Garden'),
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState);
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);

    fs.writeFileSync(path.join(root, 'records/rooms/hall.json'), '{ invalid json');
    expect((await session.reassemble(['records/rooms/hall.json'])).ok).toBe(false);
    expect(session.invalidAuthoringSources()).toEqual(['records/rooms/hall.json']);

    const gardenSave = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['record:rooms:garden'],
        affectedPaths: ['/rooms/garden/description'],
        baseValueByPath: { '/rooms/garden/description': { exists: true, value: 'Garden' } },
        localValueByPath: { '/rooms/garden/description': { exists: true, value: 'Saved garden' } },
        operationLabel: 'save unrelated Garden',
      },
      opened.editorState,
    );
    expect(gardenSave.success).toBe(true);

    const blockedRequests: ProjectContentSaveRequest[] = [
      {
        saveUnitIds: ['record:rooms:hall'],
        affectedPaths: ['/rooms/hall/description'],
        baseValueByPath: { '/rooms/hall/description': { exists: true as const, value: 'Hall' } },
        localValueByPath: {
          '/rooms/hall/description': { exists: true as const, value: 'Saved hall' },
        },
        operationLabel: 'save invalid Hall',
      },
      {
        saveUnitIds: ['record:rooms:kitchen'],
        affectedPaths: ['/rooms/kitchen/description'],
        baseValueByPath: {
          '/rooms/kitchen/description': { exists: true as const, value: 'Kitchen' },
        },
        localValueByPath: {
          '/rooms/kitchen/description': { exists: true as const, value: 'Saved kitchen' },
        },
        operationLabel: 'save Hall-dependent Kitchen',
      },
    ];
    for (const request of blockedRequests) {
      const blocked = await saveActiveProjectContent(session, request, opened.editorState);
      expect(blocked.success).toBe(false);
      expect(blocked.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'editor.content-save.invalid-source-dependency' }),
      );
    }
  });

  it('observes an externally deleted tracked source as absent and reassembles the deletion', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'External delete', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Hall',
      data: defaultRoomData('Hall'),
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState);
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    const relativePath = 'records/rooms/hall.json';

    fs.unlinkSync(path.join(root, relativePath));

    expect(await filterExternallyChangedAuthoringPaths(session, [relativePath])).toEqual([
      relativePath,
    ]);
    const reassembled = await session.reassemble([relativePath]);
    expect(reassembled.ok).toBe(true);
    expect(reassembled.ok && reassembled.snapshot.project.rooms.hall).toBeUndefined();
  });

  it('treats a watcher probe disappearing between inspect and hashing as absent', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Watcher unlink race', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    const inspectSpy = vi
      .spyOn(NodeProjectWorkspaceFileSystem.prototype, 'inspect')
      .mockResolvedValueOnce('file');
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const revisionSpy = vi
      .spyOn(NodeProjectWorkspaceFileSystem.prototype, 'readFileRevision')
      .mockRejectedValueOnce(missing);
    try {
      expect(await session.readFreshRevision('project.json')).toBe('absent');
    } finally {
      inspectSpy.mockRestore();
      revisionSpy.mockRestore();
    }
  });

  it('observes an externally deleted Asset source as absent despite the seeded file cache', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'External asset delete', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.writeFileSync(path.join(root, 'assets/logo.bin'), 'asset bytes');
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState);
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);

    fs.unlinkSync(path.join(root, 'assets/logo.bin'));

    expect(await session.observeAssetRevisions(['assets/logo.bin'])).toEqual({
      'assets/logo.bin': 'absent',
    });
  });

  it('reassembles an invalid source restored to the exact last coherent bytes', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Exact invalid recovery', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Hall',
      data: defaultRoomData('Hall'),
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState);
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    const relativePath = 'records/rooms/hall.json';
    const absolutePath = path.join(root, relativePath);
    const coherentBytes = fs.readFileSync(absolutePath, 'utf8');

    fs.writeFileSync(absolutePath, '{ invalid json');
    expect((await session.reassemble([relativePath])).ok).toBe(false);
    expect(session.invalidAuthoringSources()).toEqual([relativePath]);

    fs.writeFileSync(absolutePath, coherentBytes);
    expect(await filterExternallyChangedAuthoringPaths(session, [relativePath])).toEqual([
      relativePath,
    ]);
    expect((await session.reassemble([relativePath])).ok).toBe(true);
    expect(session.invalidAuthoringSources()).toEqual([]);
    expect(session.coherenceState()).toBe('coherent');
  });

  it('forces reassembly when a globally invalid session observes last-coherent bytes', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Global invalid same bytes', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    await session.captureAuthoringFileStamps();
    const openSpy = vi.spyOn(session.service(), 'open').mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ severity: 'error', path: '/project.json', message: 'forced failure' }],
    } as never);

    session.markResyncNeeded();
    const failed = await session.resynchronizeAuthoring();
    expect(failed.opened.ok).toBe(false);
    expect(session.invalidAuthoringSources()).toEqual(['*']);
    expect(session.coherenceState()).toBe('invalid');

    const knownRevision = session.knownFileRevision('project.json');
    expect(knownRevision).toBeDefined();
    expect(session.requiresAuthoringReassembly('project.json', knownRevision!)).toBe(true);

    openSpy.mockRestore();
    expect((await session.reassemble(['project.json'])).ok).toBe(true);
    expect(session.invalidAuthoringSources()).toEqual([]);
    expect(session.coherenceState()).toBe('coherent');
  });

  it('allows lifecycle resync to recover an already globally invalid session', async () => {
    const root = tempProjectRoot();
    await createProject({
      projectName: 'Global invalid lifecycle recovery',
      projectDirectory: root,
    });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    await session.captureAuthoringFileStamps();
    const openSpy = vi.spyOn(session.service(), 'open').mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ severity: 'error', path: '/project.json', message: 'forced failure' }],
    } as never);

    session.markResyncNeeded();
    expect((await session.resynchronizeAuthoring()).opened.ok).toBe(false);
    expect(session.invalidAuthoringSources()).toEqual(['*']);
    expect(session.coherenceState()).toBe('invalid');

    openSpy.mockRestore();
    session.markResyncNeeded();
    expect(session.coherenceState()).toBe('resync-needed');
    const recovered = await session.resynchronizeAuthoring();
    expect(recovered.opened.ok).toBe(true);
    expect(session.invalidAuthoringSources()).toEqual([]);
    expect(session.coherenceState()).toBe('coherent');
  });

  it('blocks all tracked mutations while project.json is invalid', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Invalid manifest scope', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    fs.writeFileSync(path.join(root, 'project.json'), '{ invalid json');
    expect((await session.reassemble(['project.json'])).ok).toBe(false);

    const result = await saveActiveProjectContent(
      session,
      {
        saveUnitIds: ['project:localization'],
        affectedPaths: ['/localization'],
        baseValueByPath: {
          '/localization': { exists: true, value: opened.snapshot.project.localization },
        },
        localValueByPath: {
          '/localization': { exists: true, value: opened.snapshot.project.localization },
        },
        operationLabel: 'save while manifest invalid',
      },
      opened.editorState,
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.content-save.invalid-source-dependency' }),
    );
  });

  it('recovers a real orphan transaction only when a pending journal exists', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Recovery Before', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);

    const openSpy = vi.spyOn(ProjectWorkspaceService.prototype, 'open');
    expect(await session.recoverPendingTransactions()).toEqual({
      recovered: false,
      changedPaths: [],
    });
    expect(openSpy).not.toHaveBeenCalled();

    const before = fs.readFileSync(path.join(root, 'project.json'), 'utf8');
    const parsed = JSON.parse(before) as { project: { name: string } };
    parsed.project.name = 'Recovery After';
    const after = `${JSON.stringify(parsed, null, 2)}\n`;
    const digest = (text: string) =>
      `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` as const;
    const transactionRoot = path.join(root, '.noveltea', 'transactions', 'interrupted');
    fs.mkdirSync(path.join(transactionRoot, 'before'), { recursive: true });
    fs.mkdirSync(path.join(transactionRoot, 'after'), { recursive: true });
    fs.writeFileSync(path.join(transactionRoot, 'before', '0'), before);
    fs.writeFileSync(path.join(transactionRoot, 'after', '0'), after);
    fs.writeFileSync(
      path.join(transactionRoot, 'manifest.json'),
      `${JSON.stringify(
        {
          schema: 'noveltea.workspace.transaction',
          schemaVersion: 1,
          transactionId: 'interrupted',
          state: 'committed',
          writerOwnerToken: 'crashed-owner',
          writerPid: 424242,
          operationLabel: 'interrupted test',
          targets: [
            {
              path: 'project.json',
              operation: 'write',
              beforeRevision: digest(before),
              afterRevision: digest(after),
              beforeBlob: 'before/0',
              afterBlob: 'after/0',
            },
          ],
          completedTargets: [],
        },
        null,
        2,
      )}\n`,
    );

    const recovered = await session.recoverPendingTransactions();
    expect(recovered.recovered).toBe(true);
    expect(recovered.changedPaths).toEqual(['project.json']);
    expect(recovered.opened?.ok && recovered.opened.snapshot.project.project.name).toBe(
      'Recovery After',
    );
    expect(fs.existsSync(transactionRoot)).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it('rediscovers a new authoring source after watcher trust is lost without invalidating known file contents', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Resync inventory', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = ActiveProjectWorkspaceSession.fromOpened(opened);
    await session.captureAuthoringFileStamps();

    const external = structuredClone(opened.snapshot.project);
    external.rooms.newroom = {
      id: 'newroom',
      label: 'New Room',
      description: 'Added while watcher trust was lost',
      data: defaultRoomData('New Room'),
    };
    const projected = projectWorkspaceFiles(
      external,
      external.editor,
      opened.snapshot.scriptSourcePaths,
    );
    fs.mkdirSync(path.join(root, 'records', 'rooms'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'records', 'rooms', 'newroom.json'),
      projected['records/rooms/newroom.json']!,
    );

    session.markResyncNeeded();
    const resync = await session.resynchronizeAuthoring();
    expect(resync.opened.ok).toBe(true);
    expect(resync.changedPaths).toContain('records/rooms/newroom.json');
    expect(resync.opened.ok && resync.opened.snapshot.project.rooms.newroom?.label).toBe(
      'New Room',
    );
    expect(session.coherenceState()).toBe('coherent');
  });

  it('fails closed instead of saving through a structurally unreadable external source', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Fail Closed', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const withRoom = structuredClone(initial.snapshot.project);
    withRoom.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    await service.write(
      root,
      initial.snapshot.workspaceRevision,
      withRoom,
      initial.editorState,
      {},
    );
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const projectPath = path.join(root, 'project.json');
    const roomPath = path.join(root, 'records/rooms/hall.json');
    const invalidRoom = JSON.parse(fs.readFileSync(roomPath, 'utf8')) as Record<string, unknown>;
    delete invalidRoom.data;
    fs.writeFileSync(roomPath, `${JSON.stringify(invalidRoom, null, 2)}\n`);
    const candidate = structuredClone(opened.snapshot.project);
    candidate.project.name = 'Should Not Save';

    const result = await saveProjectContent(
      projectPath,
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        saveUnitIds: ['project:settings'],
        baselineProject: opened.snapshot.project,
        affectedPaths: ['/project/name'],
        operationLabel: 'save project settings while Room source is invalid',
      },
    );

    expect(result.success).toBe(false);
    expect(JSON.parse(fs.readFileSync(projectPath, 'utf8')).project.name).toBe('Fail Closed');
  });

  it('merges a disjoint external edit in the same Room during a scoped save', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Room Merge', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const withRoom = structuredClone(initial.snapshot.project);
    withRoom.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      description: 'Before',
      data: defaultRoomData('Hall'),
    };
    await service.write(
      root,
      initial.snapshot.workspaceRevision,
      withRoom,
      initial.editorState,
      {},
    );
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const roomPath = path.join(root, 'records/rooms/hall.json');
    const external = JSON.parse(fs.readFileSync(roomPath, 'utf8')) as Record<string, unknown>;
    external.label = 'External Hall';
    fs.writeFileSync(roomPath, `${JSON.stringify(external, null, 2)}\n`);
    const candidate = structuredClone(opened.snapshot.project);
    candidate.rooms.hall!.description = 'Local description';

    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        saveUnitIds: ['record:rooms:hall'],
        baselineProject: opened.snapshot.project,
        affectedPaths: ['/rooms/hall/description'],
        operationLabel: 'save Room hall description',
      },
    );

    expect(result.success).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(roomPath, 'utf8')) as {
      label: string;
      description: string;
    };
    expect(persisted.label).toBe('External Hall');
    expect(persisted.description).toBe('Local description');
  });

  it('does not report a false external Room conflict after reopening tracked record metadata', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Room Metadata', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await service.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const withRoom = structuredClone(initial.snapshot.project);
    withRoom.rooms.bedroom = {
      id: 'bedroom',
      label: 'Bedroom',
      data: defaultRoomData('Bedroom'),
    };
    withRoom.editor.recordMetadata.rooms = {
      bedroom: { tags: [], color: null },
    };
    await service.write(root, initial.snapshot.workspaceRevision, withRoom, withRoom.editor, {});

    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const candidate = structuredClone(opened.snapshot.project);
    candidate.rooms.bedroom!.data.description.source = {
      kind: 'inline',
      text: 'Changed in editor',
    };
    const baselineProject = {
      ...(opened.contentProject as Record<string, unknown>),
      editor: opened.editorState,
    };
    const expectedFileRevisions = Object.fromEntries(
      Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
        file,
        revision.contentHash,
      ]),
    ) as Record<string, `sha256:${string}`>;

    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      {
        expectedFileRevisions,
        saveUnitIds: ['record:rooms:bedroom'],
        baselineProject,
        operationLabel: 'save Room bedroom',
      },
    );

    expect(result.success).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'records/rooms/bedroom.json'), 'utf8')).data
        .description.source.text,
    ).toBe('Changed in editor');
  });

  it('persists only local editor state outside tracked editor.json', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Metadata', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const state = {
      ...emptyEditorProjectState(),
      bottomPanel: { visible: false, activePanelId: 'problems' as const, sizePercent: 24 },
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:settings': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'Local' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
            externalConflict: {
              baseValueByPath: { '/project/name': { exists: true as const, value: 'Metadata' } },
              localValueByPath: { '/project/name': { exists: true as const, value: 'Local' } },
              externalValueByPath: { '/project/name': { exists: true as const, value: 'Disk' } },
              conflictingPaths: ['/project/name'],
              externalFileRevisions: {
                'project.json': opened.snapshot.fileRevisions['project.json']!.contentHash,
              },
            },
          },
        },
      },
    };
    const result = await saveProjectEditorMetadata(path.join(root, 'project.json'), state);
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8'))).toEqual({
      chapters: { assignments: {}, records: {} },
      recordMetadata: {},
      tags: { records: {} },
    });
    const persistedLocalState = JSON.parse(
      fs.readFileSync(path.join(root, '.noveltea/editor/state.json'), 'utf8'),
    );
    expect(persistedLocalState).not.toHaveProperty('workspaceRevision');
    expect(persistedLocalState).toMatchObject({
      schema: 'noveltea.editor.local-state',
      bottomPanel: { visible: false },
      recovery: {
        saveUnitsById: {
          'project:settings': {
            externalConflict: {
              conflictingPaths: ['/project/name'],
              localValueByPath: { '/project/name': { exists: true, value: 'Local' } },
              externalValueByPath: { '/project/name': { exists: true, value: 'Disk' } },
            },
          },
        },
      },
    });
    const reopened = await service.open(root);
    expect(reopened.ok).toBe(true);
    if (reopened.ok)
      expect(
        reopened.editorState.recovery.saveUnitsById['project:settings']?.externalConflict,
      ).toMatchObject({
        conflictingPaths: ['/project/name'],
        baseValueByPath: { '/project/name': { exists: true, value: 'Metadata' } },
      });
  });

  it('merges disjoint logical editor.json owners during a granular save', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Organization', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const external = JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8')) as {
      tags: { records: Record<string, unknown> };
    };
    external.tags.records.external = { name: 'External', color: '#123456' };
    fs.writeFileSync(path.join(root, 'editor.json'), `${JSON.stringify(external, null, 2)}\n`);
    const editorState = structuredClone(opened.editorState);
    editorState.chapters.records.story = { id: 'story', label: 'Story' };
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      opened.contentProject,
      editorState,
      {},
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        saveUnitIds: ['project:chapters'],
        baselineProject: opened.snapshot.project,
        operationLabel: 'save chapters',
      },
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8'))).toMatchObject({
      chapters: { records: { story: { label: 'Story' } } },
      tags: { records: { external: { name: 'External' } } },
    });

    const conflictingTags = structuredClone(opened.editorState);
    conflictingTags.tags.records.local = { name: 'Local', color: '#654321' };
    const conflictingResult = await saveProjectContent(
      path.join(root, 'project.json'),
      result.workspaceRevision!,
      opened.contentProject,
      conflictingTags,
      {},
      {
        expectedFileRevisions: result.fileRevisions!,
        saveUnitIds: ['project:tags'],
        baselineProject: opened.snapshot.project,
        operationLabel: 'save tags',
      },
    );
    expect(conflictingResult.success).toBe(false);
    expect(conflictingResult.diagnostics?.[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8'))).toMatchObject({
      tags: { records: { external: { name: 'External' } } },
    });
  });

  it('allows local editor-state persistence after an unrelated tracked-file change', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Conflict', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    fs.writeFileSync(
      path.join(root, 'project.json'),
      fs.readFileSync(path.join(root, 'project.json'), 'utf8').replace('Conflict', 'External'),
    );
    const openSpy = vi.spyOn(ProjectWorkspaceService.prototype, 'open');
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      emptyEditorProjectState(),
    );
    expect(result.success).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.noveltea/editor/state.json'), 'utf8')),
    ).not.toHaveProperty('workspaceRevision');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).project.name).toBe(
      'External',
    );
  });

  it('returns the stable revision-conflict diagnostic for an externally changed selected owner', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Conflict', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const external = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) as {
      project: { name: string };
    };
    external.project.name = 'External';
    fs.writeFileSync(path.join(root, 'project.json'), `${JSON.stringify(external, null, 2)}\n`);
    const candidate = structuredClone(opened.snapshot.project);
    candidate.project.name = 'Local';
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
      {},
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        saveUnitIds: ['project:settings'],
        baselineProject: opened.snapshot.project,
        affectedPaths: ['/project/name'],
        operationLabel: 'save project settings',
      },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics?.[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).project.name).toBe(
      'External',
    );
  });

  it('preserves a loaded Script Module source owner through production content save', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Script source', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.scripts.before = {
      id: 'before',
      label: 'Before',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return 1\n' } },
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState, {
      before: 'scripts/custom/entry.lua',
    });
    const loaded = await workspace.open(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const renamed = structuredClone(loaded.snapshot.project);
    renamed.scripts.after = { ...renamed.scripts.before!, id: 'after', label: 'After' };
    delete renamed.scripts.before;
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      loaded.snapshot.workspaceRevision,
      renamed,
      loaded.editorState,
      { after: 'scripts/custom/entry.lua' },
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'records/scripts/after.json'), 'utf8')).toContain(
      'scripts/custom/entry.lua',
    );
    expect(fs.readFileSync(path.join(root, 'scripts/custom/entry.lua'), 'utf8')).toBe('return 1\n');
  });

  it('commits asset trash and restore with structural source changes in one transaction', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Asset transaction', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const withAsset = structuredClone(initial.snapshot.project);
    withAsset.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.writeFileSync(path.join(root, 'assets/logo.bin'), 'asset bytes');
    await workspace.write(root, initial.snapshot.workspaceRevision, withAsset, initial.editorState);
    const beforeDelete = await workspace.open(root);
    expect(beforeDelete.ok).toBe(true);
    if (!beforeDelete.ok) return;
    const deleted = structuredClone(beforeDelete.snapshot.project);
    delete deleted.assets.logo;
    const deletedResult = await saveProjectContent(
      path.join(root, 'project.json'),
      beforeDelete.snapshot.workspaceRevision,
      deleted,
      beforeDelete.editorState,
      {},
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(beforeDelete.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        structural: true,
        baselineProject: beforeDelete.snapshot.project,
        affectedPaths: ['/assets/logo'],
        operationLabel: 'delete Asset logo',
        assetTransition: { kind: 'trash', projectRelativePaths: ['assets/logo.bin'] },
      },
    );
    expect(deletedResult.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'records/assets/logo.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'assets/logo.bin'))).toBe(false);
    const move = deletedResult.assetTrashMoves?.[0];
    expect(move).toBeDefined();
    expect(fs.readFileSync(path.join(root, move!.trashRelativePath), 'utf8')).toBe('asset bytes');

    const beforeRestore = await workspace.open(root);
    expect(beforeRestore.ok).toBe(true);
    if (!beforeRestore.ok) return;
    const restoredResult = await saveProjectContent(
      path.join(root, 'project.json'),
      beforeRestore.snapshot.workspaceRevision,
      withAsset,
      beforeRestore.editorState,
      {},
      {
        expectedFileRevisions: Object.fromEntries(
          Object.entries(beforeRestore.snapshot.fileRevisions).map(([file, revision]) => [
            file,
            revision.contentHash,
          ]),
        ),
        structural: true,
        baselineProject: beforeRestore.snapshot.project,
        affectedPaths: ['/assets/logo'],
        operationLabel: 'restore Asset logo',
        assetTransition: { kind: 'restore', moves: [move!] },
      },
    );
    expect(restoredResult.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'assets/logo.bin'), 'utf8')).toBe('asset bytes');
    expect(fs.existsSync(path.join(root, move!.trashRelativePath))).toBe(false);
    expect(fs.existsSync(path.join(root, 'records/assets/logo.json'))).toBe(true);
  });

  it('rejects a local-state symlink escape instead of writing through it', async () => {
    const root = tempProjectRoot();
    const outside = tempRoot();
    await createProject({ projectName: 'Contained', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    fs.mkdirSync(path.join(root, '.noveltea', 'editor'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.noveltea', 'editor', 'escape'));
    const state = emptyEditorProjectState();
    const result = await saveProjectEditorMetadata(path.join(root, 'project.json'), state);
    expect(result.success).toBe(true);
    fs.rmSync(path.join(root, '.noveltea', 'editor'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, '.noveltea', 'editor'));
    const rejected = await saveProjectEditorMetadata(path.join(root, 'project.json'), state);
    expect(rejected.success).toBe(false);
    expect(fs.existsSync(path.join(outside, 'state.json'))).toBe(false);
  });

  it('does not persist editor metadata after active-session authority is revoked', async () => {
    const root = tempProjectRoot();
    await createProject({ projectName: 'Metadata authority', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStatePath = path.join(root, '.noveltea/editor/state.json');
    const before = fs.existsSync(localStatePath) ? fs.readFileSync(localStatePath, 'utf8') : null;

    const result = await saveProjectEditorMetadata(root, emptyEditorProjectState(), () => {
      throw new Error('Project session is stale or unknown.');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project session is stale or unknown.');
    expect(fs.existsSync(localStatePath) ? fs.readFileSync(localStatePath, 'utf8') : null).toBe(
      before,
    );
  });

  it('preserves user-owned AGENTS.md and unrelated .gitignore content through Save As', async () => {
    const source = tempProjectRoot();
    const destination = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    fs.writeFileSync(
      path.join(source, 'AGENTS.md'),
      `${NOVELTEA_PROJECT_AGENTS_BOOTSTRAP}\n# Team Rules\n\nKeep authored copy concise.\n`,
    );
    fs.writeFileSync(path.join(destination, '.gitignore'), 'custom-output/\n');
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    dialogs.destination = destination;
    const result = await saveProjectCopyAs({} as never, source, opened.snapshot.project, []);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'AGENTS.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(destination, '.gitignore'), 'utf8')).toBe('custom-output/\n');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'AGENT_LOCAL_STATE_NOT_IGNORED',
        severity: 'warning',
        path: '/.gitignore',
      }),
    );
  });

  it('does not write a Save As destination after active-session authority is revoked', async () => {
    const source = tempProjectRoot();
    const destination = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    dialogs.destination = destination;

    const result = await saveProjectCopyAs(
      {} as never,
      source,
      opened.snapshot.project,
      [],
      {},
      () => {
        throw new Error('Project session is stale or unknown.');
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project session is stale or unknown.');
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('rejects Save As destinations containing stale canonical project source', async () => {
    const source = tempProjectRoot();
    const destination = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    fs.mkdirSync(path.join(destination, 'records', 'rooms'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'records', 'layouts', 'old-layout'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'records', 'rooms', 'old-room.json'), '{}\n');
    fs.writeFileSync(
      path.join(destination, 'records', 'layouts', 'old-layout', 'layout.json'),
      '{}\n',
    );
    fs.writeFileSync(path.join(destination, 'scripts', 'old.lua'), 'return 1\n');
    fs.writeFileSync(path.join(destination, 'README.md'), 'keep me\n');
    dialogs.destination = destination;

    const result = await saveProjectCopyAs({} as never, source, opened.snapshot.project, []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('already contains NovelTea project state');
    expect(fs.existsSync(path.join(destination, 'project.json'))).toBe(false);
    expect(
      fs.readFileSync(path.join(destination, 'records', 'rooms', 'old-room.json'), 'utf8'),
    ).toBe('{}\n');
    expect(fs.readFileSync(path.join(destination, 'scripts', 'old.lua'), 'utf8')).toBe(
      'return 1\n',
    );
    expect(fs.readFileSync(path.join(destination, 'README.md'), 'utf8')).toBe('keep me\n');
  });

  it('rejects Save As when an exact destination asset path is already occupied', async () => {
    const source = tempProjectRoot();
    const destination = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const project = structuredClone(opened.snapshot.project);
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(source, 'assets', 'logo.bin'), 'source-bytes');
    fs.mkdirSync(path.join(destination, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'assets', 'logo.bin'), 'destination-bytes');
    fs.writeFileSync(path.join(destination, 'README.md'), 'keep me\n');
    dialogs.destination = destination;

    const result = await saveProjectCopyAs({} as never, source, project, []);

    expect(result.success).toBe(false);
    expect(result.error).toContain("asset destination 'assets/logo.bin' already exists");
    expect(fs.readFileSync(path.join(destination, 'assets', 'logo.bin'), 'utf8')).toBe(
      'destination-bytes',
    );
    expect(fs.existsSync(path.join(destination, 'project.json'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'README.md'), 'utf8')).toBe('keep me\n');
  });

  it.each([
    ['projected records', 'records'],
    ['local state', '.noveltea'],
    ['copied assets', 'assets'],
    ['copied workflows', 'workflows'],
  ])('rejects Save As %s symlink escapes', async (_label, escapedDirectory) => {
    const source = tempProjectRoot();
    const destination = tempRoot();
    const outside = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const project = structuredClone(opened.snapshot.project);
    project.scripts.script = {
      id: 'script',
      label: 'Script',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return 1\n' } },
    };
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/image.png' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(source, 'assets/image.png'), 'image');
    await workspace.write(source, opened.snapshot.workspaceRevision, project, opened.editorState);
    fs.mkdirSync(path.join(source, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(source, 'workflows', 'sample.json'), '{}');
    fs.symlinkSync(outside, path.join(destination, escapedDirectory));
    dialogs.destination = destination;
    const result = await saveProjectCopyAs({} as never, source, project, []);
    expect(result.success).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
