import { describe, expect, it } from 'vite-plus/test';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';

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
  return { id, revision: result.revision };
}

async function roomBytes(root: string, id: string) {
  return readFile(path.join(root, `records/rooms/${id}.yaml`), 'utf8');
}

describe.skipIf(!addonPath)('#608 real native Save and recovery integration', () => {
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
