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
        'My reviewed value',
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
      expect(await roomBytes(root, roomA)).toContain('My reviewed value');
      controller.dispose();
      sessions.closeActiveProject();
      controller = nativeHarness(sessions);
      const reopened = await admit(root, sessions, controller);
      expect(
        (await controller.currentWorkingProject(reopened.id)).rooms[roomA]?.data.displayName,
      ).toBe('My reviewed value');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
