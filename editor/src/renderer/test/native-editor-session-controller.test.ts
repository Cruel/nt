import { describe, expect, it, vi } from 'vite-plus/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { NativeAuthoringPreparation } from '../../main/services/native-authoring-worker-contract';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import {
  nativeProjectPatchArgumentsSchema,
  nativeProjectSaveUnitArgumentsSchema,
  nativeProjectSaveTextArgumentsSchema,
  nativeProjectReconcileArgumentsSchema,
  nativeProjectUseDiskUnitArgumentsSchema,
  nativeProjectValidateArgumentsSchema,
} from '../../main/editor-ipc-trust-boundary';
import { toJsonValue } from '../project/json-value';
import { createInitialCommandBusState, executeCommand } from '../commands/command-bus';
import { confirmNativeCommand } from '../commands/native-command-execution';

function fixture() {
  const saved = createAuthoringProject({ id: 'native-open', name: 'Open Project' });
  let active = 'one';
  let fail: ((error: Error) => void) | undefined;
  const authority = {
    requireActiveProjectRoot(id: string) {
      if (active !== id) throw new Error('Project session is stale or unknown.');
      return '/trusted/project';
    },
    isCurrent(id: string) {
      return active === id;
    },
  };
  const close = vi.fn();
  const bridge = {
    close,
    onFailure(callback: (error: Error) => void) {
      fail = callback;
      return () => {
        fail = undefined;
      };
    },
  };
  const preparation: NativeAuthoringPreparation = {
    accepted: true,
    error: '',
    workingRevision: 0,
    project: saved,
    recordOverrides: {},
    completeProject: saved,
    sourceRevisions: {},
    textOverlays: {},
    shaderOverlays: {},
    diagnostics: [],
  };
  const open = vi.fn(async () => ({}));
  const prepareCompleteWorking = vi.fn(async () => preparation);
  const applyRevisionedPatches = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 1 },
  }));
  const snapshot = vi.fn(() => ({ workingRevision: 0 }));
  const saveUnits = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 0 },
    affectedRecords: ['project'],
  }));
  const stageTextSource = vi.fn(async () => ({
    accepted: true, error: '', snapshot: { workingRevision: 1 },
  }));
  const saveTextSources = vi.fn(async () => ({
    accepted: true, error: '', snapshot: { workingRevision: 2 },
    textSourceDiskRevisions: {
      'scripts/game.lua': 'sha256:' + 'a'.repeat(64),
    },
  }));
  const reconcile = vi.fn(async () => ({
    accepted: true, error: '', snapshot: { workingRevision: 1 },
    affectedRecords: ['rooms/hall'],
  }));
  const useDiskUnit = vi.fn(async () => ({
    accepted: true, error: '', snapshot: { workingRevision: 2 },
    affectedRecords: ['rooms/hall'],
  }));
  const working = {
    open, prepareCompleteWorking, applyRevisionedPatches, snapshot,
    saveUnits, stageTextSource, saveTextSources, reconcile, useDiskUnit,
  };
  const controller = new NativeEditorSessionController(
    authority,
    bridge,
    working as unknown as ConstructorParameters<typeof NativeEditorSessionController>[2],
  );
  return {
    saved,
    close,
    open,
    preparation,
    prepareCompleteWorking,
    applyRevisionedPatches,
    saveUnits,
    reconcile,
    useDiskUnit,
    stageTextSource,
    saveTextSources,
    snapshot,
    controller,
    setActive(id: string) {
      active = id;
    },
    fail(error: Error) {
      fail?.(error);
    },
  };
}

