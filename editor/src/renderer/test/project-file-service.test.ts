import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  saveProjectContent,
  saveProjectEditorMetadata,
  saveProjectCopyAs,
} from '../../main/services/project-file-service';
import { ProjectWorkspaceService } from '../../shared/project-workspace';
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { NOVELTEA_PROJECT_AGENTS_BOOTSTRAP } from '../../shared/project-workspace/agent-bootstrap';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

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
    expect(fs.existsSync(path.join(projectDirectory, 'properties.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'localization.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'editor.json'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDirectory, '.gitignore'), 'utf8')).toBe(
      '/.noveltea/\n',
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
              externalWorkspaceRevision: opened.snapshot.workspaceRevision,
              externalFileRevisions: {
                'project.json': opened.snapshot.fileRevisions['project.json']!.contentHash,
              },
            },
          },
        },
      },
    };
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      state,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8'))).toEqual({
      chapters: { assignments: {}, records: {} },
      recordMetadata: {},
      tags: { records: {} },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.noveltea/editor/state.json'), 'utf8')),
    ).toMatchObject({
      schema: 'noveltea.editor.local-state',
      schemaVersion: 2,
      workspaceRevision: result.workspaceRevision,
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
    const expectedFileRevisions = Object.fromEntries(
      Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
        file,
        revision.contentHash,
      ]),
    ) as Record<string, `sha256:${string}`>;
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      emptyEditorProjectState(),
      expectedFileRevisions,
    );
    expect(result.success).toBe(true);
    expect(result.workspaceRevision).toBe(opened.snapshot.workspaceRevision);
    expect(result.fileRevisions).toEqual(expectedFileRevisions);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.noveltea/editor/state.json'), 'utf8'))
        .workspaceRevision,
    ).toBe(opened.snapshot.workspaceRevision);
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
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      state,
    );
    expect(result.success).toBe(true);
    fs.rmSync(path.join(root, '.noveltea', 'editor'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, '.noveltea', 'editor'));
    const rejected = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      result.workspaceRevision!,
      state,
    );
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

    const result = await saveProjectEditorMetadata(
      root,
      opened.snapshot.workspaceRevision,
      emptyEditorProjectState(),
      {},
      () => {
        throw new Error('Project session is stale or unknown.');
      },
    );

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
