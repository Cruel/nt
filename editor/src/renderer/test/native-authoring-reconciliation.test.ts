import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { toJsonValue, type JsonValue } from '../project/json-value';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import { assertNativeProjection } from '../commands/native-command-execution';
import { replaceRoomDataPatches } from '../project/room-operations';
import { setProjectEntrypointPatches } from '../project/project-settings-operations';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';
import { applyJsonPatch } from '../project/json-patch';
import { decodeStructuredYaml } from '../../shared/project-workspace/structured-yaml-source';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

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
// Reconciliation and Save tests drive observations explicitly. A background
// watcher can consume edits between the test's physical write and its command,
// changing source authority and assertions according to wall-clock timing.
const deterministicPollIntervalMs = 0;

// Windows fork crashes can bypass Vitest's per-test result reporting. Emit
// direct stderr markers only in CI so a native worker exit identifies the
// active test rather than falsely implicating the whole reconciliation suite.
const traceWindowsCI = process.platform === 'win32' && process.env.CI === 'true';
beforeEach(({ task }) => {
  if (traceWindowsCI) process.stderr.write(`[native-reconciliation] START ${task.name}\n`);
});

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
    {
      addonPath: path.resolve(addon!),
      workerScript,
      pollIntervalMs: deterministicPollIntervalMs,
    },
  );
  const working = new NativeAuthoringWorkingProject(bridge);
  await working.open('native-reconcile-test');
  await working.inspectRecord(owner);
  return { root, bridge, working, roomPath: path.join(root, roomRelative) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async ({ task }) => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (traceWindowsCI) process.stderr.write(`[native-reconciliation] END ${task.name}\n`);
});

