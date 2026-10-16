import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';

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
      // Malformed external source bytes are reported as record diagnostics,
      // never promoted to normalized Project values.
      await writeFile(roomPath, 'invalid: [');
      const malformed = await bridge.request({ operation: 'observe' });
      expect(malformed).toMatchObject({
        authoritative: true,
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
