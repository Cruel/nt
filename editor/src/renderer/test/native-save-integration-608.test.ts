import { describe, expect, it, vi } from 'vite-plus/test';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { openNativeEditorProject } from '../../main/services/native-editor-project-open';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { Worker, type WorkerOptions } from 'node:worker_threads';

const addonPath = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
const featureLab = path.resolve(process.cwd(), '../tests/projects/feature-lab');
const roomA = 'active-text';
const roomB = 'background-stories';

async function disposableProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-save-integration-608-'));
  await cp(featureLab, root, {
    recursive: true,
    filter: (candidate) => !candidate.split(path.sep).includes('.noveltea'),
  });
  return root;
}

function nativeHarness(sessions: ActiveProjectSessionService) {
  const bridge = new NativeAuthoringSessionBridge(sessions, {
    addonPath: addonPath!,
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
}

async function admit(
  root: string,
  sessions: ActiveProjectSessionService,
  controller: NativeEditorSessionController,
) {
  const generation = sessions.beginProjectActivation();
  const id = await sessions.stageNativeProjectFile(path.join(root, 'project.yaml'), generation);
  const result = await controller.admitFromNative(id);
  await sessions.acceptNativeProject(id, result.savedProject);
  sessions.commitStagedNativeProject(id, generation);
  return {
    id,
    revision: result.revision,
    sourceRevisions: result.sourceRevisions,
    diagnostics: result.diagnostics,
  };
}

async function roomBytes(root: string, id: string) {
  return readFile(path.join(root, `records/rooms/${id}.yaml`), 'utf8');
}

async function removeDisposableProject(root: string) {
  // Cache publication can outlive worker disposal by one filesystem rename.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe.skipIf(!addonPath)('#608 real native Save and recovery integration', () => {
  it('admits, edits, persists and reopens an invalid record through the actual native editor', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-repair-record-615-'));
    const fixture = path.resolve(
      process.cwd(),
      'src/renderer/test/fixtures/project-compiler-cli/minimal-project',
    );
    await cp(fixture, root, {
      recursive: true,
      filter: (candidate) => !candidate.split(path.sep).includes('.noveltea'),
    });
    const invalidPath = 'records/rooms/unrelated.yaml';
    const roomFile = path.join(root, invalidPath);
    const original = await readFile(roomFile, 'utf8');
    const malformed = '# native repair\nid: unrelated\ndata: [\n';
    await writeFile(roomFile, malformed);
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const hash = controller.sourceRevisionFor();
      expect(hash).toBeDefined();
      sessions.setNativeSourceRevisionFor((bytes) => hash!(bytes) as `xxh3-128:${string}`);
      const opened = await openNativeEditorProject(
        root,
        sessions.beginProjectActivation(),
        sessions,
        controller,
      );
      expect(opened.success, opened.error).toBe(true);
      expect((opened.contentProject as AuthoringProject).rooms.unrelated).toBeUndefined();
      expect(opened.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourcePath: invalidPath, severity: 'error' }),
        ]),
      );
      const listing = await sessions.listProjectSourceFiles({
        projectSessionId: opened.projectSessionId!,
      });
      const rawFile = listing.files.find((file) => file.id === invalidPath);
      expect(rawFile).toMatchObject({ kind: 'yaml', text: true });
      expect(rawFile?.contentHash).toBe(hash!(Buffer.from(malformed)));

      const savedRoomBefore = await roomBytes(root, 'start');
      const patched = await controller.applyRevisionedPatches(
        opened.projectSessionId!,
        opened.nativeWorkingRevision!,
        [{ op: 'replace', path: '/rooms/start/label', value: 'Independent repair-time edit' }],
      );
      expect(patched.accepted, patched.error).toBe(true);
      const savedRoom = await controller.saveUnit(
        opened.projectSessionId!,
        patched.snapshot.workingRevision,
        'record:rooms:start',
        {},
      );
      expect(savedRoom.accepted, savedRoom.error).toBe(true);
      expect(await roomBytes(root, 'start')).not.toBe(savedRoomBefore);
      expect(await readFile(roomFile, 'utf8')).toBe(malformed);

      const incomplete = malformed + '# intentionally still invalid\n';
      const savedRaw = await controller.saveText(
        opened.projectSessionId!,
        savedRoom.snapshot.workingRevision,
        invalidPath,
        rawFile!.contentHash!,
        incomplete,
      );
      expect(savedRaw.accepted, savedRaw.error).toBe(true);
      expect(await readFile(roomFile, 'utf8')).toBe(incomplete);
      const repaired = await controller.saveText(
        opened.projectSessionId!,
        savedRaw.snapshot.workingRevision,
        invalidPath,
        hash!(Buffer.from(incomplete)),
        original,
      );
      expect(repaired.accepted, repaired.error).toBe(true);
      expect(await readFile(roomFile, 'utf8')).toBe(original);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopenedHash = controller.sourceRevisionFor();
      sessions.setNativeSourceRevisionFor((bytes) => reopenedHash!(bytes) as `xxh3-128:${string}`);
      const reopened = await openNativeEditorProject(
        root,
        sessions.beginProjectActivation(),
        sessions,
        controller,
      );
      expect(reopened.success, reopened.error).toBe(true);
      expect((reopened.contentProject as AuthoringProject).rooms.unrelated).toBeDefined();
      expect((reopened.contentProject as AuthoringProject).rooms.start?.label).toBe(
        'Independent repair-time edit',
      );
      expect(
        (await sessions.listProjectSourceFiles({ projectSessionId: reopened.projectSessionId! }))
          .files,
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: invalidPath })]));
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  });

  it('commits exactly one edited Room to YAML and recovers the other Room across a cold worker restart', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const diskA = await roomBytes(root, roomA);
      const diskB = await roomBytes(root, roomB);
      const first = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Saved only room A' },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const second = await controller.applyRevisionedPatches(id, first.snapshot.workingRevision, [
        { op: 'replace', path: `/rooms/${roomB}/data/displayName`, value: 'Recovered room B' },
      ]);
      expect(second.accepted, second.error).toBe(true);
      expect(await roomBytes(root, roomA)).toBe(diskA);
      expect(await roomBytes(root, roomB)).toBe(diskB);

      const saved = await controller.saveUnit(
        id,
        second.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('Saved only room A');
      expect(await roomBytes(root, roomB)).toBe(diskB);
      expect((await controller.currentWorkingProject(id)).rooms[roomB]?.data.displayName).toBe(
        'Recovered room B',
      );

      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredContentProject()?.rooms[roomB]?.data.displayName).toBe(
        'Recovered room B',
      );
      expect(reopened.id).not.toBe(id);
      expect(await roomBytes(root, roomB)).toBe(diskB);
      const finalSave = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomB}`,
        {},
      );
      expect(finalSave.accepted, finalSave.error).toBe(true);
      expect(await roomBytes(root, roomB)).toContain('Recovered room B');
      expect(await roomBytes(root, roomA)).toContain('Saved only room A');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('imports an agent-edited unsaved Room on cold admission without writing the saved YAML', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const source = path.join(root, `records/rooms/${roomA}.yaml`);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const initial = await admit(root, sessions, controller);
      const disk = await readFile(source, 'utf8');
      const staged = await controller.applyRevisionedPatches(initial.id, initial.revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Native unsaved name' },
      ]);
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(initial.id);
      const authored = await readFile(proposed, 'utf8');
      expect(authored).toContain('Native unsaved name');
      await writeFile(
        proposed,
        `${authored.replace('label: Active Text', 'label: Agent repaired label')}\n# Agent repair context\n`,
      );
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);

      await admit(root, sessions, controller);
      expect(controller.recoveredContentProject()?.rooms[roomA]).toMatchObject({
        label: 'Agent repaired label',
        data: { displayName: 'Native unsaved name' },
      });
      expect(await readFile(source, 'utf8')).toBe(disk);
      // Close again before the scheduled publisher can advance its manifest:
      // the second admission must recognize the same already-imported fields.
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const second = await admit(root, sessions, controller);
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]).toBeUndefined();
      expect(controller.recoveredContentProject()?.rooms[roomA]?.label).toBe(
        'Agent repaired label',
      );
      await controller.flushWorkingSources(second.id);
      expect(await readFile(proposed, 'utf8')).toContain('Agent repaired label');
      expect(await readFile(proposed, 'utf8')).toContain('# Agent repair context');
      const saved = await controller.saveUnit(
        second.id,
        second.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(source, 'utf8')).toContain('Agent repaired label');
      expect(await readFile(source, 'utf8')).toContain('Native unsaved name');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('imports an external working Room while admitted without saving the tracked YAML', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    const source = path.join(root, `records/rooms/${roomA}.yaml`);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const opened = await admit(root, sessions, controller);
      const original = await readFile(source, 'utf8');
      const dirty = await controller.applyRevisionedPatches(opened.id, opened.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Unsaved editor',
        },
      ]);
      expect(dirty.accepted, dirty.error).toBe(true);
      await controller.flushWorkingSources(opened.id);
      await writeFile(
        proposed,
        (await readFile(proposed, 'utf8')).replace(
          'label: Active Text',
          'label: Agent live repair',
        ),
      );
      const imported = await controller.importLiveWorkingSources(
        opened.id,
        dirty.snapshot.workingRevision,
      );
      expect(imported.warnings).toEqual([]);
      expect(imported.result.affectedRecords).toContain(`rooms/${roomA}`);
      expect(imported.result.snapshot.recordSnapshots?.[`rooms/${roomA}`]?.source).toMatchObject({
        label: 'Agent live repair',
        data: { displayName: 'Unsaved editor' },
      });
      expect(await readFile(source, 'utf8')).toBe(original);
      await controller.flushWorkingSources(opened.id);
      expect(await readFile(proposed, 'utf8')).toContain('Agent live repair');
      // A source-publisher self-event is a no-op; it cannot bump the native revision.
      const redundant = await controller.importLiveWorkingSources(
        opened.id,
        imported.result.snapshot.workingRevision,
      );
      expect(redundant.result.affectedRecords).toEqual([]);
      expect(redundant.result.snapshot.workingRevision).toBe(
        imported.result.snapshot.workingRevision,
      );
      await expect(
        controller.importLiveWorkingSources(opened.id, dirty.snapshot.workingRevision),
      ).rejects.toThrow(/Stale working-source import revision/);
      const save = await controller.saveUnit(
        opened.id,
        imported.result.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(save.accepted, save.error).toBe(true);
      expect(await readFile(source, 'utf8')).toContain('Agent live repair');
      expect(await readFile(source, 'utf8')).toContain('Unsaved editor');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('keeps a live overlapping agent edit as a conflict and preserves independent dirty owners', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    const source = path.join(root, `records/rooms/${roomA}.yaml`);
    try {
      const opened = await admit(root, sessions, controller);
      const original = await readFile(source, 'utf8');
      const dirty = await controller.applyRevisionedPatches(opened.id, opened.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'First draft',
        },
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Independent dirty',
        },
      ]);
      expect(dirty.accepted, dirty.error).toBe(true);
      await controller.flushWorkingSources(opened.id);
      const updated = await controller.applyRevisionedPatches(
        opened.id,
        dirty.snapshot.workingRevision,
        [
          {
            op: 'replace',
            path: `/rooms/${roomA}/data/displayName`,
            value: 'Newer editor typing',
          },
        ],
      );
      expect(updated.accepted, updated.error).toBe(true);
      const agentBytes = (await readFile(proposed, 'utf8')).replace(
        'displayName: First draft',
        'displayName: Agent conflicting draft',
      );
      await writeFile(proposed, agentBytes);
      const imported = await controller.importLiveWorkingSources(
        opened.id,
        updated.snapshot.workingRevision,
      );
      expect(imported.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourcePath: `records/rooms/${roomA}.yaml` }),
        ]),
      );
      expect(
        imported.result.snapshot.recordSnapshots?.[`rooms/${roomA}`]?.conflictingPaths,
      ).toContain('/data/displayName');
      expect(imported.result.snapshot.recordSnapshots?.[`rooms/${roomB}`]?.source).toMatchObject({
        data: { displayName: 'Independent dirty' },
      });
      expect(await readFile(proposed, 'utf8')).toBe(agentBytes);
      expect(await readFile(source, 'utf8')).toBe(original);
      const savedIndependent = await controller.saveUnit(
        opened.id,
        imported.result.snapshot.workingRevision,
        `record:rooms:${roomB}`,
        {},
      );
      expect(savedIndependent.accepted, savedIndependent.error).toBe(true);
      expect(await readFile(source, 'utf8')).toBe(original);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('stages an agent-edited Lua working file live and returns the exact visible source buffer', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    const relative = 'scripts/notice-board.lua';
    const savedPath = path.join(root, relative);
    const proposed = path.join(root, `.noveltea/editor/working/files/${relative}`);
    try {
      const initial = await admit(root, sessions, controller);
      const disk = await readFile(savedPath, 'utf8');
      const originalRevision = controller.sourceRevisionFor()!(Buffer.from(disk));
      const staged = await controller.stageText(
        initial.id,
        initial.revision,
        relative,
        originalRevision,
        `${disk}\n-- native draft\n`,
      );
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(initial.id);
      const agentText = `${disk}\n-- live agent repair\n`;
      await writeFile(proposed, agentText);
      const imported = await controller.importLiveWorkingSources(
        initial.id,
        staged.snapshot.workingRevision,
      );
      expect(imported.warnings).toEqual([]);
      expect(imported.textSources[relative]).toEqual({
        text: agentText,
        diskRevision: originalRevision,
      });
      expect(imported.result.snapshot.workingRevision).toBeGreaterThan(
        staged.snapshot.workingRevision,
      );
      expect(await readFile(savedPath, 'utf8')).toBe(disk);
      await controller.flushWorkingSources(initial.id);
      expect(await readFile(proposed, 'utf8')).toBe(agentText);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('corrects an invalid unsaved native Room through a live agent working-file repair', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    const saved = path.join(root, `records/rooms/${roomA}.yaml`);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const disk = await readFile(saved, 'utf8');
      const broken = await controller.applyRevisionedPatches(first.id, first.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/background/asset`,
          value: 'missing-live-asset',
        },
      ]);
      expect(broken.accepted, broken.error).toBe(true);
      const before = await controller.validate(first.id, broken.snapshot.workingRevision);
      expect(before.diagnostics.length).toBeGreaterThan(0);
      await controller.flushWorkingSources(first.id);
      await writeFile(
        proposed,
        (await readFile(proposed, 'utf8')).replace(
          'asset: missing-live-asset',
          'asset: pilot-room-backdrop',
        ),
      );
      const repaired = await controller.importLiveWorkingSources(
        first.id,
        broken.snapshot.workingRevision,
      );
      expect(repaired.warnings).toEqual([]);
      expect(repaired.result.snapshot.recordSnapshots?.[`rooms/${roomA}`]?.source).toMatchObject({
        data: { background: { asset: 'pilot-room-backdrop' } },
      });
      const after = await controller.validate(first.id, repaired.result.snapshot.workingRevision);
      expect(after.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('missing-live-asset') }),
        ]),
      );
      expect(await readFile(saved, 'utf8')).toBe(disk);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('discards an invalid unsaved Room without external conflict or saving another dirty Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    try {
      const first = await admit(root, sessions, controller);
      const savedA = await roomBytes(root, roomA);
      const savedB = await roomBytes(root, roomB);
      const broken = await controller.applyRevisionedPatches(first.id, first.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/background/asset`,
          value: 'missing-invalid-asset',
        },
      ]);
      expect(broken.accepted, broken.error).toBe(true);
      const other = await controller.applyRevisionedPatches(
        first.id,
        broken.snapshot.workingRevision,
        [{ op: 'replace', path: `/rooms/${roomB}/data/displayName`, value: 'Keep this draft' }],
      );
      expect(other.accepted, other.error).toBe(true);
      const before = await controller.validate(first.id, other.snapshot.workingRevision);
      expect(before.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('missing-invalid-asset') }),
        ]),
      );

      // Use Disk is intentionally conflict-only; Don't Save needs explicit
      // full logical discard even when the invalid Room has no disk conflict.
      await expect(
        controller.useDiskUnit(first.id, other.snapshot.workingRevision, `record:rooms:${roomA}`),
      ).rejects.toThrow('no unresolved native conflicts');
      const discarded = await controller.useDiskUnit(
        first.id,
        other.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        true,
      );
      expect(discarded.accepted, discarded.error).toBe(true);
      const working = await controller.currentWorkingProject(first.id);
      expect(working.rooms[roomA]?.data.background.asset).not.toBe('missing-invalid-asset');
      expect(working.rooms[roomB]?.data.displayName).toBe('Keep this draft');
      expect(await roomBytes(root, roomA)).toBe(savedA);
      expect(await roomBytes(root, roomB)).toBe(savedB);
    } finally {
      controller.dispose();
      await controller.waitForPublicationDrain();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('reopens an unchanged working projection without inventing an agent conflict', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const saved = path.join(root, `records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const original = await readFile(saved, 'utf8');
      const changed = await controller.applyRevisionedPatches(first.id, first.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Native only dirty',
        },
      ]);
      expect(changed.accepted, changed.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const opened = await admit(root, sessions, controller);
      expect(
        opened.diagnostics.some((item) => item.code === 'native.working_source.conflict'),
      ).toBe(false);
      expect(controller.recoveredContentProject()?.rooms[roomA]?.data.displayName).toBe(
        'Native only dirty',
      );
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]).toBeUndefined();
      expect(await readFile(saved, 'utf8')).toBe(original);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('does not trust agent bytes after the native recovery checkpoint was corrupted', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    const saved = path.join(root, `records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const original = await readFile(saved, 'utf8');
      const changed = await controller.applyRevisionedPatches(first.id, first.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Native retained only',
        },
      ]);
      expect(changed.accepted, changed.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      controller.dispose();
      sessions.closeActiveProject();
      const agentText = (await readFile(proposed, 'utf8')).replace(
        'label: Active Text',
        'label: Agent unattributed repair',
      );
      await writeFile(proposed, agentText);
      await writeFile(path.join(root, '.noveltea/editor/native-dirty-state.json'), '{');
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(reopened.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'native.working_source.conflict' }),
          expect.objectContaining({ code: 'native.recovery.quarantined' }),
        ]),
      );
      expect(controller.recoveredContentProject()?.rooms[roomA]?.label).not.toBe(
        'Agent unattributed repair',
      );
      expect(await readFile(proposed, 'utf8')).toBe(agentText);
      expect(await readFile(saved, 'utf8')).toBe(original);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('keeps an overlapping offline agent edit as native conflict and preserves its source bytes', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const staged = await controller.applyRevisionedPatches(first.id, first.revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Native unsaved name' },
      ]);
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      // Advance the durable native checkpoint *after* the last projection.
      // The newer acknowledged edit has not yet been published to the agent file.
      const newer = await controller.applyRevisionedPatches(
        first.id,
        staged.snapshot.workingRevision,
        [{ op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Native newer name' }],
      );
      expect(newer.accepted, newer.error).toBe(true);
      const edited = (await readFile(proposed, 'utf8')).replace(
        'displayName: Native unsaved name',
        'displayName: Agent competing name',
      );
      await writeFile(proposed, edited);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredContentProject()?.rooms[roomA]?.data.displayName).toBe(
        'Native newer name',
      );
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]?.paths).toContain(
        '/data/displayName',
      );
      expect(await readFile(proposed, 'utf8')).toBe(edited);
      const rejected = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(rejected.accepted).toBe(false);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('detects overlapping offline disk and agent edits without committing either on open', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const source = path.join(root, `records/rooms/${roomA}.yaml`);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const staged = await controller.applyRevisionedPatches(first.id, first.revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Native dirty name' },
      ]);
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      await writeFile(
        proposed,
        (await readFile(proposed, 'utf8')).replace('label: Active Text', 'label: Agent only label'),
      );
      const diskBefore = await readFile(source, 'utf8');
      controller.dispose();
      sessions.closeActiveProject();
      await writeFile(source, diskBefore.replace('label: Active Text', 'label: Disk only label'));
      // The agent and disk both touched label: this must be an unresolved
      // field conflict despite the independent dirty displayName in native.
      controller = nativeHarness(sessions);
      const overlapping = await admit(root, sessions, controller);
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]?.paths).toContain('/label');
      expect(controller.recoveredContentProject()?.rooms[roomA]?.data.displayName).toBe(
        'Native dirty name',
      );
      expect(await readFile(source, 'utf8')).toContain('Disk only label');
      expect(await readFile(proposed, 'utf8')).toContain('Agent only label');
      expect(
        (
          await controller.saveUnit(
            overlapping.id,
            overlapping.revision,
            `record:rooms:${roomA}`,
            {},
          )
        ).accepted,
      ).toBe(false);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('retains malformed agent YAML across repeated cold opens instead of restoring over it', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    const invalid = 'id: active-text\nlabel: Agent repair in progress\ndata: [\n';
    try {
      const first = await admit(root, sessions, controller);
      const staged = await controller.applyRevisionedPatches(first.id, first.revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Native retained name' },
      ]);
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      controller.dispose();
      sessions.closeActiveProject();
      await writeFile(proposed, invalid);
      for (let attempt = 0; attempt < 2; attempt++) {
        controller = nativeHarness(sessions);
        const reopened = await admit(root, sessions, controller);
        expect(controller.recoveredContentProject()?.rooms[roomA]?.data.displayName).toBe(
          'Native retained name',
        );
        expect(reopened.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'native.working_source.conflict' }),
          ]),
        );
        expect(await readFile(proposed, 'utf8')).toBe(invalid);
        controller.dispose();
        sessions.closeActiveProject();
      }
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('combines disjoint offline disk, agent and native edits into one dirty Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const source = path.join(root, `records/rooms/${roomA}.yaml`);
    const proposed = path.join(root, `.noveltea/editor/working/files/records/rooms/${roomA}.yaml`);
    try {
      const first = await admit(root, sessions, controller);
      const staged = await controller.applyRevisionedPatches(first.id, first.revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Unsaved native' },
      ]);
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      await writeFile(
        proposed,
        (await readFile(proposed, 'utf8')).replace('label: Active Text', 'label: From agent'),
      );
      const original = await readFile(source, 'utf8');
      controller.dispose();
      sessions.closeActiveProject();
      await writeFile(
        source,
        original.replace(
          'text: Use Continue and the conversation choices. Reopen Feature Lab for check instructions.',
          'text: Independent disk edit',
        ),
      );
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]).toBeUndefined();
      expect(controller.recoveredContentProject()?.rooms[roomA]).toMatchObject({
        label: 'From agent',
        data: {
          displayName: 'Unsaved native',
          description: { source: { text: 'Independent disk edit' } },
        },
      });
      expect(await readFile(source, 'utf8')).not.toContain('From agent');
      await controller.flushWorkingSources(reopened.id);
      const save = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(save.accepted, save.error).toBe(true);
      expect(await readFile(source, 'utf8')).toContain('From agent');
      expect(await readFile(source, 'utf8')).toContain('Independent disk edit');
      expect(await readFile(source, 'utf8')).toContain('Unsaved native');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('imports an exact unsaved Lua text overlay without changing saved Lua until Save', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const relative = 'scripts/notice-board.lua';
    const savedPath = path.join(root, relative);
    const proposed = path.join(root, `.noveltea/editor/working/files/${relative}`);
    try {
      const first = await admit(root, sessions, controller);
      const disk = await readFile(savedPath, 'utf8');
      const originalRevision = controller.sourceRevisionFor()!(Buffer.from(disk));
      const staged = await controller.stageText(
        first.id,
        first.revision,
        relative,
        originalRevision,
        `${disk}\n-- Native dirty\n`,
      );
      expect(staged.accepted, staged.error).toBe(true);
      await controller.flushWorkingSources(first.id);
      const agentText = `${disk}\n-- Agent fixed this\n`;
      await writeFile(proposed, agentText);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredTextSources()[relative]?.text).toBe(agentText);
      expect(await readFile(savedPath, 'utf8')).toBe(disk);
      await controller.flushWorkingSources(reopened.id);
      expect(await readFile(proposed, 'utf8')).toBe(agentText);
      const save = await controller.saveText(
        reopened.id,
        reopened.revision,
        relative,
        originalRevision,
        agentText,
      );
      expect(save.accepted, save.error).toBe(true);
      expect(await readFile(savedPath, 'utf8')).toBe(agentText);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('persists a Scene without committing a pending Dialogue, then saves the recovered Dialogue', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const sceneFile = path.join(root, 'records/scenes/background-stories.yaml');
    const dialogueFile = path.join(root, 'records/dialogues/active-text.yaml');
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const originalScene = await readFile(sceneFile, 'utf8');
      const originalDialogue = await readFile(dialogueFile, 'utf8');
      const scene = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: '/scenes/background-stories/data/displayName',
          value: 'Committed Scene',
        },
      ]);
      expect(scene.accepted, scene.error).toBe(true);
      const dialogue = await controller.applyRevisionedPatches(id, scene.snapshot.workingRevision, [
        {
          op: 'replace',
          path: '/dialogues/active-text/data/displayName',
          value: 'Pending Dialogue',
        },
      ]);
      expect(dialogue.accepted, dialogue.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        dialogue.snapshot.workingRevision,
        'record:scenes:background-stories',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(sceneFile, 'utf8')).not.toBe(originalScene);
      expect(await readFile(sceneFile, 'utf8')).toContain('Committed Scene');
      expect(await readFile(dialogueFile, 'utf8')).toBe(originalDialogue);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredContentProject()?.dialogues['active-text']?.data.displayName).toBe(
        'Pending Dialogue',
      );
      const final = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        'record:dialogues:active-text',
        {},
      );
      expect(final.accepted, final.error).toBe(true);
      expect(await readFile(dialogueFile, 'utf8')).toContain('Pending Dialogue');
      expect(await readFile(sceneFile, 'utf8')).toContain('Committed Scene');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('fails a mixed-owner Save atomically on external overlap, then persists both after explicit Keep Mine', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const diskB = await roomBytes(root, roomB);
      const patchA = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'My overlapping edit' },
      ]);
      expect(patchA.accepted, patchA.error).toBe(true);
      const patchB = await controller.applyRevisionedPatches(id, patchA.snapshot.workingRevision, [
        { op: 'replace', path: `/rooms/${roomB}/data/displayName`, value: 'Second owner edit' },
      ]);
      expect(patchB.accepted, patchB.error).toBe(true);
      const diskA = await roomBytes(root, roomA);
      expect(diskA).toContain('displayName: Active Text');
      await writeFile(
        path.join(root, `records/rooms/${roomA}.yaml`),
        diskA.replace('displayName: Active Text', 'displayName: External edit'),
      );
      const owners = [`record:rooms:${roomA}`, `record:rooms:${roomB}`];
      const refused = await controller.saveUnit(id, patchB.snapshot.workingRevision, owners, {});
      expect(refused.accepted).toBe(false);
      expect(await roomBytes(root, roomA)).toContain('displayName: External edit');
      expect(await roomBytes(root, roomB)).toBe(diskB);
      expect((await controller.currentWorkingProject(id)).rooms[roomA]?.data.displayName).toBe(
        'My overlapping edit',
      );
      expect((await controller.currentWorkingProject(id)).rooms[roomB]?.data.displayName).toBe(
        'Second owner edit',
      );

      // Keep Mine is a distinct explicit user choice, never the default Save.
      const reconciled = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);
      const retried = await controller.saveUnit(id, controller.currentRevision(id), owners, {
        keepMine: true,
      });
      expect(retried.accepted, retried.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('My overlapping edit');
      expect(await roomBytes(root, roomB)).toContain('Second owner edit');

      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(reopened.revision).toBeGreaterThanOrEqual(0);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('My overlapping edit');
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomB]?.data.displayName,
      ).toBe('Second owner edit');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('resolves Use Disk for one conflicting Room without discarding another dirty Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const first = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Discard this local edit',
        },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const second = await controller.applyRevisionedPatches(id, first.snapshot.workingRevision, [
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Preserve this other edit',
        },
      ]);
      expect(second.accepted, second.error).toBe(true);
      const diskA = await roomBytes(root, roomA);
      await writeFile(
        path.join(root, `records/rooms/${roomA}.yaml`),
        diskA.replace('displayName: Active Text', 'displayName: Disk wins'),
      );
      const refused = await controller.saveUnit(
        id,
        second.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(refused.accepted).toBe(false);
      const reconciled = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);
      const discarded = await controller.useDiskUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
      );
      expect(discarded.accepted, discarded.error).toBe(true);
      expect((await controller.currentWorkingProject(id)).rooms[roomA]?.data.displayName).toBe(
        'Disk wins',
      );
      expect((await controller.currentWorkingProject(id)).rooms[roomB]?.data.displayName).toBe(
        'Preserve this other edit',
      );
      const saved = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomB}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('displayName: Disk wins');
      expect(await roomBytes(root, roomB)).toContain('Preserve this other edit');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('resolves a live Room conflict through the main controller without losing a second dirty field on restart', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await roomBytes(root, roomA);
      const edited = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Conflicting local' },
        { op: 'replace', path: `/rooms/${roomA}/label`, value: 'Unrelated local label' },
      ]);
      expect(edited.accepted, edited.error).toBe(true);
      const external = original.replace('displayName: Active Text', 'displayName: External winner');
      await writeFile(path.join(root, `records/rooms/${roomA}.yaml`), external);
      const reviewed = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reviewed.accepted, reviewed.error).toBe(true);
      expect(reviewed.snapshot.recordSnapshots?.[`rooms/${roomA}`]?.conflictingPaths).toEqual([
        '/data/displayName',
      ]);
      expect(
        (await controller.saveUnit(id, controller.currentRevision(id), `record:rooms:${roomA}`, {}))
          .accepted,
      ).toBe(false);
      const adopted = await controller.useDiskUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
      );
      expect(adopted.accepted, adopted.error).toBe(true);
      expect(adopted.snapshot.recordSnapshots?.[`rooms/${roomA}`]).toMatchObject({
        dirty: true,
        conflictingPaths: [],
      });
      const working = await controller.currentWorkingProject(id);
      expect(working.rooms[roomA]?.data.displayName).toBe('External winner');
      expect(working.rooms[roomA]?.label).toBe('Unrelated local label');
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect((await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.label).toBe(
        'Unrelated local label',
      );
      const saved = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('displayName: External winner');
      expect(await roomBytes(root, roomA)).toContain('label: "Unrelated local label"');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('rebases a disjoint external YAML change while retaining a dirty local field and saves both', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const local = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Local display name' },
      ]);
      expect(local.accepted, local.error).toBe(true);
      const original = await roomBytes(root, roomA);
      await writeFile(
        path.join(root, `records/rooms/${roomA}.yaml`),
        original.replace('label: Active Text', 'label: External label'),
      );
      const reconciled = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);
      const projected = (await controller.currentWorkingProject(id)).rooms[roomA];
      expect(projected?.label).toBe('External label');
      expect(projected?.data.displayName).toBe('Local display name');
      const saved = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      const final = await roomBytes(root, roomA);
      expect(final).toContain('label: External label');
      expect(final).toContain('Local display name');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('rejects an intervening second external YAML edit after conflict review, preserving the local Save for a new review', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const first = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'My reviewed value' },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const original = await roomBytes(root, roomA);
      const firstExternal = original.replace(
        'displayName: Active Text',
        'displayName: First external',
      );
      const filename = path.join(root, `records/rooms/${roomA}.yaml`);
      await writeFile(filename, firstExternal);
      const reconciled = await controller.reconcile(
        id,
        first.snapshot.workingRevision,
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);

      // Continue Editing may revise L after the first conflict review. Keep
      // Mine must commit this newer value, not the value displayed initially.
      const revised = await controller.applyRevisionedPatches(id, controller.currentRevision(id), [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'My latest local value',
        },
      ]);
      expect(revised.accepted, revised.error).toBe(true);

      // The review applied to First external only. A second disk writer must
      // invalidate the Keep Mine precondition instead of being overwritten.
      const secondExternal = firstExternal.replace(
        'displayName: First external',
        'displayName: Second external',
      );
      await writeFile(filename, secondExternal);
      const staleSave = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
        { keepMine: true },
      );
      expect(staleSave.accepted).toBe(false);
      expect(await roomBytes(root, roomA)).toBe(secondExternal);
      expect((await controller.currentWorkingProject(id)).rooms[roomA]?.data.displayName).toBe(
        'My latest local value',
      );

      const reviewedAgain = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reviewedAgain.accepted, reviewedAgain.error).toBe(true);
      const committed = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
        { keepMine: true },
      );
      expect(committed.accepted, committed.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('My latest local value');
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('My latest local value');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('keeps export on verified saved sources while native edits are dirty and admits the newly saved bytes afterward', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await roomBytes(root, roomA);
      const patched = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Saved export only' },
      ]);
      expect(patched.accepted, patched.error).toBe(true);
      expect((await controller.currentWorkingProject(id)).rooms[roomA]?.data.displayName).toBe(
        'Saved export only',
      );
      await expect(controller.prepareCleanExportAdmission(id)).rejects.toThrow(
        'Save or resolve all dirty Project and source files before exporting.',
      );
      expect(await roomBytes(root, roomA)).toBe(original);
      const saved = await controller.saveUnit(
        id,
        patched.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      const admission = await controller.prepareCleanExportAdmission(id);
      expect(admission.project.rooms[roomA]?.data.displayName).toBe('Saved export only');
      expect(admission.sourceRevisions['records/rooms/active-text.yaml']).toMatch(
        /^xxh3-128:[a-f0-9]{32}$/u,
      );
      expect(await roomBytes(root, roomA)).toContain('Saved export only');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('saves an exact Room-owned Interactable Instance field through native physical project.yaml and cold reopening', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await readFile(path.join(root, 'project.yaml'), 'utf8');
      const changed = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'add',
          path: '/interactableInstances/rule-exact-target/editorLabel',
          value: 'Inspected Instance',
        },
      ]);
      expect(changed.accepted, changed.error).toBe(true);
      expect(
        (await controller.currentWorkingProject(id)).interactableInstances['rule-exact-target']
          ?.editorLabel,
      ).toBe('Inspected Instance');
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(original);
      const saved = await controller.saveUnit(
        id,
        changed.snapshot.workingRevision,
        'record:rooms:interaction-rules',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toBe(original);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).interactableInstances[
          'rule-exact-target'
        ]?.editorLabel,
      ).toBe('Inspected Instance');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('persists only the selected exact Instance, leaving another Room Instance dirty and recoverable', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await readFile(path.join(root, 'project.yaml'), 'utf8');
      const first = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'add',
          path: '/interactableInstances/rule-exact-target/editorLabel',
          value: 'Scoped Room Instance',
        },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const other = await controller.applyRevisionedPatches(id, first.snapshot.workingRevision, [
        {
          op: 'add',
          path: '/interactableInstances/alpha-board/editorLabel',
          value: 'Pending Alpha Instance',
        },
      ]);
      expect(other.accepted, other.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        other.snapshot.workingRevision,
        'record:rooms:interaction-rules',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      const disk = await readFile(path.join(root, 'project.yaml'), 'utf8');
      expect(disk).not.toBe(original);
      expect(disk).toContain('Scoped Room Instance');
      expect(disk).not.toContain('Pending Alpha Instance');
      expect(
        (await controller.currentWorkingProject(id)).interactableInstances['alpha-board']
          ?.editorLabel,
      ).toBe('Pending Alpha Instance');
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).interactableInstances['alpha-board']
          ?.editorLabel,
      ).toBe('Pending Alpha Instance');
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(disk);
      const final = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        'record:rooms:hotspots-and-cursors',
        {},
      );
      expect(final.accepted, final.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain(
        'Pending Alpha Instance',
      );
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('saves a Definition-owned exact Instance through its Interactable Save unit without committing a dirty Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const originalRoom = await roomBytes(root, roomB);
      const room = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Unrelated pending Room',
        },
      ]);
      expect(room.accepted, room.error).toBe(true);
      const instance = await controller.applyRevisionedPatches(id, room.snapshot.workingRevision, [
        {
          op: 'add',
          path: '/interactableInstances/rule-exact-target/editorLabel',
          value: 'Definition Instance',
        },
      ]);
      expect(instance.accepted, instance.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        instance.snapshot.workingRevision,
        'record:interactables:lab-command-target',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain(
        'Definition Instance',
      );
      expect(await roomBytes(root, roomB)).toBe(originalRoom);
      expect((await controller.currentWorkingProject(id)).rooms[roomB]?.data.displayName).toBe(
        'Unrelated pending Room',
      );
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('rejects a missing-owner native field patch without losing another owner and retries against the same native revision', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const diskA = await roomBytes(root, roomA);
      const diskB = await roomBytes(root, roomB);
      const first = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Independent working title',
        },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const beforeRejection = first.snapshot.workingRevision;
      const rejected = await controller.applyRevisionedPatches(id, beforeRejection, [
        {
          op: 'replace',
          path: '/rooms/nonexistent-608-room/data/displayName',
          value: 'Invalid owner',
        },
      ]);
      expect(rejected.accepted).toBe(false);
      expect(controller.currentRevision(id)).toBe(beforeRejection);
      expect(await roomBytes(root, roomA)).toBe(diskA);
      expect(await roomBytes(root, roomB)).toBe(diskB);
      expect((await controller.currentWorkingProject(id)).rooms[roomB]?.data.displayName).toBe(
        'Independent working title',
      );
      const recovered = await controller.applyRevisionedPatches(id, beforeRejection, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Corrected native field',
        },
      ]);
      expect(recovered.accepted, recovered.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        recovered.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('Corrected native field');
      expect(await roomBytes(root, roomB)).toBe(diskB);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomB]?.data.displayName,
      ).toBe('Independent working title');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('round-trips structural Room create, undo deletion, redo and atomic move while another Room remains dirty', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const created = 'integration-608-room';
    const createdFile = path.join(root, `records/rooms/${created}.yaml`);
    const createdRoom = {
      id: created,
      label: 'Certification Room',
      data: defaultRoomData('Certification Room'),
    };
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const originalB = await roomBytes(root, roomB);
      const pending = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Still pending across structural undo',
        },
      ]);
      expect(pending.accepted, pending.error).toBe(true);
      const addition = await controller.applyRevisionedPatches(
        id,
        pending.snapshot.workingRevision,
        [{ op: 'add', path: `/rooms/${created}`, value: createdRoom }],
      );
      expect(addition.accepted, addition.error).toBe(true);
      await expect(readFile(createdFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const saved = await controller.saveUnit(
        id,
        addition.snapshot.workingRevision,
        `record:rooms:${created}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(createdFile, 'utf8')).toContain('Certification Room');
      expect(await roomBytes(root, roomB)).toBe(originalB);
      // These are the same inverse/forward structural intents emitted by the
      // renderer command history; the native worker remains YAML authority.
      const undone = await controller.applyRevisionedPatches(id, saved.snapshot.workingRevision, [
        { op: 'remove', path: `/rooms/${created}` },
      ]);
      expect(undone.accepted, undone.error).toBe(true);
      const deletion = await controller.saveUnit(
        id,
        undone.snapshot.workingRevision,
        `record:rooms:${created}`,
        {},
      );
      expect(deletion.accepted, deletion.error).toBe(true);
      await expect(readFile(createdFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const redone = await controller.applyRevisionedPatches(
        id,
        deletion.snapshot.workingRevision,
        [{ op: 'add', path: `/rooms/${created}`, value: createdRoom }],
      );
      expect(redone.accepted, redone.error).toBe(true);
      const final = await controller.saveUnit(
        id,
        redone.snapshot.workingRevision,
        `record:rooms:${created}`,
        {},
      );
      expect(final.accepted, final.error).toBe(true);
      expect(await readFile(createdFile, 'utf8')).toContain('Certification Room');
      expect(await roomBytes(root, roomB)).toBe(originalB);
      const movedId = 'integration-608-moved-room';
      const movedFile = path.join(root, `records/rooms/${movedId}.yaml`);
      const moved = await controller.applyRevisionedPatches(id, final.snapshot.workingRevision, [
        { op: 'remove', path: `/rooms/${created}` },
        {
          op: 'add',
          path: `/rooms/${movedId}`,
          value: { ...createdRoom, id: movedId },
        },
      ]);
      expect(moved.accepted, moved.error).toBe(true);
      const movedSave = await controller.saveUnit(
        id,
        moved.snapshot.workingRevision,
        [`record:rooms:${created}`, `record:rooms:${movedId}`],
        {},
      );
      expect(movedSave.accepted, movedSave.error).toBe(true);
      await expect(readFile(createdFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(movedFile, 'utf8')).toContain(movedId);
      expect(await roomBytes(root, roomB)).toBe(originalB);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect((await controller.currentWorkingProject(reopened.id)).rooms[movedId]?.id).toBe(
        movedId,
      );
      expect((await controller.currentWorkingProject(reopened.id)).rooms[created]).toBeUndefined();
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomB]?.data.displayName,
      ).toBe('Still pending across structural undo');
      expect(await roomBytes(root, roomB)).toBe(originalB);
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('rehydrates a reviewed but unresolved physical conflict with both disk and local values intact', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const savedBytes = await roomBytes(root, roomA);
      const dirty = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Local retained through restart',
        },
      ]);
      expect(dirty.accepted, dirty.error).toBe(true);
      const external = savedBytes.replace(
        'displayName: Active Text',
        'displayName: External retained',
      );
      await writeFile(path.join(root, `records/rooms/${roomA}.yaml`), external);
      const reconciled = await controller.reconcile(
        id,
        dirty.snapshot.workingRevision,
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);
      expect(
        reconciled.snapshot.recordSnapshots?.[`rooms/${roomA}`]?.conflictingPaths?.length,
      ).toBeGreaterThan(0);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(await roomBytes(root, roomA)).toBe(external);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('Local retained through restart');
      expect(controller.recoveredConflicts()[`rooms/${roomA}`]?.paths.length).toBeGreaterThan(0);
      const saved = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted).toBe(false);
      expect(await roomBytes(root, roomA)).toBe(external);
      const explicit = await controller.useDiskUnit(
        reopened.id,
        controller.currentRevision(reopened.id),
        `record:rooms:${roomA}`,
      );
      expect(explicit.accepted, explicit.error).toBe(true);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('External retained');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('never publishes a late real-native patch acknowledgment into a newly activated Project', async () => {
    const oldRoot = await disposableProject();
    const newRoot = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: addonPath!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 100,
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    const controller = new NativeEditorSessionController(sessions, bridge, working);
    let newController: NativeEditorSessionController | null = null;
    let release!: () => void;
    let acknowledge!: () => void;
    const nativeAccepted = new Promise<void>((resolve) => (acknowledge = resolve));
    const holdPublication = new Promise<void>((resolve) => (release = resolve));
    const originalApply = working.applyRevisionedPatches.bind(working);
    const intercepted = vi
      .spyOn(working, 'applyRevisionedPatches')
      .mockImplementationOnce(async (revision, patches, layoutCopySources) => {
        const result = await originalApply(revision, patches, layoutCopySources);
        acknowledge();
        await holdPublication;
        return result;
      });
    try {
      const { id, revision } = await admit(oldRoot, sessions, controller);
      const originalOld = await roomBytes(oldRoot, roomA);
      const originalNew = await roomBytes(newRoot, roomA);
      const stale = controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Only old Project RAM' },
      ]);
      await nativeAccepted;
      controller.close();
      sessions.closeActiveProject();
      newController = nativeHarness(sessions);
      const next = await admit(newRoot, sessions, newController);
      expect(next.id).not.toBe(id);
      const changed = await newController.applyRevisionedPatches(next.id, next.revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'New Project authoritative',
        },
      ]);
      expect(changed.accepted, changed.error).toBe(true);
      const committed = await newController.saveUnit(
        next.id,
        changed.snapshot.workingRevision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(committed.accepted, committed.error).toBe(true);
      release();
      await expect(stale).rejects.toThrow('superseded');
      expect(await roomBytes(oldRoot, roomA)).toBe(originalOld);
      expect(await roomBytes(newRoot, roomA)).not.toBe(originalNew);
      expect(await roomBytes(newRoot, roomA)).toContain('New Project authoritative');
      expect(
        (await newController.currentWorkingProject(next.id)).rooms[roomA]?.data.displayName,
      ).toBe('New Project authoritative');
    } finally {
      release();
      intercepted.mockRestore();
      controller.dispose();
      newController?.dispose();
      sessions.dispose();
      // The retired worker can finish writing a cache entry concurrently
      // with fixture cleanup; retry ENOTEMPTY without weakening assertions.
      await rm(oldRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      await rm(newRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  }, 120_000);

  it('validates and prepares preview/Test against dirty native source without writing YAML or Lua until Save', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const source = 'scripts/feature-lab-bootstrap.lua';
    const file = path.join(root, source);
    try {
      const { id, revision, sourceRevisions } = await admit(root, sessions, controller);
      const original = await readFile(file, 'utf8');
      const originalRoom = await roomBytes(root, roomA);
      const changed = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Dirty during preview' },
      ]);
      expect(changed.accepted, changed.error).toBe(true);
      const invalidRoom = await controller.applyRevisionedPatches(
        id,
        changed.snapshot.workingRevision,
        [
          {
            op: 'replace',
            path: `/rooms/${roomA}/data/background/asset`,
            value: 'missing-608-preview-asset',
          },
        ],
      );
      expect(invalidRoom.accepted, invalidRoom.error).toBe(true);
      const broken = await controller.stageText(
        id,
        invalidRoom.snapshot.workingRevision,
        source,
        sourceRevisions[source]!,
        original + '\n-- preview should not write this staged source\n',
      );
      expect(broken.accepted, broken.error).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(await roomBytes(root, roomA)).toBe(originalRoom);
      const validation = await controller.validate(id, broken.snapshot.workingRevision);
      expect(validation.success).toBe(false);
      const preview = await controller.prepareRuntime(
        id,
        broken.snapshot.workingRevision,
        'glsl-330',
      );
      expect(preview.status).toBe('blocked');
      const test = await controller.testReadiness(
        id,
        broken.snapshot.workingRevision,
        'script-and-data-flow',
      );
      expect(test.runnable).toBe(false);
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(await roomBytes(root, roomA)).toBe(originalRoom);

      const corrected = original + '\n-- validated but not yet saved\n';
      const repairedRoom = await controller.applyRevisionedPatches(
        id,
        broken.snapshot.workingRevision,
        [
          {
            op: 'replace',
            path: `/rooms/${roomA}/data/background/asset`,
            value: 'pilot-room-backdrop',
          },
        ],
      );
      expect(repairedRoom.accepted, repairedRoom.error).toBe(true);
      const staged = await controller.stageText(
        id,
        repairedRoom.snapshot.workingRevision,
        source,
        sourceRevisions[source]!,
        corrected,
      );
      expect(staged.accepted, staged.error).toBe(true);
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(controller.recoveredTextSources()[source]?.text).toBe(corrected);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('Dirty during preview');
      expect(await readFile(file, 'utf8')).toBe(original);
      const saved = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        { textPaths: [source], textContents: { [source]: corrected } },
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(corrected);
      expect(await roomBytes(root, roomA)).toContain('Dirty during preview');
    } finally {
      controller.dispose();
      sessions.dispose();
      await removeDisposableProject(root);
    }
  }, 120_000);

  it('recovers a failed native Save All by saving independent owners then resolving the last conflicting owner', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    const scene = 'background-stories';
    const sceneFile = path.join(root, `records/scenes/${scene}.yaml`);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const originalA = await roomBytes(root, roomA);
      const originalB = await roomBytes(root, roomB);
      const originalScene = await readFile(sceneFile, 'utf8');
      const first = await controller.applyRevisionedPatches(id, revision, [
        { op: 'replace', path: `/rooms/${roomA}/data/displayName`, value: 'Pending conflict room' },
      ]);
      expect(first.accepted, first.error).toBe(true);
      const second = await controller.applyRevisionedPatches(id, first.snapshot.workingRevision, [
        { op: 'replace', path: `/rooms/${roomB}/data/displayName`, value: 'Independent room' },
      ]);
      expect(second.accepted, second.error).toBe(true);
      const third = await controller.applyRevisionedPatches(id, second.snapshot.workingRevision, [
        { op: 'replace', path: `/scenes/${scene}/data/displayName`, value: 'Independent scene' },
      ]);
      expect(third.accepted, third.error).toBe(true);
      const external = originalA.replace(
        'displayName: Active Text',
        'displayName: External conflict room',
      );
      await writeFile(path.join(root, `records/rooms/${roomA}.yaml`), external);

      const failed = await controller.saveUnit(
        id,
        third.snapshot.workingRevision,
        [`record:rooms:${roomA}`, `record:rooms:${roomB}`, `record:scenes:${scene}`],
        {},
      );
      expect(failed.accepted).toBe(false);
      expect(await roomBytes(root, roomA)).toBe(external);
      expect(await roomBytes(root, roomB)).toBe(originalB);
      expect(await readFile(sceneFile, 'utf8')).toBe(originalScene);

      const saveIndependent = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        [`record:rooms:${roomB}`, `record:scenes:${scene}`],
        {},
      );
      expect(saveIndependent.accepted, saveIndependent.error).toBe(true);
      expect(await roomBytes(root, roomA)).toBe(external);
      expect(await roomBytes(root, roomB)).toContain('Independent room');
      expect(await readFile(sceneFile, 'utf8')).toContain('Independent scene');
      expect((await controller.currentWorkingProject(id)).rooms[roomA]?.data.displayName).toBe(
        'Pending conflict room',
      );
      const reconciled = await controller.reconcile(
        id,
        controller.currentRevision(id),
        `rooms/${roomA}`,
      );
      expect(reconciled.accepted, reconciled.error).toBe(true);
      const conflictSave = await controller.saveUnit(
        id,
        controller.currentRevision(id),
        `record:rooms:${roomA}`,
        { keepMine: true },
      );
      expect(conflictSave.accepted, conflictSave.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('Pending conflict room');
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      const complete = await controller.currentWorkingProject(reopened.id);
      expect(complete.rooms[roomA]?.data.displayName).toBe('Pending conflict room');
      expect(complete.rooms[roomB]?.data.displayName).toBe('Independent room');
      expect(complete.scenes[scene]?.data.displayName).toBe('Independent scene');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('persists Project Settings-owned starting Inventory Instance without committing a separate Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    const controller = nativeHarness(sessions);
    const item = 'integration-starting-supply-608';
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const originalProject = await readFile(path.join(root, 'project.yaml'), 'utf8');
      const originalRoom = await roomBytes(root, roomB);
      const dirtyRoom = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomB}/data/displayName`,
          value: 'Unrelated Room location',
        },
      ]);
      expect(dirtyRoom.accepted, dirtyRoom.error).toBe(true);
      const sourceItem = (await controller.currentWorkingProject(id)).interactableInstances[
        'builder-inventory-parcel'
      ]!;
      const created = await controller.applyRevisionedPatches(
        id,
        dirtyRoom.snapshot.workingRevision,
        [
          {
            op: 'add',
            path: `/interactableInstances/${item}`,
            value: {
              ...structuredClone(sourceItem),
              id: item,
              definition: { $ref: { collection: 'interactables', id: 'lab-supply' } },
              quantity: 2,
            },
          },
        ],
      );
      expect(created.accepted, created.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(originalProject);
      const saved = await controller.saveUnit(
        id,
        created.snapshot.workingRevision,
        'project:settings',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toBe(originalProject);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain(item);
      expect(await roomBytes(root, roomB)).toBe(originalRoom);
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('persists the latest Room intent after a Definition-origin exact Instance edit, not its superseded field value', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await readFile(path.join(root, 'project.yaml'), 'utf8');
      const definition = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'add',
          path: '/interactableInstances/rule-exact-target/editorLabel',
          value: 'Definition earlier',
        },
      ]);
      expect(definition.accepted, definition.error).toBe(true);
      const room = await controller.applyRevisionedPatches(
        id,
        definition.snapshot.workingRevision,
        [
          {
            op: 'replace',
            path: '/interactableInstances/rule-exact-target/editorLabel',
            value: 'Room latest',
          },
        ],
      );
      expect(room.accepted, room.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        room.snapshot.workingRevision,
        'record:rooms:interaction-rules',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toBe(original);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain('Room latest');
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toContain(
        'Definition earlier',
      );
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).interactableInstances[
          'rule-exact-target'
        ]?.editorLabel,
      ).toBe('Room latest');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('persists an exact Instance from the containing Room even when its world location names a different Room', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let controller = nativeHarness(sessions);
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await readFile(path.join(root, 'project.yaml'), 'utf8');
      // Feature Lab: scene-director places gate-lever-1, whose world location
      // names rooms-interactions-workshop. The Room placement is the editor
      // authority, not the current gameplay location.
      const edited = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'add',
          path: '/interactableInstances/gate-lever-1/editorLabel',
          value: 'Saved from containing Room',
        },
      ]);
      expect(edited.accepted, edited.error).toBe(true);
      const saved = await controller.saveUnit(
        id,
        edited.snapshot.workingRevision,
        'record:rooms:scene-director',
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toBe(original);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain(
        'Saved from containing Room',
      );
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).interactableInstances['gate-lever-1']
          ?.editorLabel,
      ).toBe('Saved from containing Room');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('restores acknowledged dirty YAML after a real native worker termination without publishing unsaved bytes', async () => {
    const root = await disposableProject();
    const sessions = new ActiveProjectSessionService();
    let worker: Worker | null = null;
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: addonPath!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 100,
      createWorker: (script: string, options: WorkerOptions) => {
        worker = new Worker(script, options);
        return worker;
      },
    });
    let controller = new NativeEditorSessionController(
      sessions,
      bridge,
      new NativeAuthoringWorkingProject(bridge),
    );
    try {
      const { id, revision } = await admit(root, sessions, controller);
      const original = await roomBytes(root, roomA);
      const patch = await controller.applyRevisionedPatches(id, revision, [
        {
          op: 'replace',
          path: `/rooms/${roomA}/data/displayName`,
          value: 'Recovered after killed worker',
        },
      ]);
      expect(patch.accepted, patch.error).toBe(true);
      expect(await roomBytes(root, roomA)).toBe(original);
      expect(worker).not.toBeNull();
      await worker!.terminate();
      await vi.waitFor(() => expect(controller.isAdmitted(id)).toBe(false));
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('Recovered after killed worker');
      expect(await roomBytes(root, roomA)).toBe(original);
      const saved = await controller.saveUnit(
        reopened.id,
        reopened.revision,
        `record:rooms:${roomA}`,
        {},
      );
      expect(saved.accepted, saved.error).toBe(true);
      expect(await roomBytes(root, roomA)).toContain('Recovered after killed worker');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