describe('native admission at the editor main Project lifecycle', () => {
  it('guards scoped native Use Disk and rejects stale/conflicting sessions', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    expect(nativeProjectUseDiskUnitArgumentsSchema.safeParse([id, 0, 'record:rooms:hall']).success).toBe(true);
    for (const unit of ['../hall', 'record:rooms:../hall', '/tmp/file', ''])
      expect(nativeProjectUseDiskUnitArgumentsSchema.safeParse([id, 0, unit]).success).toBe(false);
    const test = fixture();
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall'))
      .rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.useDiskUnit('one', 2, 'record:rooms:hall'))
      .rejects.toThrow('Stale');
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall'))
      .resolves.toMatchObject({ accepted: true });
    expect(test.useDiskUnit).toHaveBeenCalledWith('record:rooms:hall');
    test.setActive('other');
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall'))
      .rejects.toThrow('not admitted');
    test.controller.dispose();
  });
  it('admits only canonical native reconciliation owners and checks session/revision', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    for (const owner of ['project', 'editor', 'traits', 'rooms/hall', 'i18n/en'])
      expect(nativeProjectReconcileArgumentsSchema.safeParse([id, 0, owner]).success).toBe(true);
    for (const owner of ['../project', 'rooms/../bad', 'rooms/hall/file', 'scripts/a.lua', '/project'])
      expect(nativeProjectReconcileArgumentsSchema.safeParse([id, 0, owner]).success).toBe(false);
    const test = fixture();
    await expect(test.controller.reconcile('one', 0, 'rooms/hall')).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.reconcile('one', 5, 'rooms/hall')).rejects.toThrow('Stale');
    await expect(test.controller.reconcile('one', 0, 'rooms/hall')).resolves.toMatchObject({
      accepted: true, affectedRecords: ['rooms/hall'],
    });
    expect(test.reconcile).toHaveBeenCalledWith('rooms/hall');
    test.setActive('other');
    await expect(test.controller.reconcile('one', 0, 'rooms/hall')).rejects.toThrow('not admitted');
    test.controller.dispose();
  });
  it('runs native working-generation validation without supplying a TypeScript authoring Project', async () => {
    const test = fixture();
    const session = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    expect(nativeProjectValidateArgumentsSchema.safeParse([session, 0]).success).toBe(true);
    expect(nativeProjectValidateArgumentsSchema.safeParse([session, -1]).success).toBe(false);
    expect(nativeProjectValidateArgumentsSchema.safeParse([session, 0, {}]).success).toBe(false);
    await expect(test.controller.validate('one', 0)).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.validate('one', 9)).rejects.toThrow('Stale');
    test.prepareCompleteWorking.mockResolvedValueOnce({
      ...test.preparation,
      accepted: false,
      error: 'Working Room source is invalid.',
      diagnostics: [{
        code: 'room.bounds.invalid',
        severity: 'error',
        path: '/rooms/start/data',
        message: 'Room invalid',
        sourcePath: 'records/rooms/start.yaml',
        line: 7,
      }],
    });
    await expect(test.controller.validate('one', 0)).resolves.toMatchObject({
      ok: true,
      success: false,
      diagnostics: [expect.objectContaining({
        code: 'room.bounds.invalid',
        severity: 'error',
        category: 'Native authoring validation',
        message: expect.stringContaining('records/rooms/start.yaml:7'),
      })],
    });
    test.controller.dispose();
  });
  it('guards source Save schema and resolves revisioned Stage/Save through the admitted owner', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    const hash = 'sha256:' + '1'.repeat(64);
    expect(nativeProjectSaveTextArgumentsSchema.safeParse([
      id, 0, 'scripts/game.lua', hash, 'return true',
    ]).success).toBe(true);
    for (const path of ['../escape.lua', '/tmp/script.lua', '.noveltea/config.lua'])
      expect(nativeProjectSaveTextArgumentsSchema.safeParse([
        id, 0, path, hash, 'return true',
      ]).success).toBe(false);
    expect(nativeProjectSaveTextArgumentsSchema.safeParse([
      id, 0, 'scripts/game.lua', 'wrong', 'return true',
    ]).success).toBe(false);
    const test = fixture();
    await expect(test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'))
      .rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.saveText('one', 9, 'scripts/game.lua', hash, 'return true'))
      .rejects.toThrow('Stale');
    await expect(test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'))
      .resolves.toMatchObject({ accepted: true });
    expect(test.stageTextSource).toHaveBeenCalledWith('scripts/game.lua', 'return true', hash);
    expect(test.saveTextSources).toHaveBeenCalledWith(1, ['scripts/game.lua']);
    await expect(test.controller.stageText('one', 0, 'scripts/game.lua', hash, 'return 2'))
      .resolves.toMatchObject({ accepted: true });
    expect(test.stageTextSource).toHaveBeenLastCalledWith('scripts/game.lua', 'return 2', hash);
    test.setActive('two');
    await expect(test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'))
      .rejects.toThrow('not admitted');
    test.controller.dispose();
  });
  it('validates native scoped Save input without allowing arbitrary filesystem paths', () => {
    const sessionId = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        'record:rooms:foyer',
        { comments: 'keep', keepMine: false },
      ]).success,
    ).toBe(true);
    expect(nativeProjectSaveUnitArgumentsSchema.safeParse([
      sessionId, 0, ['record:rooms:foyer', 'record:rooms:kitchen'], {},
    ]).success).toBe(true);
    expect(nativeProjectSaveUnitArgumentsSchema.safeParse([
      sessionId, 0, ['project:settings', '../escape'], {},
    ]).success).toBe(false);
    for (const unit of ['', '../escape', 'record:rooms:../../out', 'project/settings', 'a'.repeat(257)])
      expect(nativeProjectSaveUnitArgumentsSchema.safeParse([sessionId, 0, unit, {}]).success).toBe(
        false,
      );
    expect(nativeProjectSaveUnitArgumentsSchema.safeParse([sessionId, 0, 'project:settings', { comments: 'override' }]).success).toBe(false);
    expect(nativeProjectSaveUnitArgumentsSchema.safeParse([sessionId, -1, 'project:settings', {}]).success).toBe(false);
  });

  it('authorizes logical native Save only for the exact revision and admitted Project', async () => {
    const test = fixture();
    await expect(
      test.controller.saveUnit('one', 0, 'project:settings', { comments: 'keep' }),
    ).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(
      test.controller.saveUnit('one', 1, 'project:settings', {}),
    ).rejects.toThrow('Stale');
    expect(test.saveUnits).not.toHaveBeenCalled();
    await expect(
      test.controller.saveUnit('one', 0, 'project:settings', { comments: 'remove' }),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.saveUnits).toHaveBeenCalledWith(['project:settings'], { comments: 'remove' }, 0);
    await expect(
      test.controller.saveUnit('one', 0, ['record:rooms:foyer', 'record:rooms:kitchen'], {}),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.saveUnits).toHaveBeenLastCalledWith(
      ['record:rooms:foyer', 'record:rooms:kitchen'], {}, 0,
    );
    test.setActive('two');
    await expect(
      test.controller.saveUnit('one', 0, 'project:settings', {}),
    ).rejects.toThrow('not admitted');
    expect(test.saveUnits).toHaveBeenCalledTimes(2);
    test.controller.dispose();
  });

  it('rejects malformed, oversized and non-JSON native mutation IPC requests', () => {
    const sessionId = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    const valid = [sessionId, 0, [{ op: 'replace', path: '/project/name', value: 'Next' }]];
    expect(nativeProjectPatchArgumentsSchema.safeParse(valid).success).toBe(true);
    for (const patches of [
      [{ op: 'replace', path: '/project/~2bad', value: 'bad' }],
      [{ op: 'replace', path: '', value: 'bad' }],
      [{ op: 'replace', path: '/project/name', value: undefined }],
      [{ op: 'remove', path: '/project/name', value: true }],
      [{ op: 'add', path: '/project/name', value: Number.POSITIVE_INFINITY }],
      Array.from({ length: 257 }, () => ({ op: 'remove', path: '/project/name' })),
    ])
      expect(nativeProjectPatchArgumentsSchema.safeParse([sessionId, 0, patches]).success).toBe(
        false,
      );
    expect(nativeProjectPatchArgumentsSchema.safeParse([sessionId, -1, valid[2]]).success).toBe(
      false,
    );
  });

  it('authorizes revision-checked generic patches for the currently admitted session only', async () => {
    const test = fixture();
    const patches = [{ op: 'replace' as const, path: '/project/name', value: 'New Name' }];
    await expect(test.controller.applyRevisionedPatches('one', 0, patches)).rejects.toThrow(
      'not admitted',
    );
    await test.controller.admit('one', test.saved);
    await expect(test.controller.applyRevisionedPatches('one', 0, patches)).resolves.toMatchObject({
      accepted: true,
    });
    expect(test.applyRevisionedPatches).toHaveBeenCalledWith(0, patches);
    test.setActive('two');
    await expect(test.controller.applyRevisionedPatches('one', 1, patches)).rejects.toThrow(
      'not admitted',
    );
    expect(test.applyRevisionedPatches).toHaveBeenCalledTimes(1);
    test.controller.dispose();
  });

  it('does not publish a late native response after session close', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    let release!: () => void;
    test.applyRevisionedPatches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ accepted: true, error: '', snapshot: { workingRevision: 1 } });
        }),
    );
    const pending = test.controller.applyRevisionedPatches('one', 0, [
      { op: 'replace', path: '/project/name', value: 'New' },
    ]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    test.controller.close();
    release();
    await expect(pending).rejects.toThrow('superseded');
    test.controller.dispose();
  });
  it('tracks in-flight activation generations independently of the current Project ID', () => {
    const sessions = new ActiveProjectSessionService();
    const first = sessions.beginProjectActivation();
    expect(sessions.isProjectActivationCurrent(first)).toBe(true);
    const second = sessions.beginProjectActivation();
    expect(sessions.isProjectActivationCurrent(first)).toBe(false);
    expect(sessions.isProjectActivationCurrent(second)).toBe(true);
    sessions.closeActiveProject();
    expect(sessions.isProjectActivationCurrent(second)).toBe(false);
  });

  it('admits only current main-owned Projects after full saved-value parity', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    expect(test.controller.isAdmitted('one')).toBe(true);
    expect(test.open).toHaveBeenCalledWith('one');
    expect(test.prepareCompleteWorking).toHaveBeenCalledWith();
    test.setActive('two');
    expect(test.controller.isAdmitted('one')).toBe(false);
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('stale');
    expect(test.open).toHaveBeenCalledTimes(1);
    test.controller.dispose();
  });

  it('rejects native/Workspace divergence and rejected preparation rather than falling back', async () => {
    const test = fixture();
    test.prepareCompleteWorking.mockResolvedValueOnce({
      ...test.preparation,
      completeProject: {
        ...test.saved,
        project: { ...test.saved.project, name: 'Divergent Project' },
      },
    });
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('differs');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.prepareCompleteWorking.mockResolvedValueOnce({
      ...test.preparation,
      accepted: false,
      error: 'Invalid dirty owner',
      completeProject: null,
    });
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('Invalid dirty owner');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.controller.dispose();
  });

  it('revokes the old admission on worker failure, close and superseding activation', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    test.fail(new Error('worker crashed'));
    expect(test.controller.isAdmitted('one')).toBe(false);
    await test.controller.admit('one', test.saved);

    let release!: () => void;
    test.prepareCompleteWorking.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(test.preparation);
        }),
    );
    const pending = test.controller.admit('one', test.saved);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    test.controller.close();
    release();
    await expect(pending).rejects.toThrow('superseded');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.controller.dispose();
  });
});

