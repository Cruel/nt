import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { createInitialCommandBusState, executeCommand } from '../commands/command-bus';
import type { JsonValue } from '../project/json-value';

const initial = {
  workingRevision: 0,
  diskSourceRevision: 'sha256:' + '0'.repeat(64),
  source: { schema: 'noveltea.project.workspace' },
  normalized: { schema: 'noveltea.project.workspace' },
  dirty: false,
  valid: true,
  diagnostics: [],
  inventory: ['project.yaml'],
};
const observation = {
  authoritative: true,
  scopedAuthority: true,
  unchanged: false,
  fullRescan: false,
  error: '',
  added: [],
  changed: ['records/rooms/foyer.yaml'],
  removed: [],
  revisions: { 'records/rooms/foyer.yaml': 'sha256:' + '1'.repeat(64) },
  watchPaths: [],
  invalidSources: [],
  recordDiagnostics: [],
};

class FakeWorker extends EventEmitter {
  readonly sent: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

describe('native worker session bridge (main-owned authority)', () => {
  it('admits only current Project roots and drops old-worker events after switching', async () => {
    let active = 'A';
    const workers: FakeWorker[] = [];
    const notifications: string[] = [];
    const bridge = new NativeAuthoringSessionBridge(
      {
        requireActiveProjectRoot: (id) => {
          if (id !== active) throw new Error('stale');
          return '/trusted/project';
        },
        isCurrent: (id) => id === active,
      },
      {
        addonPath: '/trusted/addon.node',
        createWorker: (_file, options) => {
          expect(options.workerData.root).toBe('/trusted/project');
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
      },
    );
    bridge.subscribe((event) => notifications.push(event.changedRecords.join(',')));
    await expect(bridge.open('stale')).rejects.toThrow('stale');
    expect(workers).toHaveLength(0);
    const first = bridge.open('A');
    workers[0]!.emit('message', {
      type: 'snapshot',
      sessionId: 'A',
      generation: 1,
      sequence: 0,
      snapshot: initial,
    });
    await expect(first).resolves.toMatchObject({ sessionId: 'A', snapshot: initial });
    workers[0]!.emit('message', {
      type: 'delta',
      sessionId: 'A',
      generation: 1,
      sequence: 1,
      observation,
      changedRecords: ['rooms/foyer'],
      changedSourcePaths: observation.changed,
    });
    expect(notifications).toEqual(['rooms/foyer']);
    active = 'B';
    const second = bridge.open('B');
    expect(workers[0]!.terminated).toBe(true);
    workers[0]!.emit('message', {
      type: 'delta',
      sessionId: 'A',
      generation: 1,
      sequence: 2,
      observation,
      changedRecords: ['rooms/old'],
      changedSourcePaths: observation.changed,
    });
    const nextGeneration = 3;
    workers[1]!.emit('message', {
      type: 'snapshot',
      sessionId: 'B',
      generation: nextGeneration,
      sequence: 0,
      snapshot: initial,
    });
    await expect(second).resolves.toMatchObject({ sessionId: 'B' });
    expect(notifications).toEqual(['rooms/foyer']);
    bridge.close();
  });

  it('serializes request IDs, rejects invalid sequences, and restarts after worker failure', async () => {
    const workers: FakeWorker[] = [];
    const bridge = new NativeAuthoringSessionBridge(
      {
        requireActiveProjectRoot: () => '/trusted/project',
        isCurrent: () => true,
      },
      {
        addonPath: '/trusted/addon.node',
        createWorker: () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
      },
    );
    const failures: string[] = [];
    bridge.onFailure((error) => failures.push(error.message));
    const opened = bridge.open('A');
    workers[0]!.emit('message', {
      type: 'snapshot',
      sessionId: 'A',
      generation: 1,
      sequence: 0,
      snapshot: initial,
    });
    await opened;
    const requested = bridge.request({ operation: 'observe' });
    expect(workers[0]!.sent).toEqual([{ operation: 'observe', requestId: 1 }]);
    workers[0]!.emit('message', {
      type: 'response',
      sessionId: 'A',
      generation: 1,
      requestId: 1,
      result: observation,
    });
    await expect(requested).resolves.toMatchObject(observation);
    workers[0]!.emit('message', {
      type: 'delta',
      sessionId: 'A',
      generation: 1,
      sequence: 2,
      observation,
      changedRecords: [],
      changedSourcePaths: [],
    });
    expect(failures).toEqual(['Out-of-order native Project delta.']);
    expect(workers[0]!.terminated).toBe(true);
    await expect(bridge.request({ operation: 'observe' })).rejects.toThrow('unavailable');
    const restarted = bridge.open('A');
    workers[1]!.emit('message', {
      type: 'snapshot',
      sessionId: 'A',
      generation: 3,
      sequence: 0,
      snapshot: initial,
    });
    await expect(restarted).resolves.toMatchObject({ generation: 3 });
    const pending = bridge.request({ operation: 'observe' });
    workers[1]!.emit('error', new Error('native worker crashed'));
    await expect(pending).rejects.toThrow('native worker crashed');
    expect(failures).toContain('native worker crashed');
  });
});

const addon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
const compiledWorker = path.resolve(
  process.cwd(),
  'dist-electron/authoring-worker/native-authoring-worker.cjs',
);
describe.skipIf(!addon)('native Node-API addon through real Electron-compatible worker', () => {
  it('mirrors existing multi-owner editor actions, undo, invalid input and conflict-safe replay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-working-'));
    const fixture = path.resolve(process.cwd(), '../tests/projects/feature-lab');
    const roomId = 'room-lifecycle-roundtrip';
    const owner = `rooms/${roomId}`;
    const roomPath = path.join(root, 'records/rooms', `${roomId}.yaml`);
    let bridge: NativeAuthoringSessionBridge | undefined;
    try {
      for (const file of [
        'project.yaml',
        'traits.yaml',
        'editor.yaml',
        'i18n/project.yaml',
        'i18n/messages.yaml',
        'i18n/usage-notes.yaml',
        'i18n/tracking.yaml',
        'i18n/orphans.yaml',
        `records/rooms/${roomId}.yaml`,
      ]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await copyFile(path.join(fixture, file), path.join(root, file));
      }
      await mkdir(path.join(root, 'records/maps'), { recursive: true });
      await writeFile(
        path.join(root, 'records/maps/world.yaml'),
        'id: world\nlabel: World\ndata:\n  locations:\n    - id: foyer\n      room: foyer\n    - id: hall\n      room: hall\n  connections: []\n',
      );
      bridge = new NativeAuthoringSessionBridge(
        { requireActiveProjectRoot: () => root, isCurrent: () => true },
        { addonPath: path.resolve(addon!), workerScript: compiledWorker, pollIntervalMs: 100 },
      );
      const working = new NativeAuthoringWorkingProject(bridge);
      const initial = await working.open('working-certification');
      expect(working.snapshot()?.recordSnapshots).toEqual({});
      expect(await working.inspectRecord(owner)).toMatchObject({
        accepted: true,
        snapshot: {
          workingRevision: 0,
          dirty: false,
          recordSnapshots: { [owner]: { source: { label: 'Lifecycle Round Trip' } } },
        },
      });
      expect(await working.inspectRecord('maps/world')).toMatchObject({
        accepted: true,
        snapshot: {
          recordSnapshots: { 'maps/world': { source: { label: 'World' } } },
        },
      });
      const targeted = await bridge.request({ operation: 'inspect', owner });
      expect(
        targeted && 'accepted' in targeted && Object.keys(targeted.snapshot.recordSnapshots ?? {}),
      ).toEqual([owner]);
      expect(working.historyCursor()).toBe(0);
      const projectName = (initial.source as { project: { name: string } }).project.name;
      const originalRoomSource = await readFile(roomPath, 'utf8');
      const roomLabel = '/rooms/room-lifecycle-roundtrip/label';
      const projectLabel = '/project/name';
      const mapLabel = '/maps/world/label';
      const forward = [
        { op: 'replace' as const, path: roomLabel, value: 'Changed in editor' },
        { op: 'replace' as const, path: projectLabel, value: 'Changed project' },
        { op: 'replace' as const, path: mapLabel, value: 'Changed Map' },
      ];
      const inverse = [
        { op: 'replace' as const, path: mapLabel, value: 'World' },
        { op: 'replace' as const, path: projectLabel, value: projectName },
        { op: 'replace' as const, path: roomLabel, value: 'Lifecycle Round Trip' },
      ];
      const edited = await working.applyAction(forward, inverse);
      expect(edited).toMatchObject({
        accepted: true,
        affectedRecords: ['maps/world', 'project', owner],
        snapshot: { workingRevision: 1, dirty: true, valid: true },
      });
      expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
        label: 'Changed in editor',
      });
      expect(working.snapshot()?.recordSnapshots?.['maps/world']?.source).toMatchObject({
        label: 'Changed Map',
      });
      const blockedSave = await bridge.request({
        operation: 'save',
        diskRevision: initial.diskSourceRevision,
      });
      expect(blockedSave).toMatchObject({
        accepted: false,
        error: expect.stringContaining('Cannot partially save dirty native Project owner'),
      });
      expect(await readFile(roomPath, 'utf8')).toBe(originalRoomSource);
      expect((await working.undo()).snapshot.workingRevision).toBe(2);
      expect(working.snapshot()?.dirty).toBe(false);
      expect(working.historyCursor()).toBe(0);
      expect((await working.redo()).snapshot.workingRevision).toBe(3);
      expect(working.historyCursor()).toBe(1);
      const duplicateAdd = await working.applyAction(
        [{ op: 'add', path: roomLabel, value: 'Invalid duplicate add' }],
        [],
      );
      expect(duplicateAdd.accepted).toBe(false);
      expect(working.snapshot()?.workingRevision).toBe(3);
      const netNoOp = await working.applyAction(
        [
          { op: 'replace', path: roomLabel, value: 'Temporary' },
          { op: 'replace', path: roomLabel, value: 'Changed in editor' },
        ],
        [],
      );
      expect(netNoOp).toMatchObject({ accepted: true, affectedRecords: [] });
      expect(working.snapshot()?.workingRevision).toBe(3);
      expect(working.historyCursor()).toBe(1);

      working.setPendingFieldText(
        '/rooms/room-lifecycle-roundtrip/data/presentationSpace/size/width',
        'not-a-number',
      );
      expect(
        working.pendingFieldText(
          '/rooms/room-lifecycle-roundtrip/data/presentationSpace/size/width',
        ),
      ).toBe('not-a-number');
      expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
        data: { presentationSpace: { size: { width: 1920 } } },
      });
      const width = '/rooms/room-lifecycle-roundtrip/data/presentationSpace/size/width';
      const invalid = await working.applyAction(
        [{ op: 'replace', path: width, value: -1 }],
        [{ op: 'replace', path: width, value: 1920 }],
      );
      expect(invalid).toMatchObject({ accepted: true, snapshot: { valid: false } });
      expect(invalid.snapshot.diagnostics.some((entry) => entry.path === width)).toBe(true);
      expect((await working.undo()).snapshot.valid).toBe(true);
      const beforeRejected = working.snapshot();
      const rejected = await working.applyAction(
        [
          { op: 'replace', path: projectLabel, value: 'Should roll back project' },
          { op: 'replace', path: roomLabel, value: 'Should roll back' },
          { op: 'replace', path: '/rooms/room-lifecycle-roundtrip/missing/field', value: 2 },
        ],
        [{ op: 'replace', path: roomLabel, value: 'Changed in editor' }],
      );
      expect(rejected.accepted).toBe(false);
      expect(working.snapshot()).toEqual(beforeRejected);
      expect(working.snapshot()?.recordSnapshots?.[owner]?.source).toMatchObject({
        label: 'Changed in editor',
      });
      expect(working.snapshot()?.source).toMatchObject({
        project: { name: 'Changed project' },
      });

      bridge.close();
      const replayed = await working.reopenAndReplay('working-certification');
      expect(replayed.workingRevision).toBe(5);
      expect(replayed.recordSnapshots?.[owner]?.source).toMatchObject({
        label: 'Changed in editor',
        data: { presentationSpace: { size: { width: 1920 } } },
      });
      expect(replayed.recordSnapshots?.['maps/world']?.source).toMatchObject({
        label: 'Changed Map',
      });
      expect(working.pendingFieldText(width)).toBe('not-a-number');
      const effectiveRoom = working.snapshot()?.recordSnapshots?.[owner]?.normalized;
      if (!effectiveRoom) throw new Error('Missing effective native Room for editor command test.');
      const editorCommand = executeCommand(
        createInitialCommandBusState({
          rooms: { [roomId]: effectiveRoom },
        } as unknown as JsonValue),
        {
          type: 'project.replaceAtPath',
          payload: { path: roomLabel, value: 'Existing command handler' },
          originSaveUnitId: `record:rooms:${roomId}`,
          persistencePolicy: 'manual-save',
        },
      );
      expect(editorCommand.ok).toBe(true);
      expect(editorCommand.historyEntry?.inversePatches).toEqual([
        { op: 'replace', path: roomLabel, value: 'Changed in editor' },
      ]);
      const fromExistingCommand = await working.applyAction(
        editorCommand.historyEntry!.patches,
        editorCommand.historyEntry!.inversePatches,
      );
      expect(fromExistingCommand).toMatchObject({
        accepted: true,
        affectedRecords: [owner],
        snapshot: {
          recordSnapshots: { [owner]: { source: { label: 'Existing command handler' } } },
        },
      });
      expect((await working.undo()).snapshot.recordSnapshots?.[owner]?.source).toMatchObject({
        label: 'Changed in editor',
      });
      bridge.close();
      await expect(working.reopenAndReplay('different-session')).rejects.toThrow(
        'different Project session',
      );
      await writeFile(roomPath, originalRoomSource + '\n# another process modified this source\n');
      await expect(working.reopenAndReplay('working-certification')).rejects.toThrow(
        'Recovery source conflict',
      );
      expect(working.snapshot()).toBeNull();
      expect(await readFile(roomPath, 'utf8')).toContain('another process modified');
    } finally {
      bridge?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('opens Project snapshot, emits verified external deltas and restarts safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-worker-'));
    try {
      const fixture = path.resolve(process.cwd(), '../tests/projects/feature-lab');
      for (const file of [
        'project.yaml',
        'traits.yaml',
        'editor.yaml',
        'i18n/project.yaml',
        'i18n/messages.yaml',
        'i18n/usage-notes.yaml',
        'i18n/tracking.yaml',
        'i18n/orphans.yaml',
      ]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await copyFile(path.join(fixture, file), path.join(root, file));
      }
      await mkdir(path.join(root, 'records/rooms'), { recursive: true });
      const roomPath = path.join(root, 'records/rooms/room-lifecycle-roundtrip.yaml');
      await copyFile(path.join(fixture, 'records/rooms/room-lifecycle-roundtrip.yaml'), roomPath);
      let active = 'certified-A';
      const bridge = new NativeAuthoringSessionBridge(
        {
          requireActiveProjectRoot: (id) => {
            if (id !== active) throw new Error('Stale test session.');
            return root;
          },
          isCurrent: (id) => id === active,
        },
        { addonPath: path.resolve(addon!), workerScript: compiledWorker, pollIntervalMs: 100 },
      );
      const changes: string[][] = [];
      const verifiedRevisions: string[] = [];
      const sourceErrors: string[] = [];
      let notify: ((records: string[]) => void) | undefined;
      bridge.subscribe((event) => {
        changes.push(event.changedRecords);
        verifiedRevisions.push(...Object.values(event.observation.revisions));
        if (event.observation.error) sourceErrors.push(event.observation.error);
        for (const entry of event.observation.recordDiagnostics) sourceErrors.push(entry.message);
        notify?.(event.changedRecords);
      });
      const first = await bridge.open(active);
      expect(first.snapshot.source).toMatchObject({ schema: 'noveltea.project.workspace' });
      expect(first.snapshot.inventory).toContain('records/rooms/room-lifecycle-roundtrip.yaml');
      const automaticChange = new Promise<string[]>((resolve) => {
        notify = resolve;
      });
      await writeFile(roomPath, (await readFile(roomPath, 'utf8')) + '\n# external source edit\n');
      const reported = await Promise.race([
        automaticChange,
        new Promise<string[]>((_, reject) =>
          setTimeout(
            () => reject(new Error('Native worker did not publish an automatic change.')),
            4000,
          ),
        ),
      ]);
      expect(reported).toEqual(['rooms/room-lifecycle-roundtrip']);
      expect(changes).toContainEqual(['rooms/room-lifecycle-roundtrip']);
      expect(verifiedRevisions).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)]);
      const modified = bridge.request({
        operation: 'patch',
        expectedRevision: 0,
        patches: [{ operation: 'replace', path: '/project/name', value: 'Worker-certified name' }],
      });
      const unchanged = bridge.request({ operation: 'observe' });
      await expect(modified).resolves.toMatchObject({
        accepted: true,
        snapshot: { workingRevision: 1, dirty: true },
      });
      await expect(unchanged).resolves.toMatchObject({
        authoritative: true,
        unchanged: true,
      });
      // The read-only physical observer must not undo or reorder the working mutation.
      const outOfDate = bridge.request({
        operation: 'patch',
        expectedRevision: 0,
        patches: [{ operation: 'replace', path: '/project/name', value: 'stale' }],
      });
      await expect(outOfDate).resolves.toMatchObject({
        accepted: false,
        snapshot: { workingRevision: 1 },
      });
      const originalRoom = await readFile(roomPath, 'utf8');
      expect(originalRoom).toContain('direction: east');
      await writeFile(roomPath, originalRoom.replace('direction: east', 'direction: west'));
      const invalidRoom = await bridge.request({ operation: 'observe' });
      const directionPath = '/rooms/room-lifecycle-roundtrip/data/exits/1/direction';
      expect(invalidRoom).toMatchObject({
        authoritative: true,
        recordDiagnostics: [
          expect.objectContaining({
            path: directionPath,
            code: 'room.exit.direction-duplicate',
            severity: 'error',
          }),
        ],
      });
      // Diagnostics must persist even if a subsequent observation reports no new bytes.
      const repeated = await bridge.request({ operation: 'observe' });
      expect(repeated).toMatchObject({
        unchanged: true,
        recordDiagnostics: [expect.objectContaining({ path: directionPath })],
      });
      await writeFile(roomPath, originalRoom);
      const repairedRoom = await bridge.request({ operation: 'observe' });
      expect(repairedRoom).toMatchObject({ authoritative: true, recordDiagnostics: [] });
      await mkdir(path.join(root, 'records/maps'), { recursive: true });
      const mapPath = path.join(root, 'records/maps/world.yaml');
      const duplicateMap = [
        'id: world',
        'label: World',
        'data:',
        '  locations:',
        '    - id: foyer',
        '      room: foyer',
        '    - id: hall',
        '      room: foyer',
        '  connections: []',
        '',
      ].join('\n');
      await writeFile(mapPath, duplicateMap);
      const invalidMap = await bridge.request({ operation: 'observe' });
      expect(invalidMap).toMatchObject({
        recordDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            path: '/maps/world/data/locations/1/room/$ref',
            code: 'map.location.room-duplicate',
          }),
        ]),
      });
      await writeFile(
        mapPath,
        duplicateMap.replace('room: foyer\n  connections:', 'room: hall\n  connections:'),
      );
      const repairedMap = await bridge.request({ operation: 'observe' });
      expect(repairedMap).toMatchObject({ recordDiagnostics: [] });
      // Malformed external source bytes remain attributable to this record:
      // preserve diagnostic navigation while blocking writes to that owner.
      await writeFile(roomPath, 'invalid: [');
      const malformed = await bridge.request({ operation: 'observe' });
      expect(malformed).toMatchObject({
        authoritative: false,
        scopedAuthority: true,
        invalidSources: [
          expect.objectContaining({
            path: 'records/rooms/room-lifecycle-roundtrip.yaml',
          }),
        ],
        recordDiagnostics: [
          {
            path: '/rooms/room-lifecycle-roundtrip',
            code: 'source.yaml',
          },
        ],
      });
      expect(sourceErrors.length).toBeGreaterThan(0);
      await copyFile(path.join(fixture, 'records/rooms/room-lifecycle-roundtrip.yaml'), roomPath);
      const repaired = await bridge.request({ operation: 'observe' });
      expect(repaired).toMatchObject({ authoritative: true });
      active = 'certified-B';
      const reopened = await bridge.open(active);
      expect(reopened.sessionId).toBe('certified-B');
      const failed = bridge.request({
        operation: 'patch',
        expectedRevision: 999,
        patches: [{ operation: 'replace', path: '/project/name', value: 'stale' }],
      });
      await expect(failed).resolves.toMatchObject({ accepted: false });
      bridge.close();
      await expect(bridge.request({ operation: 'observe' })).rejects.toThrow();
      await rm(path.join(root, 'project.yaml'));
      await expect(bridge.open(active)).rejects.toThrow('Native Project open failed');
      await copyFile(path.join(fixture, 'project.yaml'), path.join(root, 'project.yaml'));
      await expect(bridge.open(active)).resolves.toMatchObject({ sessionId: active });
      bridge.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