describe.skipIf(!addon)('native dirty Project reconciliation and transactional Save (#498)', () => {
  it('accepts the editor wizard defaults for new records across collection families', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const families: AuthoringCollectionKey[] = [
      'layouts',
      'rooms',
      'variables',
      'scripts',
      'maps',
      'materials',
      'characters',
      'dialogues',
      'scenes',
      'tests',
      'verbs',
      'interactions',
      'archetypes',
      'interactables',
      'animations',
    ];
    const failures: string[] = [];
    for (const collection of families) {
      const id = `new-wizard-${collection}`;
      const record = createDefaultAuthoringRecord(collection, id, {
        label: 'New record',
        ...(collection === 'layouts' ? { data: defaultLayoutData('New record', 'document') } : {}),
      });
      const patches = [
        { op: 'add' as const, path: `/${collection}/${id}`, value: toJsonValue(record) },
      ];
      const result = await working.applyRevisionedPatches(
        working.snapshot()!.workingRevision,
        patches,
      );
      if (!result.accepted) {
        failures.push(`${collection}: ${result.error}`);
        continue;
      }
      try {
        assertNativeProjection(toJsonValue({ [collection]: { [id]: record } }), patches, result);
        const saved = await working.saveOwners([`${collection}/${id}`]);
        if (!saved.accepted) failures.push(`${collection} save: ${saved.error}`);
      } catch (error) {
        failures.push(`${collection}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
    const invalidRoom = createDefaultAuthoringRecord('rooms', 'new-wizard-invalid-kind');
    const invalid = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      {
        op: 'add',
        path: '/rooms/new-wizard-invalid-kind',
        value: toJsonValue({
          ...invalidRoom,
          data: { ...(invalidRoom.data as Record<string, unknown>), kind: 'map' },
        }),
      },
    ]);
    expect(invalid.accepted).toBe(false);
    expect(invalid.error).toContain('source projection changes the requested value');
    const layout = path.join(root, 'records/layouts/new-wizard-layouts');
    const layoutYaml = decodeStructuredYaml(
      await readFile(path.join(layout, 'layout.yaml'), 'utf8'),
    ) as { data: { rml: { sourceMode: string }; rcss: { sourceMode: string } } };
    expect(layoutYaml.data.rml.sourceMode).toBe('file');
    expect(layoutYaml.data.rcss.sourceMode).toBe('file');
    expect(await readFile(path.join(layout, 'layout.rml'), 'utf8')).toContain('<rml');
    expect(await readFile(path.join(layout, 'layout.rcss'), 'utf8')).not.toBe('');
    const roomYaml = decodeStructuredYaml(
      await readFile(path.join(root, 'records/rooms/new-wizard-rooms.yaml'), 'utf8'),
    ) as { data: Record<string, unknown> };
    expect(roomYaml.data).not.toHaveProperty('kind');
    await working.reopenAndReplay('native-reconcile-test');
    expect((await working.inspectRecord('layouts/new-wizard-layouts')).accepted).toBe(true);
    expect((await working.inspectRecord('rooms/new-wizard-rooms')).accepted).toBe(true);
    expect(
      working.snapshot()?.recordSnapshots?.['layouts/new-wizard-layouts']?.normalized,
    ).toMatchObject({ id: 'new-wizard-layouts' });
    expect(
      working.snapshot()?.recordSnapshots?.['rooms/new-wizard-rooms']?.normalized,
    ).toMatchObject({ id: 'new-wizard-rooms' });
  }, 120_000);
  it('keeps newly staged and saved Layout companion text sources present in native validation', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const record = createDefaultAuthoringRecord('layouts', 'native-created-layout', {
      label: 'New Layout',
      data: defaultLayoutData('New Layout', 'document'),
    });
    const staged = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'add', path: '/layouts/native-created-layout', value: toJsonValue(record) },
    ]);
    expect(staged.accepted, staged.error).toBe(true);
    const unresolved = (reply: Awaited<ReturnType<typeof working.validateWorking>>) =>
      reply.diagnostics.filter(
        (item) =>
          item.code === 'authoring.lua.external_source_unresolved' &&
          item.sourcePath?.includes('native-created-layout'),
      );
    const beforeSave = await working.validateWorking();
    expect(unresolved(beforeSave)).toEqual([]);
    const saved = await working.saveUnit('record:layouts:native-created-layout');
    expect(saved.accepted, saved.error).toBe(true);
    const afterSave = await working.validateWorking();
    expect(unresolved(afterSave)).toEqual([]);
    for (const channel of ['rml', 'rcss', 'lua']) {
      expect(
        await readFile(
          path.join(root, 'records/layouts/native-created-layout', `layout.${channel}`),
          'utf8',
        ),
      ).not.toBe('');
    }
    await working.reopenAndReplay('native-reconcile-test');
    expect(unresolved(await working.validateWorking())).toEqual([]);
    const removed = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'remove', path: '/layouts/native-created-layout' },
    ]);
    expect(removed.accepted, removed.error).toBe(true);
    const deleted = await working.saveUnit('record:layouts:native-created-layout');
    expect(deleted.accepted, deleted.error).toBe(true);
    expect(unresolved(await working.validateWorking())).toEqual([]);
    const data = defaultLayoutData('Invalid staging', 'document');
    data.lua.sourceText = "Text.msg('nonexistent.staged.layout.message')";
    const invalidLayout = createDefaultAuthoringRecord('layouts', 'invalid-staged-layout', {
      label: 'Invalid staging',
      data,
    });
    const second = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'add', path: '/layouts/invalid-staged-layout', value: toJsonValue(invalidLayout) },
    ]);
    expect(second.accepted, second.error).toBe(true);
    expect((await working.validateWorking()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.localization.lua_named_message_missing',
          sourcePath: 'records/layouts/invalid-staged-layout/layout.lua',
        }),
      ]),
    );
  }, 120_000);

  it.skipIf(!process.env.NOVELTEA_RECOVERY_TEST_PROJECT)(
    'can replay a copied user Project checkpoint without modifying the source',
    async () => {
      const original = process.env.NOVELTEA_RECOVERY_TEST_PROJECT!;
      const root = await mkdtemp(path.join(tmpdir(), 'noveltea-real-recovery-'));
      await cp(original, root, { recursive: true });
      const checkpoint = JSON.parse(
        await readFile(path.join(root, '.noveltea/editor/native-dirty-state.json'), 'utf8'),
      ).checkpoint;
      const bridge = new NativeAuthoringSessionBridge(
        { requireActiveProjectRoot: () => root, isCurrent: () => true },
        { addonPath: path.resolve(addon!), workerScript, pollIntervalMs: 0 },
      );
      cleanups.push(async () => {
        await bridge.closeAndWait();
        await rm(root, { recursive: true, force: true });
      });
      const working = new NativeAuthoringWorkingProject(bridge);
      await working.open('native-reconcile-test');
      await working.restoreDirtyCheckpoint('native-reconcile-test', checkpoint);
      const prepared = await working.prepareCompleteWorking();
      expect(prepared.accepted, prepared.error).toBe(true);
      expect(prepared.completeProject).toBeDefined();
      const inspected = await working.inspectRecord('rooms/new-room-2');
      expect(inspected.accepted, inspected.error).toBe(true);
      const record = inspected.snapshot.recordSnapshots?.['rooms/new-room-2']?.normalized as {
        data: Record<string, unknown>;
      };
      expect(record.data.kind).toBe('room');
      expect(roomDataSchema.safeParse(record.data)).toMatchObject({ success: true });
      expect(parseRoomData(record.data)).not.toBeNull();
      const edited = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
        {
          op: 'replace',
          path: '/rooms/new-room-2/data',
          value: toJsonValue({ ...record.data, displayName: 'Changed again after recovery' }),
        },
      ]);
      expect(edited.accepted, edited.error).toBe(true);
      const editedData = edited.snapshot.recordSnapshots?.['rooms/new-room-2']?.normalized as {
        data: Record<string, unknown>;
      };
      expect(editedData.data).toEqual({
        ...record.data,
        displayName: 'Changed again after recovery',
      });
      const proposed = toJsonValue({
        ...createAuthoringProject(),
        rooms: { 'new-room-2': record },
      });
      const roomEdits = replaceRoomDataPatches(proposed, {
        roomId: 'new-room-2',
        data: { ...record.data, displayName: 'Second UI name' },
      });
      expect(roomEdits.diagnostics ?? []).toEqual([]);
      const proposal = applyJsonPatch(proposed, roomEdits.patches).document;
      const acknowledged = await working.applyRevisionedPatches(
        working.snapshot()!.workingRevision,
        roomEdits.patches,
      );
      expect(acknowledged.accepted, acknowledged.error).toBe(true);
      expect(
        (
          acknowledged.snapshot.recordSnapshots?.['rooms/new-room-2']?.normalized as
            | { data: unknown }
            | undefined
        )?.data,
      ).toEqual(
        (proposal as { rooms: Record<string, { data: unknown }> }).rooms['new-room-2']?.data,
      );
      assertNativeProjection(proposal, roomEdits.patches, acknowledged);
      const saved = await working.saveUnit('record:rooms:new-room-2');
      expect(saved.accepted, saved.error).toBe(true);
      const room = decodeStructuredYaml(
        await readFile(path.join(root, 'records/rooms/new-room-2.yaml'), 'utf8'),
      ) as { data: Record<string, unknown> };
      expect(room.data).not.toHaveProperty('kind');
      expect(room.data.displayName).toBe('Second UI name');
      const reopened = await working.reopenAndReplay('native-reconcile-test');
      expect(reopened.workingRevision).toBeGreaterThanOrEqual(0);
      const verified = await working.inspectRecord('rooms/new-room-2');
      expect(verified.accepted, verified.error).toBe(true);
      expect(verified.snapshot.recordSnapshots?.['rooms/new-room-2']?.normalized).toMatchObject({
        data: { displayName: 'Second UI name', kind: 'room' },
      });
      const entrypointPatches = setProjectEntrypointPatches(proposed, {
        target: { kind: 'room', id: 'new-room-2' },
      });
      expect(entrypointPatches.diagnostics ?? []).toEqual([]);
      const entrypointProposal = applyJsonPatch(proposed, entrypointPatches.patches).document;
      const entrypointAck = await working.applyRevisionedPatches(
        working.snapshot()!.workingRevision,
        entrypointPatches.patches,
      );
      expect(entrypointAck.accepted, entrypointAck.error).toBe(true);
      assertNativeProjection(entrypointProposal, entrypointPatches.patches, entrypointAck);
      const entrypointSaved = await working.saveUnit('project:settings');
      expect(entrypointSaved.accepted, entrypointSaved.error).toBe(true);
      const manifest = decodeStructuredYaml(
        await readFile(path.join(root, 'project.yaml'), 'utf8'),
      ) as { entrypoint: { kind: string; id: string } };
      expect(manifest.entrypoint).toEqual({ kind: 'room', id: 'new-room-2' });
    },
    120_000,
  );
  it('reopens an older native checkpoint containing an inferred Room kind', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const room = 'room-lifecycle-roundtrip';
    const baseline = working.snapshot()!.recordSnapshots?.[`rooms/${room}`];
    expect(baseline).toBeDefined();
    const recovered = await working.restoreDirtyCheckpoint('native-reconcile-test', {
      batches: [
        {
          patches: [
            { operation: 'replace', path: `/rooms/${room}/label`, value: 'Recovered Label' },
            { operation: 'add', path: `/rooms/${room}/data/kind`, value: 'room' },
          ],
          diskPreconditions: { [`rooms/${room}`]: baseline!.diskSourceRevision },
        },
      ],
      textSources: {},
      conflicts: {},
      pendingFields: {},
    });
    expect(recovered.workingRevision).toBeGreaterThan(0);
    const inspected = await working.inspectRecord(`rooms/${room}`);
    expect(inspected.accepted, inspected.error).toBe(true);
    expect(inspected.snapshot.recordSnapshots?.[`rooms/${room}`]?.normalized).toMatchObject({
      label: 'Recovered Label',
    });
    // RoomEditor dispatches room.replaceData, which replaces the *entire*
    // normalized data object, including its inferred data.kind discriminator.
    const effective = inspected.snapshot.recordSnapshots?.[`rooms/${room}`]?.normalized as {
      data: Record<string, unknown>;
    };
    expect(effective.data.kind).toBe('room');
    const edited = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      {
        op: 'replace',
        path: `/rooms/${room}/data`,
        value: toJsonValue({ ...effective.data, displayName: 'Edited room name' }),
      },
    ]);
    expect(edited.accepted, edited.error).toBe(true);
    const saved = await working.saveUnit(`record:rooms:${room}`);
    expect(saved.accepted, saved.error).toBe(true);
    const diskRecord = decodeStructuredYaml(
      await readFile(path.join(root, `records/rooms/${room}.yaml`), 'utf8'),
    ) as { data: Record<string, unknown> };
    expect(diskRecord.data).not.toHaveProperty('kind');
    expect(diskRecord.data.displayName).toBe('Edited room name');
    expect((diskRecord.data.description as { source: { kind: string } }).source.kind).toBe(
      'inline',
    );

    const invalid = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      {
        op: 'replace',
        path: `/rooms/${room}/data`,
        value: toJsonValue({ ...effective.data, kind: 'map' }),
      },
    ]);
    expect(invalid.accepted).toBe(false);
    expect(invalid.error).toContain('Cannot change an inferred record kind');
  }, 120_000);
  it('saves consecutive Room wizard creations with record metadata and permits undo', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    for (const id of ['wizard-first', 'wizard-second']) {
      const record = createDefaultAuthoringRecord('rooms', id, { label: id });
      const first = id === 'wizard-first';
      const patches = [
        ...(first
          ? [{ op: 'add' as const, path: '/editor/recordMetadata/rooms', value: toJsonValue({}) }]
          : []),
        {
          op: 'add' as const,
          path: `/editor/recordMetadata/rooms/${id}`,
          value: toJsonValue({ tags: [], color: null }),
        },
        { op: 'add' as const, path: `/rooms/${id}`, value: toJsonValue(record) },
      ];
      const staged = await working.applyRevisionedPatches(
        working.snapshot()!.workingRevision,
        patches,
      );
      expect(staged.accepted, staged.error).toBe(true);
      const saved = await working.saveOwners(['editor', `rooms/${id}`]);
      expect(saved.accepted, saved.error).toBe(true);
    }
    const metadata = decodeStructuredYaml(
      await readFile(path.join(root, 'editor.yaml'), 'utf8'),
    ) as {
      recordMetadata: { rooms: Record<string, unknown> };
    };
    expect(Object.keys(metadata.recordMetadata.rooms).sort()).toEqual([
      'wizard-first',
      'wizard-second',
    ]);
    const removed = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'remove', path: '/editor/recordMetadata/rooms/wizard-second' },
      { op: 'remove', path: '/rooms/wizard-second' },
    ]);
    expect(removed.accepted, removed.error).toBe(true);
    const undone = await working.saveOwners(['editor', 'rooms/wizard-second']);
    expect(undone.accepted, undone.error).toBe(true);
    const remaining = decodeStructuredYaml(
      await readFile(path.join(root, 'editor.yaml'), 'utf8'),
    ) as {
      recordMetadata: { rooms: Record<string, unknown> };
    };
    expect(Object.keys(remaining.recordMetadata.rooms)).toEqual(['wizard-first']);
    await expect(readFile(path.join(root, 'records/rooms/wizard-second.yaml'))).rejects.toThrow();
  }, 120_000);
  it('creates, replaces, deletes, and replays whole locale YAML fragments atomically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-locale-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('native-locale-test');
    const fr = 'i18n/locales/fr.yaml';
    const es = 'i18n/locales/fr-CA.yaml';
    const originalFr = await readFile(path.join(root, fr), 'utf8');
    expect((await working.inspectRecord(fr)).accepted).toBe(true);
    const frSource = structuredClone(working.snapshot()!.recordSnapshots![fr]!.source) as Record<
      string,
      { review?: string }
    >;
    const firstMessage = Object.keys(frSource)[0]!;
    const updatedFr = structuredClone(frSource);
    updatedFr[firstMessage] = { ...updatedFr[firstMessage], review: 'reviewed' };
    const changed = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'replace', path: '/localization/translations/fr', value: updatedFr },
      { op: 'add', path: '/localization/translations/fr-CA', value: frSource },
    ]);
    expect(changed.accepted, changed.error).toBe(true);
    expect(changed.affectedRecords).toEqual([es, fr]);
    await expect(readFile(path.join(root, es))).rejects.toThrow();
    expect(await readFile(path.join(root, fr), 'utf8')).toBe(originalFr);
    const replayedCreation = await working.reopenAndReplay('native-locale-test');
    expect(replayedCreation.recordSnapshots?.[es]?.source).toEqual(frSource);
    expect(replayedCreation.recordSnapshots?.[fr]?.source).toEqual(updatedFr);
    const saved = await working.saveOwners([es, fr], { comments: 'remove' });
    expect(saved.accepted, saved.error).toBe(true);
    expect(await readFile(path.join(root, es), 'utf8')).toContain(firstMessage);
    expect(await readFile(path.join(root, fr), 'utf8')).not.toBe(originalFr);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'remove', path: '/localization/translations/fr-CA' },
        ])
      ).accepted,
    ).toBe(true);
    expect(working.snapshot()?.recordSnapshots?.[es]).toBeUndefined();
    expect(working.dirtyCheckpoint().batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patches: [{ operation: 'remove', path: '/localization/translations/fr-CA' }],
        }),
      ]),
    );
    const replayed = await working.reopenAndReplay('native-locale-test');
    expect(replayed.recordSnapshots?.[es]).toBeUndefined();
    const deleted = await working.saveUnit('project:localization');
    expect(deleted.accepted, deleted.error).toBe(true);
    await expect(readFile(path.join(root, es))).rejects.toThrow();
    // Deleting an existing locale that has never been explicitly inspected
    // must retain its original disk revision for recovery and Use Disk.
    const ja = 'i18n/locales/ja.yaml';
    const untouchedJa = await readFile(path.join(root, ja), 'utf8');
    const directRemoval = await working.applyRevisionedPatches(
      working.snapshot()!.workingRevision,
      [{ op: 'remove', path: '/localization/translations/ja' }],
    );
    expect(directRemoval.accepted, directRemoval.error).toBe(true);
    expect(working.dirtyCheckpoint().batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patches: [{ operation: 'remove', path: '/localization/translations/ja' }],
        }),
      ]),
    );
    expect((await working.useDiskUnit('project:localization')).accepted).toBe(true);
    expect(await readFile(path.join(root, ja), 'utf8')).toBe(untouchedJa);
  }, 120_000);
  it('admits a deleted tracked Room, preserving dirty edits as a native conflict until Use Disk', async () => {
    const { root, bridge, working, roomPath } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    await rm(roomPath);
    const clean = await working.reconcile(owner);
    expect(clean.accepted, clean.error).toBe(true);
    expect(clean.affectedRecords).toContain(owner);
    expect(clean.snapshot.recordSnapshots?.[owner]).toBeUndefined();
    await writeFile(roomPath, (await readFile(path.join(fixture, roomRelative))).toString());
    const readded = await working.reconcile(owner);
    expect(readded.accepted, readded.error).toBe(true);
    expect(readded.snapshot.recordSnapshots?.[owner]?.source).toBeDefined();
    const local = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'replace', path: labelPath, value: 'Local Room' },
    ]);
    expect(local.accepted, local.error).toBe(true);
    await rm(roomPath);
    const conflicted = await working.reconcile(owner);
    expect(conflicted.accepted, conflicted.error).toBe(true);
    expect(conflicted.snapshot.recordSnapshots?.[owner]).toMatchObject({
      source: expect.objectContaining({ label: 'Local Room' }),
      baseline: null,
      diskSourceRevision: 'absent',
      conflictingPaths: ['/'],
    });
    const discarded = await working.useDiskUnit(`record:rooms:${roomId}`);
    expect(discarded.accepted, discarded.error).toBe(true);
    expect(discarded.snapshot.recordSnapshots?.[owner]).toBeUndefined();
    await writeFile(roomPath, await readFile(path.join(fixture, roomRelative)));
    expect((await working.reconcile(owner)).accepted).toBe(true);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'replace', path: labelPath, value: 'Kept Local Room' },
        ])
      ).accepted,
    ).toBe(true);
    await rm(roomPath);
    expect((await working.reconcile(owner)).accepted).toBe(true);
    expect((await working.saveOwners([owner])).accepted).toBe(false);
    const kept = await working.saveOwners([owner], { keepMine: true });
    expect(kept.accepted, kept.error).toBe(true);
    expect(await readFile(roomPath, 'utf8')).toContain('Kept Local Room');
    await working.reopenAndReplay('native-reconcile-test');
    expect(
      (await working.inspectRecord(owner)).snapshot.recordSnapshots?.[owner]?.source,
    ).toMatchObject({ label: 'Kept Local Room' });
  }, 120_000);

  it('offers comment review before deleting native YAML and requires the selected disposition', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const id = 'native-comment-review';
    const createdOwner = `rooms/${id}`;
    const roomPath = path.join(root, `records/rooms/${id}.yaml`);
    const original = working.snapshot()!.recordSnapshots![owner]!.source as Record<
      string,
      JsonValue
    >;
    const created = await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
      { op: 'add', path: `/rooms/${id}`, value: { ...original, id } },
    ]);
    expect(created.accepted, created.error).toBe(true);
    expect((await working.saveOwners([createdOwner])).accepted).toBe(true);
    const bytes = await readFile(roomPath, 'utf8');
    // New native owners may initially be serialized in JSON (also valid YAML),
    // so use a leading YAML comment rather than assuming a `label:` line.
    await writeFile(roomPath, '# important native comment\n' + bytes);
    expect((await working.reconcile(createdOwner)).accepted).toBe(true);
    const anotherId = 'native-comment-review-two';
    const anotherOwner = `rooms/${anotherId}`;
    const anotherPath = path.join(root, `records/rooms/${anotherId}.yaml`);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'add', path: `/rooms/${anotherId}`, value: { ...original, id: anotherId } },
        ])
      ).accepted,
    ).toBe(true);
    expect((await working.saveOwners([anotherOwner])).accepted).toBe(true);
    await writeFile(
      anotherPath,
      '# second native comment\n' + (await readFile(anotherPath, 'utf8')),
    );
    expect((await working.reconcile(anotherOwner)).accepted).toBe(true);
    expect(
      (
        await working.applyRevisionedPatches(working.snapshot()!.workingRevision, [
          { op: 'remove', path: `/rooms/${id}` },
          { op: 'remove', path: `/rooms/${anotherId}` },
        ])
      ).accepted,
    ).toBe(true);
    const blocked = await working.saveOwners([createdOwner, anotherOwner], { comments: 'keep' });
    expect(blocked.accepted, blocked.error).toBe(false);
    expect(blocked.error).toContain('Deleting commented records requires explicit');
    expect(blocked.commentImpacts, `Native Save rejected: ${blocked.error}`).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: `records/rooms/${id}.yaml`,
          kind: 'deleted',
          comment: expect.stringContaining('# important native comment'),
        }),
        expect.objectContaining({
          file: `records/rooms/${anotherId}.yaml`,
          kind: 'deleted',
          comment: expect.stringContaining('# second native comment'),
        }),
      ]),
    );
    expect(await readFile(roomPath, 'utf8')).toContain('# important native comment');
    expect(await readFile(anotherPath, 'utf8')).toContain('# second native comment');
    const approved = await working.saveOwners([createdOwner, anotherOwner], { comments: 'remove' });
    expect(approved.accepted, approved.error).toBe(true);
    await expect(readFile(roomPath)).rejects.toThrow();
    await expect(readFile(anotherPath)).rejects.toThrow();
  }, 120_000);
  it('moves and restores binary Asset bytes through the real worker and native journal', async () => {
    const { root, bridge, working } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const assetPath = 'assets/native-structural/bytes.bin';
    const original = path.join(root, assetPath);
    const bytes = Buffer.from([0, 255, 13, 10, 40, 41]);
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, bytes);
    const trashed = await working.saveOwners([], {
      assetTransition: { kind: 'trash', projectRelativePaths: [assetPath] },
    });
    expect(trashed.accepted, trashed.error).toBe(true);
    expect(trashed.assetTrashMoves).toHaveLength(1);
    const move = trashed.assetTrashMoves![0]!;
    await expect(readFile(original)).rejects.toThrow();
    expect(await readFile(path.join(root, move.trashRelativePath))).toEqual(bytes);
    const restored = await working.saveOwners([], {
      assetTransition: { kind: 'restore', moves: [move] },
    });
    expect(restored.accepted, restored.error).toBe(true);
    expect(await readFile(original)).toEqual(bytes);
    await expect(readFile(path.join(root, move.trashRelativePath))).rejects.toThrow();
  }, 120_000);

  it('duplicates a tracked Layout and its companions through generic native patch/Save/reopen', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-layout-copy-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
      await rm(root, { recursive: true, force: true });
    });
    const working = new NativeAuthoringWorkingProject(bridge);
    await working.open('native-layout-copy');
    const originalOwner = 'layouts/notice-board';
    const copiedOwner = 'layouts/native-layout-copy';
    const inspected = await working.inspectRecord(originalOwner);
    expect(inspected.accepted, inspected.error).toBe(true);
    const original = inspected.snapshot.recordSnapshots?.[originalOwner]?.source as Record<
      string,
      JsonValue
    >;
    const copied = { ...original, id: 'native-layout-copy', label: 'Native Layout Copy' };
    const staged = await working.applyRevisionedPatches(
      working.snapshot()!.workingRevision,
      [{ op: 'add', path: `/${copiedOwner}`, value: copied }],
      { [copiedOwner]: originalOwner },
    );
    expect(staged.accepted, staged.error).toBe(true);
    const saved = await working.saveOwners([copiedOwner]);
    expect(saved.accepted, saved.error).toBe(true);
    const sourceFile = path.join(root, 'records/layouts/notice-board/layout.rml');
    const copiedFile = path.join(root, 'records/layouts/native-layout-copy/layout.rml');
    expect(await readFile(copiedFile)).toEqual(await readFile(sourceFile));
    await working.reopenAndReplay('native-layout-copy');
    const reopened = await working.inspectRecord(copiedOwner);
    expect(reopened.accepted).toBe(true);
    expect(reopened.snapshot.recordSnapshots?.[copiedOwner]?.source).toMatchObject(copied);
  }, 120_000);

  it('saves generic localization and manifest patches through their real physical owners', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-localization-'));
    await cp(fixture, root, { recursive: true });
    const bridge = new NativeAuthoringSessionBridge(
      { requireActiveProjectRoot: () => root, isCurrent: () => true },
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
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
    await bridge.closeAndWait();
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
      {
        addonPath: path.resolve(addon!),
        workerScript,
        pollIntervalMs: deterministicPollIntervalMs,
      },
    );
    cleanups.push(async () => {
      await bridge.closeAndWait();
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
    await bridge.closeAndWait();
    const replayed = await working.reopenAndReplay('text-replay');
    expect(replayed.source).toMatchObject({ project: { name: 'Unsaved alongside RML' } });
    const restored = await working.prepareWorking();
    expect(restored.accepted).toBe(true);
    expect(restored.textOverlays[source]).toBe(dirty);

    expect(await working.stageTextSource(source, original)).toMatchObject({
      accepted: true,
      textSourceStaged: false,
    });
    await bridge.closeAndWait();
    await working.reopenAndReplay('text-replay');
    expect((await working.prepareWorking()).textOverlays[source]).toBeUndefined();

    expect((await working.stageTextSource(source, dirty)).accepted).toBe(true);
    await writeFile(physical, `${original}\n<!-- External change -->\n`);
    await bridge.closeAndWait();
    await expect(working.reopenAndReplay('text-replay')).rejects.toThrow(
      `Native Project text-source recovery conflict for ${source}`,
    );
    expect(working.snapshot()).toBeNull();
    expect(await readFile(physical, 'utf8')).toContain('External change');
  }, 120_000);

  it('routes collection and export-profile Save units without committing unrelated owners', async () => {
    const { root, bridge, working, roomPath } = await testProject();
    cleanups.push(async () => {
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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

    await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
    await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
      await bridge.closeAndWait();
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
