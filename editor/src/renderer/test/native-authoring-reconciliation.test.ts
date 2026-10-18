import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import type { JsonValue } from '../project/json-value';

const addon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
const roomId = 'room-lifecycle-roundtrip';
const owner = `rooms/${roomId}`;
const labelPath = `/rooms/${roomId}/label`;
const descriptionPath = `/rooms/${roomId}/data/description/source/text`;
const roomRelative = `records/rooms/${roomId}.yaml`;
const fixture = path.resolve(process.cwd(), '../tests/projects/feature-lab');
const workerScript = path.resolve(
  process.cwd(),
  'dist-electron/authoring-worker/native-authoring-worker.cjs',
);

async function testProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-reconcile-'));
  for (const file of [
    'project.yaml',
    'traits.yaml',
    'editor.yaml',
    'i18n/project.yaml',
    'i18n/messages.yaml',
    'i18n/usage-notes.yaml',
    'i18n/tracking.yaml',
    'i18n/orphans.yaml',
    roomRelative,
    'records/variables/board-ticket.yaml',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(fixture, file), path.join(root, file));
  }
  const bridge = new NativeAuthoringSessionBridge(
    { requireActiveProjectRoot: () => root, isCurrent: () => true },
    { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 100 },
  );
  const working = new NativeAuthoringWorkingProject(bridge);
  await working.open('native-reconcile-test');
  await working.inspectRecord(owner);
  return { root, bridge, working, roomPath: path.join(root, roomRelative) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.skipIf(!addon)('native dirty Project reconciliation and transactional Save (#498)', () => {
  it('saves generic localization and manifest patches through their real physical owners', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-localization-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 100 },
    );
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('native-localization-save');
    const id = '25700000-0000-4000-8000-000000000001';
    const localizedPath = `/localization/messages/${id}/source`;
    const source = 'Greetings, {name}!';
    const manifestPath = path.join(root, 'project.yaml');
    const messagePath = path.join(root, 'i18n/messages.yaml');
    const beforeManifest = await readFile(manifestPath, 'utf8');
    const beforeMessages = await readFile(messagePath, 'utf8');
    const patch = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'replace', path: '/project/name', value: 'Native localized Save' },
      { op: 'replace', path: localizedPath, value: source },
    ]);
    expect(patch).toMatchObject({
      accepted: true,
      affectedRecords: ['i18n/messages.yaml', 'project'],
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    expect(await readFile(messagePath, 'utf8')).toBe(beforeMessages);
    const saved = await working.saveOwners(['i18n/messages.yaml', 'project'], {
      pathsByOwner: {
        'i18n/messages.yaml': [`/messages/${id}/source`],
        project: ['/project/name'],
      },
    });
    expect(saved).toMatchObject({
      accepted: true,
      affectedRecords: ['i18n/messages.yaml', 'project'],
    });
    expect(await readFile(manifestPath, 'utf8')).toContain('Native localized Save');
    expect(await readFile(messagePath, 'utf8')).toContain(source);
    await working.reopenAndReplay('native-localization-save');
    expect(working.snapshot()?.source).toMatchObject({
      project: { name: 'Native localized Save' },
    });
    expect(
      (await working.inspectRecord('i18n/messages.yaml')).snapshot.recordSnapshots?.[
        'i18n/messages.yaml'
      ]?.source,
    ).toMatchObject({ messages: { [id]: { source } } });
  }, 120_000);
  it('replays, discards, and atomically saves persisted-record deletion with exact source CAS', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const id = 'native-deletion-probe';
    const createdOwner = `rooms/${id}`;
    const createdPath = path.join(root, `records/rooms/${id}.yaml`);
    const source = working.snapshot()!.recordSnapshots![owner]!.source as Record<string, unknown>;
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: `/rooms/${id}`, value: { ...source, id } },
        ])
      ).accepted,
    ).toBe(true);
    expect((await working.saveOwners([createdOwner])).accepted).toBe(true);
    const originalSource = await readFile(createdPath, 'utf8');

    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'remove', path: `/rooms/${id}` },
        ])
      ).accepted,
    ).toBe(true);
    expect(working.snapshot()?.recordSnapshots?.[createdOwner]).toBeUndefined();
    expect(await readFile(createdPath, 'utf8')).toBe(originalSource);
    await working.reopenAndReplay('native-reconcile-test');
    expect(working.snapshot()?.recordSnapshots?.[createdOwner]).toBeUndefined();
    expect((await working.useDiskUnit(`record:rooms:${id}`)).accepted).toBe(true);
    expect(working.snapshot()?.recordSnapshots?.[createdOwner]?.source).toMatchObject({ id });

    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'remove', path: `/rooms/${id}` },
        ])
      ).accepted,
    ).toBe(true);
    const committed = await working.saveOwners([createdOwner], { comments: 'remove' });
    expect(committed).toMatchObject({ accepted: true, affectedRecords: [createdOwner] });
    await expect(readFile(createdPath)).rejects.toThrow();
    expect(working.snapshot()?.recordSnapshots?.[createdOwner]).toBeUndefined();
    await working.reopenAndReplay('native-reconcile-test');
    expect(working.snapshot()?.recordSnapshots?.[createdOwner]).toBeUndefined();

    const staleId = 'native-deletion-conflict';
    const staleOwner = `rooms/${staleId}`;
    const stalePath = path.join(root, `records/rooms/${staleId}.yaml`);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: `/rooms/${staleId}`, value: { ...source, id: staleId } },
        ])
      ).accepted,
    ).toBe(true);
    expect((await working.saveOwners([staleOwner])).accepted).toBe(true);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'remove', path: `/rooms/${staleId}` },
        ])
      ).accepted,
    ).toBe(true);
    await writeFile(stalePath, (await readFile(stalePath, 'utf8')) + '# external update\n');
    expect((await working.saveOwners([staleOwner], { comments: 'remove' })).accepted).toBe(false);
    expect(await readFile(stalePath, 'utf8')).toContain('external update');
  }, 120_000);
  it('commits YAML and staged RML atomically and refuses a conflicting mixed transaction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-mixed-transaction-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 100 },
    );
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('mixed-transaction');
    const room = 'rooms/room-lifecycle-roundtrip';
    expect((await working.inspectRecord(room)).accepted).toBe(true);
    const yamlPath = path.join(root, roomRelative);
    const initialYaml = await readFile(yamlPath, 'utf8');
    const textPath = 'records/layouts/notice-board/layout.rml';
    const textFile = path.join(root, textPath);
    const initialText = await readFile(textFile, 'utf8');
    const newLabel = 'Mixed native YAML commit';
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'replace', path: `/rooms/${roomId}/label`, value: newLabel },
        ])
      ).accepted,
    ).toBe(true);
    const firstText = `${initialText}\n<!-- mixed native -->\n`;
    expect((await working.stageTextSource(textPath, firstText)).accepted).toBe(true);
    await expect(
      working.saveOwners([room], {
        textPaths: [textPath],
        textContents: { [textPath]: 'unacknowledged bytes' },
      }),
    ).rejects.toThrow('changed before mixed Save');
    const result = await working.saveOwners([room], {
      textPaths: [textPath],
      textContents: { [textPath]: firstText },
    });
    expect(result).toMatchObject({
      accepted: true,
      textSourceDiskRevisions: {
        [textPath]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(await readFile(yamlPath, 'utf8')).toContain(newLabel);
    expect(await readFile(textFile, 'utf8')).toContain('mixed native');

    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'replace', path: `/rooms/${roomId}/label`, value: 'Must not persist' },
        ])
      ).accepted,
    ).toBe(true);
    const secondText = `${initialText}\n<!-- pending -->\n`;
    expect((await working.stageTextSource(textPath, secondText)).accepted).toBe(true);
    await writeFile(textFile, `${initialText}\n<!-- external change -->\n`);
    expect(
      (
        await working.saveOwners([room], {
          textPaths: [textPath],
          textContents: { [textPath]: secondText },
        })
      ).accepted,
    ).toBe(false);
    expect(await readFile(yamlPath, 'utf8')).toContain(newLabel);
    expect(await readFile(textFile, 'utf8')).toContain('external change');
    expect(await readFile(yamlPath, 'utf8')).not.toBe(initialYaml);
  }, 120_000);
  it('stages and transactionally creates a new generic record without a legacy writer', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const existing = await readFile(path.join(root, roomRelative), 'utf8');
    const newId = 'created-natively';
    const newPath = path.join(root, `records/rooms/${newId}.yaml`);
    const candidate = {
      ...(working.snapshot()!.recordSnapshots![owner]!.source as Record<string, unknown>),
      id: newId,
    };
    const initial = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'add', path: `/rooms/${newId}`, value: candidate },
    ]);
    expect(initial).toMatchObject({ accepted: true, affectedRecords: [`rooms/${newId}`] });
    expect((await working.inspectRecord(`rooms/${newId}`)).accepted).toBe(true);
    const renamed = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'replace', path: `/rooms/${newId}/label`, value: 'Created with native editing' },
    ]);
    expect(renamed.accepted).toBe(true);
    await expect(readFile(newPath)).rejects.toThrow();
    const replayed = await working.reopenAndReplay('native-reconcile-test');
    expect(replayed.recordSnapshots?.[`rooms/${newId}`]?.source).toMatchObject({
      label: 'Created with native editing',
    });
    const saved = await working.saveOwners([`rooms/${newId}`]);
    expect(saved).toMatchObject({ accepted: true });
    expect(await readFile(newPath, 'utf8')).toContain('Created with native editing');
    expect(await readFile(path.join(root, roomRelative), 'utf8')).toBe(existing);

    const abandonedId = 'cancelled-before-save';
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: `/rooms/${abandonedId}`, value: { ...candidate, id: abandonedId } },
        ])
      ).accepted,
    ).toBe(true);
    const cancelled = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'remove', path: `/rooms/${abandonedId}` },
    ]);
    expect(cancelled).toMatchObject({ accepted: true, affectedRecords: [`rooms/${abandonedId}`] });
    expect(working.snapshot()?.recordSnapshots?.[`rooms/${abandonedId}`]).toBeUndefined();
    const survivingId = 'surviving-new-record';
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: `/rooms/${survivingId}`, value: { ...candidate, id: survivingId } },
        ])
      ).accepted,
    ).toBe(true);
    expect(
      (await working.reopenAndReplay('native-reconcile-test')).recordSnapshots?.[
        `rooms/${abandonedId}`
      ],
    ).toBeUndefined();
    expect(working.snapshot()?.recordSnapshots?.[`rooms/${survivingId}`]?.source).toMatchObject({
      id: survivingId,
    });
    const discarded = await working.useDiskUnit(`record:rooms:${survivingId}`);
    expect(discarded).toMatchObject({ accepted: true });
    expect(working.snapshot()?.recordSnapshots?.[`rooms/${survivingId}`]).toBeUndefined();
    expect(
      (await working.reopenAndReplay('native-reconcile-test')).recordSnapshots?.[
        `rooms/${survivingId}`
      ],
    ).toBeUndefined();
    await expect(readFile(path.join(root, `records/rooms/${abandonedId}.yaml`))).rejects.toThrow();

    const colliding = { ...candidate, id: 'taken-externally' };
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: '/rooms/taken-externally', value: colliding },
        ])
      ).accepted,
    ).toBe(true);
    const collisionFile = path.join(root, 'records/rooms/taken-externally.yaml');
    await writeFile(collisionFile, 'id: taken-externally\nlabel: Disk owns this file\n');
    expect((await working.saveOwners(['rooms/taken-externally'])).accepted).toBe(false);
    expect(await readFile(collisionFile, 'utf8')).toContain('Disk owns this file');
  }, 120_000);
  it('saves a staged RML text source transactionally, retaining exact bytes and disk preconditions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-source-save-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 100 },
    );
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('native-source-save');
    const relative = 'records/layouts/notice-board/layout.rml';
    const file = path.join(root, relative);
    const original = await readFile(file, 'utf8');
    const first = original + '\n<!-- accepted native edit -->\n';
    const staged = await working.stageTextSource(relative, first);
    expect(staged).toMatchObject({ accepted: true, textSourceStaged: true });
    expect(await readFile(file, 'utf8')).toBe(original);
    const saved = await working.saveTextSources(working.snapshot()!.workingRevision, [relative]);
    expect(saved).toMatchObject({
      accepted: true,
      textSourceDiskRevisions: {
        [relative]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(await readFile(file, 'utf8')).toBe(first);
    expect((await working.prepareWorking()).textOverlays[relative]).toBeUndefined();
    bridge.close();
    await working.reopenAndReplay('native-source-save');
    expect((await working.prepareWorking()).textOverlays[relative]).toBeUndefined();

    const second = first + '<!-- unsaved overlay -->\n';
    expect((await working.stageTextSource(relative, second)).accepted).toBe(true);
    await writeFile(file, first + '<!-- external edit -->\n');
    const rejected = await working.saveTextSources(working.snapshot()!.workingRevision, [relative]);
    expect(rejected).toMatchObject({ accepted: false });
    expect(await readFile(file, 'utf8')).toContain('external edit');
  }, 120_000);

  it('replays acknowledged unsaved RML text with exact disk preconditions and rejects changed sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-text-replay-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 100 },
    );
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('text-replay');
    const source = 'records/layouts/notice-board/layout.rml';
    const physical = path.join(root, source);
    const original = await readFile(physical, 'utf8');
    const dirty = `${original}\n<!-- Native unsaved RML -->\n`;
    expect(await working.stageTextSource('scripts/not-admitted.lua', 'return true')).toMatchObject({
      accepted: false,
      error: expect.stringContaining('admitted canonical'),
    });
    expect(working.snapshot()).not.toBeNull();
    expect(
      (
        await working.applyAction(
          [{ op: 'replace', path: '/project/name', value: 'Unsaved alongside RML' }],
          [{ op: 'replace', path: '/project/name', value: 'Feature Lab' }],
        )
      ).accepted,
    ).toBe(true);
    expect(await working.stageTextSource(source, dirty)).toMatchObject({
      accepted: true,
      textSourceStaged: true,
    });
    expect(await readFile(physical, 'utf8')).toBe(original);
    bridge.close();
    const replayed = await working.reopenAndReplay('text-replay');
    expect(replayed.source).toMatchObject({ project: { name: 'Unsaved alongside RML' } });
    const restored = await working.prepareWorking();
    expect(restored.accepted).toBe(true);
    expect(restored.textOverlays[source]).toBe(dirty);

    expect(await working.stageTextSource(source, original)).toMatchObject({
      accepted: true,
      textSourceStaged: false,
    });
    bridge.close();
    await working.reopenAndReplay('text-replay');
    expect((await working.prepareWorking()).textOverlays[source]).toBeUndefined();

    expect((await working.stageTextSource(source, dirty)).accepted).toBe(true);
    await writeFile(physical, `${original}\n<!-- External change -->\n`);
    bridge.close();
    await expect(working.reopenAndReplay('text-replay')).rejects.toThrow(
      `Native Project text-source recovery conflict for ${source}`,
    );
    expect(working.snapshot()).toBeNull();
    expect(await readFile(physical, 'utf8')).toContain('External change');
  }, 120_000);

  it('routes collection and export-profile Save units without committing unrelated owners', async () => {
    const { root, bridge, working, roomPath } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const variablePath = path.join(root, 'records/variables/board-ticket.yaml');
    const projectPath = path.join(root, 'project.yaml');
    const originalRoom = await readFile(roomPath, 'utf8');
    const originalProject = await readFile(projectPath, 'utf8');
    const originalVariable = await readFile(variablePath, 'utf8');
    const changes = await working.applyAction(
      [
        { op: 'replace', path: '/variables/board-ticket/label', value: 'Collection edit' },
        { op: 'replace', path: labelPath, value: 'Unrelated dirty Room' },
        { op: 'replace', path: '/export/runtime/label', value: 'Native Runtime Package' },
      ],
      [],
    );
    expect(changes.accepted).toBe(true);
    expect(await working.saveUnit('collection:variables')).toMatchObject({ accepted: true });
    expect(await readFile(variablePath, 'utf8')).toContain('Collection edit');
    expect(await readFile(roomPath, 'utf8')).toBe(originalRoom);
    expect(await readFile(projectPath, 'utf8')).toBe(originalProject);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(true);
    expect(await working.saveUnit('project:platform-export-profiles')).toMatchObject({
      accepted: true,
    });
    expect(await readFile(projectPath, 'utf8')).toContain('Native Runtime Package');
    expect(await readFile(variablePath, 'utf8')).not.toBe(originalVariable);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(true);
  }, 45_000);

  it('routes localization Save to its physical source owners without saving a dirty Room', async () => {
    const { root, bridge, working, roomPath } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const messagesPath = path.join(root, 'i18n/messages.yaml');
    const originalRoom = await readFile(roomPath, 'utf8');
    const edited = await working.applyAction(
      [
        {
          op: 'replace',
          path: '/localization/messages/25700000-0000-4000-8000-000000000002/source',
          value: 'Read a different letter',
        },
        { op: 'replace', path: labelPath, value: 'Unrelated Room change' },
      ],
      [],
    );
    expect(edited.accepted).toBe(true);
    expect(await working.saveUnit('project:localization')).toMatchObject({ accepted: true });
    expect(await readFile(messagesPath, 'utf8')).toContain('Read a different letter');
    expect(await readFile(roomPath, 'utf8')).toBe(originalRoom);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(true);
  }, 45_000);

  it('saves Traits, Tags, and one record metadata unit without publishing unrelated dirty owners', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const traitsPath = path.join(root, 'traits.yaml');
    const editorPath = path.join(root, 'editor.yaml');
    const originalTraits = await readFile(traitsPath, 'utf8');
    const originalEditor = await readFile(editorPath, 'utf8');
    const traitLabel = '/traits/lab-layered/label';
    const tag = '/editor/tags/records/review';
    const metadata = `/editor/recordMetadata/rooms/${roomId}`;
    const edited = await working.applyAction(
      [
        { op: 'replace', path: traitLabel, value: 'Edited native Trait' },
        { op: 'add', path: tag, value: { name: 'Review', color: '#00aacc' } },
        { op: 'add', path: metadata, value: { tags: ['review'] } },
      ],
      [
        { op: 'remove', path: metadata },
        { op: 'remove', path: tag },
        { op: 'replace', path: traitLabel, value: 'Layered specimen' },
      ],
    );
    expect(edited).toMatchObject({ accepted: true, affectedRecords: ['editor', 'traits'] });
    expect(await working.saveUnit('project:tags')).toMatchObject({
      accepted: true,
      affectedRecords: ['editor'],
    });
    expect(await readFile(traitsPath, 'utf8')).toBe(originalTraits);
    expect(await readFile(editorPath, 'utf8')).not.toBe(originalEditor);
    expect(await readFile(editorPath, 'utf8')).not.toContain(roomId);
    expect(working.snapshot()?.recordSnapshots?.traits?.dirty).toBe(true);
    expect(working.snapshot()?.recordSnapshots?.editor?.dirty).toBe(true);

    expect(await working.saveUnit('collection:traits')).toMatchObject({
      accepted: true,
      affectedRecords: ['traits'],
    });
    expect(await readFile(traitsPath, 'utf8')).toContain('Edited native Trait');
    expect(working.snapshot()?.recordSnapshots?.editor?.dirty).toBe(true);
    expect(await working.saveUnit(`record:rooms:${roomId}`)).toMatchObject({
      accepted: true,
      affectedRecords: ['editor'],
    });
    expect(await readFile(editorPath, 'utf8')).toContain(roomId);
    expect(working.snapshot()?.dirty).toBe(false);
  });

  it('merges disjoint same-record changes, retains dirty recovery, and writes only selected owners', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const original = await readFile(roomPath, 'utf8');
    const description = 'Edited while Room was open';
    const watcherChanged: string[] = [];
    const unsubscribe = bridge.subscribe((delta) =>
      watcherChanged.push(...delta.changedSourcePaths),
    );
    expect(
      (
        await working.applyAction(
          [{ op: 'replace', path: descriptionPath, value: description }],
          [
            {
              op: 'replace',
              path: descriptionPath,
              value: 'Return to the lifecycle start, or enter the child-flow room.',
            },
          ],
        )
      ).accepted,
    ).toBe(true);

    // Real watcher delivers the file revision, then resident native Project
    // reconciles its independently retained local working source.
    await writeFile(
      roomPath,
      original.replace(
        'label: Lifecycle Round Trip',
        'label: Changed externally\n# keep room note',
      ),
    );
    const observed = await bridge.request({ operation: 'observe' });
    expect([
      ...watcherChanged,
      ...(observed && 'changed' in observed ? observed.changed : []),
    ]).toContain(roomRelative);
    unsubscribe();
    const reconciled = await working.reconcile(owner);
    expect(reconciled).toMatchObject({ accepted: true, affectedRecords: [owner] });
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      label: 'Changed externally',
      data: { description: { source: { text: description } } },
    });
    expect(working.snapshot()?.recordSnapshots?.[owner]?.conflictingPaths).toEqual([]);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(true);

    bridge.close();
    const recovered = await working.reopenAndReplay('native-reconcile-test');
    expect(recovered.recordSnapshots?.[owner]?.source).toMatchObject({
      label: 'Changed externally',
      data: { description: { source: { text: description } } },
    });
    const saved = await working.saveOwners([owner], { comments: 'keep' });
    expect(saved).toMatchObject({
      accepted: true,
      affectedRecords: [owner],
      snapshot: { dirty: false, recordSnapshots: { [owner]: { dirty: false } } },
    });
    const physical = await readFile(roomPath, 'utf8');
    expect(physical).toContain('label: Changed externally');
    expect(physical).toContain('# keep room note');
    expect(physical).toContain(description);
    expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(
      await readFile(path.join(fixture, 'project.yaml'), 'utf8'),
    );
  }, 45_000);

  it('preserves conflicting local work, blocks Save, and validates Keep Mine against a second edit', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const original = await readFile(roomPath, 'utf8');
    await working.applyAction(
      [{ op: 'replace', path: labelPath, value: 'Mine' }],
      [{ op: 'replace', path: labelPath, value: 'Lifecycle Round Trip' }],
    );
    await writeFile(roomPath, original.replace('label: Lifecycle Round Trip', 'label: Theirs'));
    const conflict = await working.reconcile(owner);
    expect(conflict).toMatchObject({
      accepted: true,
      snapshot: { recordSnapshots: { [owner]: { conflictingPaths: ['/label'] } } },
    });
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({ label: 'Mine' });
    expect(await working.saveOwners([owner])).toMatchObject({
      accepted: false,
      error: expect.stringContaining('Use Disk or Keep Mine'),
    });
    // A second external change after the conflict was reviewed cannot be overwritten.
    await writeFile(
      roomPath,
      original.replace('label: Lifecycle Round Trip', 'label: Third Writer'),
    );
    const stale = await working.saveOwners([owner], { keepMine: true });
    expect(stale).toMatchObject({
      accepted: false,
      error: expect.stringContaining('REVISION_CONFLICT'),
    });
    expect(await readFile(roomPath, 'utf8')).toContain('label: Third Writer');
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({ label: 'Mine' });
    expect((await working.reconcile(owner)).accepted).toBe(true);
    const saved = await working.saveOwners([owner], { keepMine: true });
    expect(saved).toMatchObject({ accepted: true, snapshot: { dirty: false } });
    expect(await readFile(roomPath, 'utf8')).toContain('label: Mine');
  }, 45_000);

  it('conservatively conflicts structural arrays and supports Use Disk and tracked editor metadata', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const original = await readFile(roomPath, 'utf8');
    await working.applyAction(
      [{ op: 'replace', path: `/rooms/${roomId}/data/exits/0/label`, value: 'My exit' }],
      [
        {
          op: 'replace',
          path: `/rooms/${roomId}/data/exits/0/label`,
          value: 'Return to lifecycle start',
        },
      ],
    );
    await writeFile(
      roomPath,
      original.replace('label: Enter child flow', 'label: External exit change'),
    );
    const conflict = await working.reconcile(owner);
    expect(conflict.snapshot.recordSnapshots?.[owner]?.conflictingPaths).toContain('/data/exits');
    expect((await working.useDisk(owner)).snapshot.recordSnapshots?.[owner]).toMatchObject({
      dirty: false,
      conflictingPaths: [],
    });
    expect(working.historyCursor()).toBe(0);
    const source = working.snapshot()?.recordSnapshots?.[owner]?.source;
    if (!source) throw new Error('Missing Room source after Use Disk.');
    const exits = (source as { data: { exits: Array<{ label: string }> } }).data.exits;
    expect(exits.map((exit) => exit.label)).toEqual([
      'Return to lifecycle start',
      'External exit change',
      'Self loop',
    ]);

    const editor = await working.inspectRecord('editor');
    expect(editor).toMatchObject({
      accepted: true,
      snapshot: { recordSnapshots: { editor: { dirty: false } } },
    });
    const changedEditor = await working.applyAction(
      [{ op: 'add', path: '/editor/recordMetadata/rooms', value: { [roomId]: { tags: [] } } }],
      [{ op: 'remove', path: '/editor/recordMetadata/rooms' }],
    );
    if (!changedEditor.accepted) throw new Error(changedEditor.error);
    expect((await working.inspectRecord('variables/board-ticket')).accepted).toBe(true);
    const variablePath = '/variables/board-ticket/label';
    expect(
      (
        await working.applyAction(
          [{ op: 'replace', path: variablePath, value: 'Changed variable label' }],
          [{ op: 'replace', path: variablePath, value: 'board-ticket' }],
        )
      ).accepted,
    ).toBe(true);
    expect(
      (await working.saveOwners(['editor', 'variables/board-ticket'], { comments: 'cancel' }))
        .accepted,
    ).toBe(false);
    const savedEditor = await working.saveOwners(['editor', 'variables/board-ticket']);
    if (!savedEditor.accepted) throw new Error(savedEditor.error);
    expect(await readFile(path.join(root, 'editor.yaml'), 'utf8')).toContain(roomId);
    expect(
      await readFile(path.join(root, 'records/variables/board-ticket.yaml'), 'utf8'),
    ).toContain('Changed variable label');
  }, 45_000);

  it('blocks invalid source owners without discarding unrelated tracked metadata edits', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    await working.inspectRecord('editor');
    const originalEditor = await readFile(path.join(root, 'editor.yaml'), 'utf8');
    const changed = await working.applyAction(
      [{ op: 'add', path: '/editor/recordMetadata/rooms', value: { [roomId]: { tags: [] } } }],
      [{ op: 'remove', path: '/editor/recordMetadata/rooms' }],
    );
    expect(changed.accepted).toBe(true);
    await working.applyAction(
      [{ op: 'replace', path: descriptionPath, value: 'dirty Room field' }],
      [
        {
          op: 'replace',
          path: descriptionPath,
          value: 'Return to the lifecycle start, or enter the child-flow room.',
        },
      ],
    );
    const invalidPaths: string[] = [];
    const unsubscribe = bridge.subscribe((delta) => {
      invalidPaths.push(...delta.observation.invalidSources.map((source) => source.path));
    });
    await writeFile(roomPath, 'id: [\n');
    const observation = await bridge.request({ operation: 'observe' });
    if (observation && 'invalidSources' in observation)
      invalidPaths.push(...observation.invalidSources.map((source) => source.path));
    expect(invalidPaths).toContain(roomRelative);
    unsubscribe();
    const mixed = await working.saveOwners(['editor', owner]);
    expect(mixed.accepted).toBe(false);
    expect(await readFile(path.join(root, 'editor.yaml'), 'utf8')).toBe(originalEditor);
    const unaffected = await working.saveOwners(['editor']);
    if (!unaffected.accepted) throw new Error(unaffected.error);
    expect(await readFile(path.join(root, 'editor.yaml'), 'utf8')).toContain(roomId);
    expect(await readFile(roomPath, 'utf8')).toBe('id: [\n');
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(true);
  }, 45_000);

  it('merges disjoint external edits to the shared tracked editor metadata source', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const editorPath = path.join(root, 'editor.yaml');
    await working.inspectRecord('editor');
    const changed = await working.applyAction(
      [{ op: 'add', path: '/editor/recordMetadata/rooms', value: { [roomId]: { tags: [] } } }],
      [{ op: 'remove', path: '/editor/recordMetadata/rooms' }],
    );
    expect(changed.accepted).toBe(true);
    const baseline = await readFile(editorPath, 'utf8');
    await writeFile(
      editorPath,
      baseline.replace('assignments: {}', 'assignments:\n    featured: []'),
    );
    const result = await working.reconcile('editor');
    expect(result).toMatchObject({
      accepted: true,
      snapshot: {
        recordSnapshots: {
          editor: {
            conflictingPaths: [],
            dirty: true,
            source: {
              chapters: { assignments: { featured: [] } },
              recordMetadata: { rooms: { [roomId]: { tags: [] } } },
            },
          },
        },
      },
    });
    const save = await working.saveOwners(['editor']);
    if (!save.accepted) throw new Error(save.error);
    const persisted = await readFile(editorPath, 'utf8');
    expect(persisted).toContain('featured');
    expect(persisted).toContain(roomId);
  }, 45_000);

  it('restores unresolved conflicts across worker restart so ordinary Save remains blocked', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const baseline = await readFile(roomPath, 'utf8');
    await working.applyAction(
      [{ op: 'replace', path: labelPath, value: 'Mine' }],
      [{ op: 'replace', path: labelPath, value: 'Lifecycle Round Trip' }],
    );
    await writeFile(roomPath, baseline.replace('label: Lifecycle Round Trip', 'label: Theirs'));
    expect(
      (await working.reconcile(owner)).snapshot.recordSnapshots?.[owner]?.conflictingPaths,
    ).toEqual(['/label']);
    bridge.close();
    const replayed = await working.reopenAndReplay('native-reconcile-test');
    expect(replayed.recordSnapshots?.[owner]?.conflictingPaths).toEqual(['/label']);
    const rejected = await working.saveOwners([owner]);
    expect(rejected).toMatchObject({
      accepted: false,
      error: expect.stringContaining('Use Disk or Keep Mine'),
    });
    expect(await readFile(roomPath, 'utf8')).toContain('label: Theirs');
    const accepted = await working.saveOwners([owner], { keepMine: true });
    if (!accepted.accepted) throw new Error(accepted.error);
    expect(await readFile(roomPath, 'utf8')).toContain('label: Mine');
  }, 45_000);

  it('invalidates an ancestor undo/redo action after merging an external descendant', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const source = working.snapshot()?.recordSnapshots?.[owner]?.source;
    if (!source) throw new Error('No initial Room source.');
    const data = (source as { data: Record<string, JsonValue> }).data;
    await working.applyAction(
      [
        {
          op: 'replace',
          path: `/rooms/${roomId}/data`,
          value: {
            ...data,
            description: { source: { kind: 'inline', text: 'Mine' } },
          },
        },
      ],
      [{ op: 'replace', path: `/rooms/${roomId}/data`, value: data }],
    );
    expect(working.historyCursor()).toBe(1);
    const baseline = await readFile(roomPath, 'utf8');
    await writeFile(
      roomPath,
      baseline.replace(
        'displayName: Lifecycle Round Trip Destination',
        'displayName: External Display',
      ),
    );
    const merged = await working.reconcile(owner);
    expect(merged.snapshot.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { displayName: 'External Display', description: { source: { text: 'Mine' } } },
    });
    expect(working.historyCursor()).toBe(0);
    await expect(working.undo()).rejects.toThrow('No native Project command to undo');
    await expect(working.redo()).rejects.toThrow('No native Project command to redo');
  }, 45_000);

  it('projects normalized default fields into sparse source and omits them on inverse', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const markup = `/rooms/${roomId}/data/description/markup`;
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { description: { source: { kind: 'inline' } } },
    });
    const changed = await working.applyAction(
      [{ op: 'replace', path: markup, value: 'plain' }],
      [{ op: 'replace', path: markup, value: 'active-text' }],
    );
    if (!changed.accepted) throw new Error(changed.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { description: { markup: 'plain' } },
    });
    const undone = await working.undo();
    if (!undone.accepted) throw new Error(undone.error);
    const undoneSource = working.snapshot()?.recordSnapshots?.[owner]?.source;
    if (!undoneSource) throw new Error('Missing Room after inverse projection.');
    const description = (
      undoneSource as {
        data: { description: Record<string, unknown> };
      }
    ).data.description;
    expect(description).not.toHaveProperty('markup');
    expect(working.snapshot()?.dirty).toBe(false);
  }, 45_000);

  it('materializes an implicit normalized anchors array for add, and restores omission on undo', async () => {
    const { root, bridge, working, roomPath } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const anchorsPath = `/rooms/${roomId}/data/anchors`;
    const anchor = {
      id: 'review-anchor',
      bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
    };
    const initialSource = working.snapshot()?.recordSnapshots?.[owner]?.source as {
      data: Record<string, unknown>;
    };
    expect(initialSource.data).not.toHaveProperty('anchors');
    expect(working.snapshot()?.recordSnapshots?.[owner]?.normalized).toMatchObject({
      data: { anchors: [] },
    });
    const added = await working.applyAction(
      [{ op: 'add', path: `${anchorsPath}/0`, value: anchor }],
      [{ op: 'remove', path: `${anchorsPath}/0` }],
    );
    if (!added.accepted) throw new Error(added.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { anchors: [anchor] },
    });
    const undone = await working.undo();
    if (!undone.accepted) throw new Error(undone.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toEqual(initialSource);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(false);
    const redone = await working.redo();
    if (!redone.accepted) throw new Error(redone.error);
    const saved = await working.saveOwners([owner]);
    if (!saved.accepted) throw new Error(saved.error);
    const physical = await readFile(roomPath, 'utf8');
    expect(physical).toContain('anchors:');
    expect(physical).toContain('review-anchor');
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(false);
  }, 45_000);

  it('uses authoritative Project Settings paths for asset-memory Save and Use Disk', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const manifest = path.join(root, 'project.yaml');
    const policyPath = '/export/assetMemoryPolicies';
    const policies = [
      { id: 'review-memory', label: 'Review memory', basePreset: 'balanced', overrides: {} },
    ];
    const changed = await working.applyAction(
      [{ op: 'replace', path: policyPath, value: policies }],
      [{ op: 'replace', path: policyPath, value: [] }],
    );
    if (!changed.accepted) throw new Error(changed.error);
    const saved = await working.saveUnit('project:settings');
    if (!saved.accepted) throw new Error(saved.error);
    const physical = await readFile(manifest, 'utf8');
    expect(physical).toContain('review-memory');
    expect(working.snapshot()?.dirty).toBe(false);

    const dirty = await working.applyAction(
      [
        { op: 'replace', path: policyPath, value: [] },
        { op: 'replace', path: '/export/profiles', value: [] },
      ],
      [],
    );
    if (!dirty.accepted) throw new Error(dirty.error);
    const discarded = await working.useDiskUnit('project:settings');
    if (!discarded.accepted) throw new Error(discarded.error);
    expect(working.snapshot()?.source).toMatchObject({
      export: { assetMemoryPolicies: policies, profiles: [] },
    });
    expect(working.snapshot()?.dirty).toBe(true);
    expect(await readFile(manifest, 'utf8')).toBe(physical);
  }, 45_000);

  it('projects expanded normalized references to sparse YAML IDs including nested editor edits', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const pathToAsset = `/rooms/${roomId}/data/background/asset`;
    const reference = (id: string) => ({ $ref: { collection: 'assets', id } });
    const changed = await working.applyAction(
      [{ op: 'replace', path: pathToAsset, value: reference('pilot-guide') }],
      [{ op: 'replace', path: pathToAsset, value: reference('pilot-room-backdrop') }],
    );
    if (!changed.accepted) throw new Error(changed.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { background: { asset: 'pilot-guide' } },
    });
    expect((await working.undo()).accepted).toBe(true);
    expect(working.snapshot()?.dirty).toBe(false);
    const nested = await working.applyAction(
      [{ op: 'replace', path: `${pathToAsset}/$ref/id`, value: 'pilot-guide' }],
      [{ op: 'replace', path: `${pathToAsset}/$ref/id`, value: 'pilot-room-backdrop' }],
    );
    if (!nested.accepted) throw new Error(nested.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      data: { background: { asset: 'pilot-guide' } },
    });
    expect((await working.undo()).accepted).toBe(true);
    expect(working.snapshot()?.dirty).toBe(false);
  }, 45_000);

  it('saves and discards one logical Room unit without affecting unrelated shared editor metadata', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    await working.inspectRecord('editor');
    await working.applyAction(
      [
        { op: 'replace', path: labelPath, value: 'Room Unit' },
        {
          op: 'add',
          path: '/editor/recordMetadata/rooms',
          value: {
            [roomId]: { tags: [] },
          },
        },
        {
          op: 'add',
          path: '/editor/recordMetadata/characters',
          value: {
            unrelated: { tags: [] },
          },
        },
      ],
      [],
    );
    const saved = await working.saveUnit(`record:rooms:${roomId}`);
    if (!saved.accepted) throw new Error(saved.error);
    expect(await readFile(roomPath, 'utf8')).toContain('label: "Room Unit"');
    const editorSaved = await readFile(path.join(root, 'editor.yaml'), 'utf8');
    expect(editorSaved).toContain(roomId);
    expect(editorSaved).not.toContain('unrelated');
    expect(working.snapshot()?.recordSnapshots?.editor?.dirty).toBe(true);
    const later = await working.applyAction(
      [
        { op: 'replace', path: labelPath, value: 'Unsaved Room label' },
        { op: 'add', path: `/editor/recordMetadata/rooms/${roomId}/color`, value: '#123456' },
      ],
      [],
    );
    if (!later.accepted) throw new Error(later.error);
    const discard = await working.useDiskUnit(`record:rooms:${roomId}`);
    if (!discard.accepted) throw new Error(discard.error);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
      label: 'Room Unit',
    });
    expect(working.snapshot()?.recordSnapshots?.editor?.source).toMatchObject({
      recordMetadata: {
        rooms: { [roomId]: { tags: [] } },
        characters: { unrelated: { tags: [] } },
      },
    });
    const editorSource = working.snapshot()?.recordSnapshots?.editor?.source;
    if (!editorSource) throw new Error('Missing editor metadata after logical Use Disk.');
    const roomMetadata = (
      editorSource as {
        recordMetadata: { rooms: Record<string, Record<string, unknown>> };
      }
    ).recordMetadata.rooms[roomId];
    expect(roomMetadata).not.toHaveProperty('color');
    expect(working.snapshot()?.recordSnapshots?.editor?.dirty).toBe(true);
  }, 45_000);

  it('lazily admits a Room save unit metadata owner when only the Room has been edited', async () => {
    const { root, roomPath, bridge, working } = await testProject();
    cleanups.push(async () => {
      bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    expect(working.snapshot()?.recordSnapshots?.editor).toBeUndefined();
    const edited = await working.applyAction(
      [{ op: 'replace', path: labelPath, value: 'Room only' }],
      [{ op: 'replace', path: labelPath, value: 'Lifecycle Round Trip' }],
    );
    expect(edited.accepted).toBe(true);
    const saved = await working.saveUnit(`record:rooms:${roomId}`);
    if (!saved.accepted) throw new Error(saved.error);
    expect(working.snapshot()?.recordSnapshots?.editor?.dirty).toBe(false);
    expect(working.snapshot()?.recordSnapshots?.[owner]?.dirty).toBe(false);
    expect(await readFile(roomPath, 'utf8')).toContain('Room only');
  }, 45_000);
});