const nativeAddon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
describe.skipIf(!nativeAddon)('real native worker admission of the editor Project', () => {
  it('admits the exact Feature Lab saved Project and revokes it on close', async () => {
    const fixture = path.resolve(process.cwd(), '../tests/projects/feature-lab');
    const opened = await createNodeProjectWorkspaceService().open(fixture);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: nativeAddon!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 200,
    });
    const controller = new NativeEditorSessionController(
      sessions,
      bridge,
      new NativeAuthoringWorkingProject(bridge),
    );
    try {
      const id = await sessions.activateProjectFile(path.join(fixture, 'project.yaml'));
      await controller.admit(id, opened.snapshot.project);
      expect(controller.isAdmitted(id)).toBe(true);
      const before = await readFile(path.join(fixture, 'project.yaml'), 'utf8');
      const edited = await controller.applyRevisionedPatches(id, 0, [
        { op: 'replace', path: '/project/name', value: 'Unsaved Native Name' },
      ]);
      expect(edited.accepted, edited.error).toBe(true);
      expect(edited.snapshot.workingRevision).toBe(1);
      expect(edited.snapshot.source).toMatchObject({ project: { name: 'Unsaved Native Name' } });
      const beforeCommand = createInitialCommandBusState(
        toJsonValue({
          ...opened.snapshot.project,
          project: { ...opened.snapshot.project.project, name: 'Unsaved Native Name' },
        }),
      );
      const proposal = executeCommand(beforeCommand, {
        type: 'project.replaceAtPath',
        payload: { path: '/project/name', value: 'Native Command Edition' },
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      });
      expect(proposal.ok).toBe(true);
      const confirmed = await confirmNativeCommand(
        beforeCommand,
        proposal,
        proposal.historyEntry!.patches,
        id,
        1,
        (session, revision, patches) =>
          controller.applyRevisionedPatches(session, revision, patches),
      );
      expect(confirmed.result.ok).toBe(true);
      expect(confirmed.workingRevision).toBe(2);
      expect(confirmed.result.state.document).toMatchObject({
        project: { name: 'Native Command Edition' },
      });
      await expect(
        controller.applyRevisionedPatches(id, 0, [
          { op: 'replace', path: '/project/name', value: 'Stale Edit' },
        ]),
      ).rejects.toThrow('Stale native Project mutation revision');
      expect(await readFile(path.join(fixture, 'project.yaml'), 'utf8')).toBe(before);
      controller.close();
      expect(controller.isAdmitted(id)).toBe(false);
      await expect(controller.admit('stale-id', opened.snapshot.project)).rejects.toThrow('stale');
    } finally {
      controller.dispose();
      sessions.dispose();
    }
  }, 120_000);
});
