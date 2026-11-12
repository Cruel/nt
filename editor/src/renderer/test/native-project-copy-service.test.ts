import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dialogState = vi.hoisted(() => ({ destination: '', confirmed: true }));
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dialogState.destination] }),
    showMessageBox: async () => ({ response: dialogState.confirmed ? 1 : 0 }),
  },
}));
import { saveNativeProjectCopyAs } from '../../main/services/native-project-copy-service';
import { NativeDirtyCheckpointStore } from '../../main/services/native-dirty-checkpoint-store';
import type { NativeDirtyCheckpoint } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { openNativeEditorProject } from '../../main/services/native-editor-project-open';
import { NATIVE_FIELD_DRAFT_SCHEMA, nativeFieldDraftKey } from '../commands/native-field-drafts';

const roots: string[] = [];
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'nt-native-copy-'));
  roots.push(parent);
  const source = path.join(parent, 'source');
  const destination = path.join(parent, 'destination');
  await mkdir(path.join(source, 'records', 'rooms'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(path.join(source, '.noveltea', 'transactions'), { recursive: true });
  await mkdir(destination);
  await writeFile(
    path.join(source, 'project.yaml'),
    'project: \n  id: original # native comment\n',
  );
  await writeFile(path.join(source, 'records', 'rooms', 'main.yaml'), 'id: main # keep\n');
  await writeFile(path.join(source, 'scripts', 'game.lua'), '-- source\n');
  await writeFile(path.join(source, '.noveltea', 'transactions', 'stale.json'), 'LOCAL');
  dialogState.destination = destination;
  dialogState.confirmed = true;
  return { source, destination };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native saved Project Copy As', () => {
  it.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
    'copies two native dirty owners and an unacknowledged field while preserving the original Project',
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'nt-native-copy-mixed-608-'));
      roots.push(parent);
      const source = path.join(parent, 'source');
      const destination = path.join(parent, 'destination');
      await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), source, {
        recursive: true,
        filter: (entry) => !entry.split(path.sep).includes('.noveltea'),
      });
      await mkdir(destination);
      dialogState.destination = destination;
      const originalRoom = path.join(source, 'records/rooms/active-text.yaml');
      const originalScene = path.join(source, 'records/scenes/background-stories.yaml');
      const luaPath = 'scripts/notice-board.lua';
      const originalLua = path.join(source, luaPath);
      const beforeRoom = await readFile(originalRoom, 'utf8');
      const beforeScene = await readFile(originalScene, 'utf8');
      const beforeLua = await readFile(originalLua, 'utf8');
      const changedLua = beforeLua + '\n-- staged only in native recovery\n';
      const sessions = new ActiveProjectSessionService();
      const makeController = () => {
        const bridge = new NativeAuthoringSessionBridge(sessions, {
          addonPath: process.env.NOVELTEA_AUTHORING_NODE_ADDON!,
          workerScript: path.resolve(
            process.cwd(),
            'dist-electron/authoring-worker/native-authoring-worker.cjs',
          ),
          pollIntervalMs: 100,
        });
        sessions.setNativeSourceRevisionFor(
          (bytes) => bridge.sourceRevision(bytes) as `xxh3-128:${string}`,
        );
        return new NativeEditorSessionController(
          sessions,
          bridge,
          new NativeAuthoringWorkingProject(bridge),
        );
      };
      let controller = makeController();
      try {
        const opened = await openNativeEditorProject(
          source,
          sessions.beginProjectActivation(),
          sessions,
          controller,
        );
        expect(opened.success, opened.error).toBe(true);
        const id = opened.projectSessionId!;
        const room = await controller.applyRevisionedPatches(id, opened.nativeWorkingRevision!, [
          {
            op: 'replace',
            path: '/rooms/active-text/data/displayName',
            value: 'Original dirty Room',
          },
        ]);
        expect(room.accepted, room.error).toBe(true);
        const scene = await controller.applyRevisionedPatches(id, room.snapshot.workingRevision, [
          {
            op: 'replace',
            path: '/scenes/background-stories/data/displayName',
            value: 'Original dirty Scene',
          },
        ]);
        expect(scene.accepted, scene.error).toBe(true);
        const stagedSource = await controller.stageText(
          id,
          scene.snapshot.workingRevision,
          luaPath,
          controller.sourceRevisionFor()!(Buffer.from(beforeLua)),
          changedLua,
        );
        expect(stagedSource.accepted, stagedSource.error).toBe(true);
        const draftKey = nativeFieldDraftKey(
          'record:rooms:active-text',
          '/rooms/active-text/data/displayName',
        );
        const pendingField = {
          tabId: 'closed-other-view',
          schema: NATIVE_FIELD_DRAFT_SCHEMA,
          payload: {
            value: 'Unacknowledged draft',
            base: {
              revision: stagedSource.snapshot.workingRevision,
              exists: true,
              value: 'Original dirty Room',
            },
          },
        };
        const pendingNumberKey = nativeFieldDraftKey(
          'record:rooms:active-text',
          '/rooms/active-text/data/presentationSpace/size/width',
        );
        const pendingNumber = {
          tabId: 'closed-number-view',
          schema: NATIVE_FIELD_DRAFT_SCHEMA,
          payload: {
            value: '-',
            base: {
              revision: stagedSource.snapshot.workingRevision,
              exists: true,
              value: 1920,
            },
          },
        };
        const editor = {
          ...opened.editorState,
          draftsByKey: {
            ...opened.editorState?.draftsByKey,
            [draftKey]: pendingField,
            [pendingNumberKey]: pendingNumber,
          },
        };
        const copied = await saveNativeProjectCopyAs(
          {} as never,
          source,
          { editor },
          () => controller.verifySavedCopySources(id),
          () => controller.copyRecovery(id),
        );
        expect(copied.success, copied.error).toBe(true);
        expect(controller.isAdmitted(id)).toBe(true);
        expect(await readFile(originalRoom, 'utf8')).toBe(beforeRoom);
        expect(await readFile(originalScene, 'utf8')).toBe(beforeScene);
        expect(await readFile(originalLua, 'utf8')).toBe(beforeLua);
        expect(
          await readFile(path.join(destination, 'records/rooms/active-text.yaml'), 'utf8'),
        ).toBe(beforeRoom);
        expect(
          await readFile(path.join(destination, 'records/scenes/background-stories.yaml'), 'utf8'),
        ).toBe(beforeScene);
        expect(await readFile(path.join(destination, luaPath), 'utf8')).toBe(beforeLua);

        controller.dispose();
        sessions.closeActiveProject();
        controller = makeController();
        const copyOpen = await openNativeEditorProject(
          destination,
          sessions.beginProjectActivation(),
          sessions,
          controller,
        );
        expect(copyOpen.success, copyOpen.error).toBe(true);
        expect(copyOpen.nativeRecoveredContentProject).toMatchObject({
          rooms: { 'active-text': { data: { displayName: 'Original dirty Room' } } },
          scenes: { 'background-stories': { data: { displayName: 'Original dirty Scene' } } },
        });
        expect(copyOpen.editorState?.draftsByKey?.[draftKey]).toMatchObject({
          payload: { value: 'Unacknowledged draft' },
        });
        expect(copyOpen.editorState?.draftsByKey?.[pendingNumberKey]).toMatchObject({
          payload: { value: '-' },
        });
        expect(controller.recoveredTextSources()[luaPath]?.text).toBe(changedLua);
        const savedInCopy = await controller.saveUnit(
          copyOpen.projectSessionId!,
          copyOpen.nativeWorkingRevision!,
          'record:scenes:background-stories',
          {},
        );
        expect(savedInCopy.accepted, savedInCopy.error).toBe(true);
        expect(
          await readFile(path.join(destination, 'records/scenes/background-stories.yaml'), 'utf8'),
        ).toContain('Original dirty Scene');
        expect(await readFile(originalScene, 'utf8')).toBe(beforeScene);
        expect(controller.recoveredTextSources()[luaPath]?.text).toBe(changedLua);
        expect(await readFile(originalLua, 'utf8')).toBe(beforeLua);

        controller.dispose();
        sessions.closeActiveProject();
        controller = makeController();
        const sourceOpen = await openNativeEditorProject(
          source,
          sessions.beginProjectActivation(),
          sessions,
          controller,
        );
        expect(sourceOpen.success, sourceOpen.error).toBe(true);
        expect(sourceOpen.nativeRecoveredContentProject).toMatchObject({
          rooms: { 'active-text': { data: { displayName: 'Original dirty Room' } } },
          scenes: { 'background-stories': { data: { displayName: 'Original dirty Scene' } } },
        });
        expect(await readFile(originalRoom, 'utf8')).toBe(beforeRoom);
        expect(await readFile(originalScene, 'utf8')).toBe(beforeScene);
      } finally {
        controller.dispose();
        sessions.dispose();
      }
    },
    120_000,
  );

  it.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
    'reopens a copy of a dirty native Project with its acknowledged edits still unsaved',
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'nt-native-copy-reopen-'));
      roots.push(parent);
      const source = path.join(parent, 'source');
      const destination = path.join(parent, 'destination');
      await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), source, {
        recursive: true,
        filter: (entry) => !entry.split(path.sep).includes('.noveltea'),
      });
      await mkdir(destination);
      dialogState.destination = destination;
      const sessions = new ActiveProjectSessionService();
      const makeController = () => {
        const bridge = new NativeAuthoringSessionBridge(sessions, {
          addonPath: process.env.NOVELTEA_AUTHORING_NODE_ADDON!,
          workerScript: path.resolve(
            process.cwd(),
            'dist-electron/authoring-worker/native-authoring-worker.cjs',
          ),
          pollIntervalMs: 100,
        });
        return new NativeEditorSessionController(
          sessions,
          bridge,
          new NativeAuthoringWorkingProject(bridge),
        );
      };
      let controller = makeController();
      try {
        const opened = await openNativeEditorProject(
          source,
          sessions.beginProjectActivation(),
          sessions,
          controller,
        );
        expect(opened.success, opened.error).toBe(true);
        const id = opened.projectSessionId!;
        const patched = await controller.applyRevisionedPatches(id, opened.nativeWorkingRevision!, [
          { op: 'replace', path: '/project/name', value: 'Dirty copied Project' },
        ]);
        expect(patched.accepted, patched.error).toBe(true);
        const copied = await saveNativeProjectCopyAs(
          {} as never,
          source,
          { editor: opened.editorState },
          () => controller.verifySavedCopySources(id),
          () => controller.copyRecovery(id),
        );
        expect(copied.success, copied.error).toBe(true);
        expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).not.toContain(
          'Dirty copied Project',
        );
        controller.dispose();
        sessions.closeActiveProject();
        controller = makeController();
        const reopened = await openNativeEditorProject(
          destination,
          sessions.beginProjectActivation(),
          sessions,
          controller,
        );
        expect(reopened.success, reopened.error).toBe(true);
        expect(reopened.nativeRecoveredContentProject).toMatchObject({
          project: { name: 'Dirty copied Project' },
        });
        expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).not.toContain(
          'Dirty copied Project',
        );
      } finally {
        controller.dispose();
        sessions.dispose();
      }
    },
    120_000,
  );

  it('copies the native unsaved recovery journal with the destination identity', async () => {
    const { source, destination } = await fixture();
    const checkpoint: NativeDirtyCheckpoint = {
      batches: [
        {
          patches: [{ operation: 'replace', path: '/project/name', value: 'Unsaved copy' }],
          diskPreconditions: { project: `xxh3-128:${'a'.repeat(32)}` },
        },
      ],
      textSources: {},
      conflicts: {},
      pendingFields: {},
    };
    const recovery = () => ({ projectId: 'original', revision: 1, checkpoint });
    const response = await saveNativeProjectCopyAs(
      {} as never,
      source,
      { editor: {} },
      async () => undefined,
      recovery,
    );
    expect(response.success, response.error).toBe(true);
    expect(await new NativeDirtyCheckpointStore().read(destination, 'original')).toEqual(
      checkpoint,
    );
    await expect(new NativeDirtyCheckpointStore().read(source, 'original')).resolves.toBeNull();
    expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).not.toContain(
      'Unsaved copy',
    );
    const persisted = JSON.parse(
      await readFile(path.join(destination, '.noveltea/editor/native-dirty-state.json'), 'utf8'),
    );
    expect(persisted.projectRoot).toBe(destination);
  });

  it('refuses to publish a recovery journal if the native generation changes during copying', async () => {
    const { source, destination } = await fixture();
    let revision = 1;
    const response = await saveNativeProjectCopyAs(
      {} as never,
      source,
      {},
      async () => undefined,
      () => ({
        projectId: 'original',
        revision: revision++,
        checkpoint: { batches: [], textSources: {}, conflicts: {}, pendingFields: {} },
      }),
    );
    expect(response.success).toBe(false);
    expect(response.error).toContain('changed during Project Copy');
    expect(await readdir(destination)).toEqual([]);
  });

  it('copies byte-exact saved YAML and sources, never reserializing renderer Project content', async () => {
    const { source, destination } = await fixture();
    const archivedLayout = '.noveltea/trash/layouts/deleted-layout/layout.rml';
    await mkdir(path.dirname(path.join(source, archivedLayout)), { recursive: true });
    await writeFile(path.join(source, archivedLayout), '<rml>Recover me</rml>');
    const verify = vi.fn().mockResolvedValue(undefined);
    const response = await saveNativeProjectCopyAs(
      {} as never,
      source,
      { project: { id: 'malicious-renderer-content' }, editor: {} },
      verify,
    );
    expect(response.success).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).toBe(
      'project: \n  id: original # native comment\n',
    );
    expect(await readFile(path.join(destination, 'records', 'rooms', 'main.yaml'), 'utf8')).toBe(
      'id: main # keep\n',
    );
    expect(await readFile(path.join(destination, 'scripts', 'game.lua'), 'utf8')).toBe(
      '-- source\n',
    );
    // A later native Undo can require the archived bytes. Transaction journals
    // and other local .noveltea state must not be transplanted with the copy.
    expect(await readFile(path.join(destination, archivedLayout), 'utf8')).toBe(
      '<rml>Recover me</rml>',
    );
    await expect(
      readFile(path.join(destination, '.noveltea', 'transactions', 'stale.json')),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(destination, '.noveltea', 'editor', 'state.json'), 'utf8'),
    ).toContain('recovery');
  });

  it('leaves the destination unchanged on a stale native source verification', async () => {
    const { source, destination } = await fixture();
    let checks = 0;
    const result = await saveNativeProjectCopyAs({} as never, source, {}, async () => {
      if (++checks === 2) throw new Error('WORKSPACE_REVISION_CONFLICT');
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('WORKSPACE_REVISION_CONFLICT');
    expect(await readdir(destination)).toEqual([]);
  });

  it('preserves unrelated destination files and refuses linked sources', async () => {
    const { source, destination } = await fixture();
    await writeFile(path.join(destination, 'notes.txt'), 'KEEP');
    const result = await saveNativeProjectCopyAs({} as never, source, {}, async () => undefined);
    expect(result.success, result.error).toBe(true);
    expect(await readFile(path.join(destination, 'notes.txt'), 'utf8')).toBe('KEEP');
    const second = await fixture();
    await symlink(
      path.join(second.source, 'project.yaml'),
      path.join(second.source, 'outside.yaml'),
    );
    const refused = await saveNativeProjectCopyAs(
      {} as never,
      second.source,
      {},
      async () => undefined,
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('symbolic link');
    expect(await readdir(second.destination)).toEqual([]);
  });
});
