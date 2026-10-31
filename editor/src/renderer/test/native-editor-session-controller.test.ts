import { describe, expect, it, vi } from 'vite-plus/test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  cp as copyDirectory,
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  authoringProjectSchema,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import type {
  NativeAuthoringPreparation,
  NativeAuthoringWorkingValidation,
} from '../../main/services/native-authoring-worker-contract';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { projectFromNativeCompletePreparation } from '../../main/services/native-authoring-runtime-preparation';
import { openNativeEditorProject } from '../../main/services/native-editor-project-open';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import {
  NativeAuthoringWorkingProject,
  type NativeDirtyCheckpoint,
} from '../../main/services/native-authoring-working-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
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

async function cp(source: string, destination: string, options: { recursive: true }) {
  await copyDirectory(source, destination, {
    ...options,
    filter: (candidate) => !candidate.split(path.sep).includes('.noveltea'),
  });
}

function fixture(projectRoot = '/trusted/project') {
  const saved = createAuthoringProject({ id: 'native-open', name: 'Open Project' });
  let active = 'one';
  let fail: ((error: Error) => void) | undefined;
  const authority = {
    requireActiveProjectRoot(id: string) {
      if (active !== id) throw new Error('Project session is stale or unknown.');
      return projectRoot;
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
    referencedAssetIds: [],
  };
  const open = vi.fn(async () => ({}));
  const prepareCompleteWorking = vi.fn(async () => preparation);
  const validateWorking = vi.fn(
    async (): Promise<NativeAuthoringWorkingValidation> => ({
      valid: true,
      workingRevision: 0,
      diagnostics: [],
    }),
  );
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
  const saveOwners = vi.fn(async () => ({
    accepted: false,
    error: 'Deleting commented records requires explicit Remove Comments approval.',
    snapshot: { workingRevision: 0 },
    affectedRecords: [],
  }));
  const stageTextSource = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 1 },
  }));
  const saveTextSources = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 2 },
    textSourceDiskRevisions: {
      'scripts/game.lua': 'sha256:' + 'a'.repeat(64),
    },
  }));
  const reconcile = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 1 },
    affectedRecords: ['rooms/hall'],
  }));
  const useDiskUnit = vi.fn(async () => ({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 2 },
    affectedRecords: ['rooms/hall'],
  }));
  const dirtyCheckpoint = vi.fn(() => ({
    batches: [],
    textSources: {},
    conflicts: {},
    pendingFields: {},
  }));
  const restoreDirtyCheckpoint = vi.fn(async () => ({ workingRevision: 0 }));
  const reopenAndReplay = vi.fn(async () => ({ workingRevision: 0 }));
  const working = {
    open,
    prepareCompleteWorking,
    validateWorking,
    applyRevisionedPatches,
    snapshot,
    saveUnits,
    saveOwners,
    stageTextSource,
    saveTextSources,
    reconcile,
    useDiskUnit,
    dirtyCheckpoint,
    restoreDirtyCheckpoint,
    reopenAndReplay,
  };
  const checkpoints = {
    read: vi.fn(async (): Promise<NativeDirtyCheckpoint | null> => null),
    write: vi.fn(async () => {}),
  };
  const controller = new NativeEditorSessionController(
    authority,
    bridge,
    working as unknown as ConstructorParameters<typeof NativeEditorSessionController>[2],
    checkpoints,
  );
  return {
    saved,
    close,
    open,
    preparation,
    prepareCompleteWorking,
    validateWorking,
    applyRevisionedPatches,
    saveUnits,
    saveOwners,
    reconcile,
    useDiskUnit,
    dirtyCheckpoint,
    restoreDirtyCheckpoint,
    reopenAndReplay,
    checkpoints,
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

/** Exercise the shipped native candidate admission/promotion boundary, not
 * the retired TypeScript Project Workspace activation shortcut. */
async function admitNativeSession(
  sessions: ActiveProjectSessionService,
  controller: NativeEditorSessionController,
  root: string,
) {
  const generation = sessions.beginProjectActivation();
  const id = await sessions.stageNativeProjectFile(path.join(root, 'project.yaml'), generation);
  const admitted = await controller.admitFromNative(id);
  await sessions.acceptNativeProject(id, admitted.savedProject);
  sessions.commitStagedNativeProject(id, generation);
  return { id, admitted };
}

describe('native admission at the editor main Project lifecycle', () => {
  it('opens without a TypeScript saved Workspace and reads recovery using native identity', async () => {
    const root = '/trusted/native-only';
    const test = fixture(root);
    const result = await test.controller.admitFromNative('one');
    expect(result).toEqual({
      revision: 0,
      savedProject: test.saved,
      sourceRevisions: {},
      diagnostics: [],
    });
    expect(test.open).toHaveBeenCalledExactlyOnceWith('one');
    expect(test.checkpoints.read).toHaveBeenCalledExactlyOnceWith(root, 'native-open');
    expect(test.controller.isAdmitted('one')).toBe(true);
    test.controller.dispose();
  });

  it('refuses a corrupt recovery lookup instead of accepting native disk state alone', async () => {
    const test = fixture();
    test.checkpoints.read.mockRejectedValueOnce(new Error('Native recovery identity conflict'));
    await expect(test.controller.admitFromNative('one')).rejects.toThrow(
      'Native recovery identity conflict',
    );
    expect(test.controller.isAdmitted('one')).toBe(false);
    expect(test.close).toHaveBeenCalled();
    test.controller.dispose();
  });

  it('exports only a clean native snapshot whose saved file revisions are still current', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-export-'));
    try {
      const source = Buffer.from('project: native\n');
      await writeFile(path.join(root, 'project.yaml'), source);
      const test = fixture(root);
      test.preparation.sourceRevisions = {
        'project.yaml': `sha256:${createHash('sha256').update(source).digest('hex')}`,
      };
      await test.controller.admit('one', test.saved);
      expect(await test.controller.prepareCleanExport('one')).toEqual(test.saved);
      expect(await test.controller.prepareCleanExportAdmission('one')).toMatchObject({
        project: test.saved,
        runtimeAssetReferences: [],
        workingRevision: 0,
        sourceRevisions: test.preparation.sourceRevisions,
      });
      test.dirtyCheckpoint.mockReturnValueOnce({
        batches: [{ patches: [], diskPreconditions: {} }],
        textSources: {},
        conflicts: {},
        pendingFields: {},
      } as unknown as ReturnType<typeof test.dirtyCheckpoint>);
      await expect(test.controller.prepareCleanExport('one')).rejects.toThrow(/Save or resolve/);
      await writeFile(path.join(root, 'project.yaml'), 'project: overwritten\n');
      await expect(test.controller.prepareCleanExport('one')).rejects.toThrow(
        /changed since admission/,
      );
      test.controller.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses main-owned bytes rather than renderer-provided file targets for native publication', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-stage-'));
    try {
      const test = fixture(root);
      await test.controller.admit('one', test.saved);
      await test.controller.stageAsset(
        'one',
        'assets/images/imported.png',
        Buffer.from([0, 1, 255]),
      );
      test.saveOwners.mockResolvedValueOnce({
        accepted: true,
        error: '',
        snapshot: { workingRevision: 0 },
        affectedRecords: [],
      });
      const result = await test.controller.saveUnit('one', 0, [], {
        structuralPathsByOwner: {},
        assetTransition: { kind: 'publish', projectRelativePaths: ['assets/images/imported.png'] },
      });
      expect(result.accepted).toBe(true);
      const savedOptions = (
        test.saveOwners.mock.calls as unknown as Array<[string[], { assetTransition?: unknown }]>
      ).at(-1)?.[1];
      expect(savedOptions?.assetTransition).toMatchObject({
        kind: 'publish',
        files: [{ projectRelativePath: 'assets/images/imported.png' }],
      });
      await expect(
        test.controller.saveUnit('one', 0, [], {
          structuralPathsByOwner: {},
          assetTransition: {
            kind: 'publish',
            projectRelativePaths: ['assets/images/imported.png'],
          },
        }),
      ).rejects.toThrow(/not staged/);
      test.controller.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('replays a durable checkpoint only after comparing clean native and editor sources', async () => {
    const test = fixture();
    const checkpoint = {
      batches: [
        {
          patches: [{ operation: 'replace' as const, path: '/project/name', value: 'Dirty' }],
          diskPreconditions: { project: `sha256:${'a'.repeat(64)}` },
        },
      ],
      textSources: {},
      conflicts: {},
      pendingFields: {},
    };
    test.checkpoints.read.mockResolvedValueOnce(checkpoint);
    const recovered = { ...test.saved, project: { ...test.saved.project, name: 'Dirty' } };
    test.prepareCompleteWorking.mockResolvedValueOnce(test.preparation).mockResolvedValueOnce({
      ...test.preparation,
      completeProject: recovered,
      workingRevision: 1,
    });
    expect(await test.controller.admit('one', test.saved)).toBe(1);
    expect(test.restoreDirtyCheckpoint).toHaveBeenCalledWith('one', checkpoint);
    expect(test.controller.recoveredContentProject()?.project.name).toBe('Dirty');
    test.controller.close();
    expect(test.controller.recoveredContentProject()).toBeNull();
    test.controller.dispose();
  });

  it('blocks publication when an acknowledged native mutation cannot be checkpointed', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    test.checkpoints.write.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      test.controller.applyRevisionedPatches('one', 0, [
        { op: 'replace', path: '/project/name', value: 'Dirty' },
      ]),
    ).rejects.toThrow('disk full');
    expect(test.controller.isAdmitted('one')).toBe(false);
    expect(test.controller.recoveryError()).toContain('disk full');
    test.controller.dispose();
  });

  it('worker failure restores the durable checkpoint rather than a possibly unacknowledged RAM batch', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    const checkpoint = { batches: [], textSources: {}, conflicts: {}, pendingFields: {} };
    test.checkpoints.read.mockResolvedValueOnce(checkpoint);
    test.fail(new Error('worker exited'));
    expect(test.controller.isAdmitted('one')).toBe(false);
    await vi.waitFor(() =>
      expect(test.restoreDirtyCheckpoint).toHaveBeenCalledWith('one', checkpoint),
    );
    // Renderer revision/undo state must be resynchronized by reopening the Project.
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.controller.dispose();
  });

  it('guards scoped native Use Disk and rejects stale/conflicting sessions', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    expect(
      nativeProjectUseDiskUnitArgumentsSchema.safeParse([id, 0, 'record:rooms:hall']).success,
    ).toBe(true);
    for (const unit of ['../hall', 'record:rooms:../hall', '/tmp/file', ''])
      expect(nativeProjectUseDiskUnitArgumentsSchema.safeParse([id, 0, unit]).success).toBe(false);
    const test = fixture();
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall')).rejects.toThrow(
      'not admitted',
    );
    await test.controller.admit('one', test.saved);
    await expect(test.controller.useDiskUnit('one', 2, 'record:rooms:hall')).rejects.toThrow(
      'Stale',
    );
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall')).resolves.toMatchObject(
      { accepted: true },
    );
    expect(test.useDiskUnit).toHaveBeenCalledWith('record:rooms:hall');
    test.setActive('other');
    await expect(test.controller.useDiskUnit('one', 0, 'record:rooms:hall')).rejects.toThrow(
      'not admitted',
    );
    test.controller.dispose();
  });
  it('admits only canonical native reconciliation owners and checks session/revision', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    for (const owner of [
      'project',
      'editor',
      'traits',
      'rooms/hall',
      'i18n/en',
      'i18n/project.yaml',
      'i18n/messages.yaml',
      'i18n/locales/fr-CA.yaml',
      'i18n/assets/en.yaml',
    ])
      expect(nativeProjectReconcileArgumentsSchema.safeParse([id, 0, owner]).success).toBe(true);
    for (const owner of [
      '../project',
      'rooms/../bad',
      'rooms/hall/file',
      'scripts/a.lua',
      '/project',
      'i18n/locales/../fr.yaml',
      'i18n/locales/name/extra.yaml',
    ])
      expect(nativeProjectReconcileArgumentsSchema.safeParse([id, 0, owner]).success).toBe(false);
    const test = fixture();
    await expect(test.controller.reconcile('one', 0, 'rooms/hall')).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.reconcile('one', 5, 'rooms/hall')).rejects.toThrow('Stale');
    await expect(test.controller.reconcile('one', 0, 'rooms/hall')).resolves.toMatchObject({
      accepted: true,
      affectedRecords: ['rooms/hall'],
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
    test.validateWorking.mockResolvedValueOnce({
      valid: false,
      workingRevision: 0,
      diagnostics: [
        {
          code: 'room.bounds.invalid',
          severity: 'error',
          path: '/rooms/start/data',
          message: 'Room invalid',
          sourcePath: 'records/rooms/start.yaml',
          line: 7,
        },
      ],
    });
    await expect(test.controller.validate('one', 0)).resolves.toMatchObject({
      ok: true,
      success: false,
      diagnostics: [
        expect.objectContaining({
          code: 'room.bounds.invalid',
          severity: 'error',
          category: 'Native authoring validation',
          message: expect.stringContaining('records/rooms/start.yaml:7'),
        }),
      ],
    });
    test.controller.dispose();
  });
  it('guards source Save schema and resolves revisioned Stage/Save through the admitted owner', async () => {
    const id = 'b107a86e-0e36-472d-8db1-1ab0de300e04';
    const hash = 'sha256:' + '1'.repeat(64);
    const mixed = {
      textPaths: ['scripts/game.lua'],
      textContents: { 'scripts/game.lua': 'return true' },
    };
    expect(nativeProjectSaveUnitArgumentsSchema.safeParse([id, 0, [], mixed]).success).toBe(true);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        id,
        0,
        [],
        {
          textPaths: ['scripts/game.lua'],
        },
      ]).success,
    ).toBe(false);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        id,
        0,
        [],
        {
          textPaths: ['../escape.lua'],
          textContents: { '../escape.lua': 'return true' },
        },
      ]).success,
    ).toBe(false);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        id,
        0,
        [],
        {
          textPaths: ['scripts/game.lua'],
          textContents: { 'scripts/game.lua': 'return true', 'scripts/other.lua': 'return false' },
        },
      ]).success,
    ).toBe(false);
    expect(
      nativeProjectSaveTextArgumentsSchema.safeParse([
        id,
        0,
        'scripts/game.lua',
        hash,
        'return true',
      ]).success,
    ).toBe(true);
    for (const path of ['../escape.lua', '/tmp/script.lua', '.noveltea/config.lua'])
      expect(
        nativeProjectSaveTextArgumentsSchema.safeParse([id, 0, path, hash, 'return true']).success,
      ).toBe(false);
    expect(
      nativeProjectSaveTextArgumentsSchema.safeParse([
        id,
        0,
        'scripts/game.lua',
        'wrong',
        'return true',
      ]).success,
    ).toBe(false);
    const test = fixture();
    await expect(
      test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'),
    ).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(
      test.controller.saveText('one', 9, 'scripts/game.lua', hash, 'return true'),
    ).rejects.toThrow('Stale');
    await expect(
      test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.stageTextSource).toHaveBeenCalledWith('scripts/game.lua', 'return true', hash);
    expect(test.saveTextSources).toHaveBeenCalledWith(1, ['scripts/game.lua']);
    await expect(
      test.controller.stageText('one', 0, 'scripts/game.lua', hash, 'return 2'),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.stageTextSource).toHaveBeenLastCalledWith('scripts/game.lua', 'return 2', hash);
    test.setActive('two');
    await expect(
      test.controller.saveText('one', 0, 'scripts/game.lua', hash, 'return true'),
    ).rejects.toThrow('not admitted');
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
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        ['record:rooms:foyer', 'record:rooms:kitchen'],
        {},
      ]).success,
    ).toBe(true);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        ['project:settings', '../escape'],
        {},
      ]).success,
    ).toBe(false);
    for (const unit of [
      '',
      '../escape',
      'record:rooms:../../out',
      'project/settings',
      'a'.repeat(257),
    ])
      expect(nativeProjectSaveUnitArgumentsSchema.safeParse([sessionId, 0, unit, {}]).success).toBe(
        false,
      );
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        'project:settings',
        { comments: 'override' },
      ]).success,
    ).toBe(false);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([sessionId, -1, 'project:settings', {}])
        .success,
    ).toBe(false);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        [],
        { structuralPathsByOwner: { 'rooms/foyer': ['/'] } },
      ]).success,
    ).toBe(true);
    expect(
      nativeProjectSaveUnitArgumentsSchema.safeParse([
        sessionId,
        0,
        [],
        { structuralPathsByOwner: { 'i18n/messages.yaml': ['/structuredMessageIds'] } },
      ]).success,
    ).toBe(true);
    for (const owner of ['rooms/../../escape', '/tmp/escape', 'rooms/FOYER'])
      expect(
        nativeProjectSaveUnitArgumentsSchema.safeParse([
          sessionId,
          0,
          [],
          { structuralPathsByOwner: { [owner]: ['/'] } },
        ]).success,
      ).toBe(false);
  });

  it('returns source comments for native structural deletion approval without writing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-comment-approval-'));
    try {
      const relative = 'records/rooms/commented-room.yaml';
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(
        path.join(root, relative),
        'id: commented-room\n# Keep this explanation\nlabel: Room\n',
      );
      const test = fixture(root);
      await test.controller.admit('one', test.saved);
      const reviewed = await test.controller.saveUnit('one', 0, [], {
        comments: 'keep',
        structuralPathsByOwner: { 'rooms/commented-room': ['/'] },
      });
      expect(reviewed).toMatchObject({
        accepted: false,
        commentImpacts: [
          {
            file: relative,
            kind: 'deleted',
            comment: expect.stringContaining('Keep this explanation'),
          },
        ],
      });
      expect(test.saveOwners).toHaveBeenCalledWith(['rooms/commented-room'], {
        pathsByOwner: { 'rooms/commented-room': ['/'] },
        comments: 'keep',
        keepMine: undefined,
        expectedRevision: 0,
      });
      expect(await readFile(path.join(root, relative), 'utf8')).toContain('Keep this explanation');
      test.controller.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('authorizes logical native Save only for the exact revision and admitted Project', async () => {
    const test = fixture();
    await expect(
      test.controller.saveUnit('one', 0, 'project:settings', { comments: 'keep' }),
    ).rejects.toThrow('not admitted');
    await test.controller.admit('one', test.saved);
    await expect(test.controller.saveUnit('one', 1, 'project:settings', {})).rejects.toThrow(
      'Stale',
    );
    expect(test.saveUnits).not.toHaveBeenCalled();
    await expect(
      test.controller.saveUnit('one', 0, 'project:settings', { comments: 'remove' }),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.saveUnits).toHaveBeenCalledWith(['project:settings'], { comments: 'remove' }, 0);
    await expect(
      test.controller.saveUnit('one', 0, ['record:rooms:foyer', 'record:rooms:kitchen'], {}),
    ).resolves.toMatchObject({ accepted: true });
    expect(test.saveUnits).toHaveBeenLastCalledWith(
      ['record:rooms:foyer', 'record:rooms:kitchen'],
      {},
      0,
    );
    test.setActive('two');
    await expect(test.controller.saveUnit('one', 0, 'project:settings', {})).rejects.toThrow(
      'not admitted',
    );
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
      Array.from({ length: 2101 }, () => ({ op: 'remove', path: '/project/name' })),
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
  it('preserves a running native Project worker when a second native admission is invalid', async () => {
    const original = await mkdtemp(path.join(tmpdir(), 'noveltea-native-incumbent-'));
    const candidate = await mkdtemp(path.join(tmpdir(), 'noveltea-native-candidate-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), original, {
      recursive: true,
    });
    await writeFile(path.join(candidate, 'project.yaml'), 'invalid: [');
    const sessions = new ActiveProjectSessionService();
    const makeController = () => {
      const bridge = new NativeAuthoringSessionBridge(sessions, {
        addonPath: nativeAddon!,
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
    const incumbent = makeController();
    const pending = makeController();
    try {
      const { id: oldId } = await admitNativeSession(sessions, incumbent, original);
      const rejected = await openNativeEditorProject(
        candidate,
        sessions.beginProjectActivation(),
        sessions,
        pending,
      );
      expect(rejected.success).toBe(false);
      expect(sessions.currentSessionId()).toBe(oldId);
      expect(incumbent.isAdmitted(oldId)).toBe(true);
      expect((await incumbent.currentWorkingProject(oldId)).project.id).toBe('feature-lab');
    } finally {
      pending.dispose();
      incumbent.dispose();
      sessions.dispose();
      await Promise.all(
        [original, candidate].map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  }, 120_000);

  it('opens native-only Editor Project with local state and physical Project revisions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-editor-open-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
      recursive: true,
    });
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: nativeAddon!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 100,
    });
    expect(bridge.sourceRevision(Buffer.from('abc'))).toBe(
      'xxh3-128:06b05ab6733a618578af5f94892f3950',
    );
    sessions.setNativeSourceRevisionFor(
      (bytes) => bridge.sourceRevision(bytes) as `xxh3-128:${string}`,
    );
    const working = new NativeAuthoringWorkingProject(bridge);
    const controller = new NativeEditorSessionController(sessions, bridge, working);
    try {
      const opened = await openNativeEditorProject(
        root,
        sessions.beginProjectActivation(),
        sessions,
        controller,
      );
      expect(opened.success, opened.error).toBe(true);
      expect(opened.projectSessionId).toBe(sessions.currentSessionId());
      expect(opened.nativeWorkingRevision).toBeGreaterThanOrEqual(0);
      expect(sessions.currentProjectIdentity()).toEqual({ id: 'feature-lab', name: 'Feature Lab' });
      expect(opened.editorState).toBeDefined();
      expect(opened.recoveryFileRevisions?.['project.yaml']).toMatch(/^xxh3-128:[a-f0-9]{32}$/u);
      const listed = await sessions.listProjectSourceFiles({
        projectSessionId: opened.projectSessionId!,
      });
      const script = listed.files.find((file) => file.id === 'scripts/notice-board.lua');
      expect(script?.contentHash).toMatch(/^xxh3-128:[a-f0-9]{32}$/u);
      const physical = await readFile(path.join(root, script!.projectRelativePath));
      expect(script?.contentHash).toBe(bridge.sourceRevision(physical));
      const sourceRead = await sessions.read({
        projectSessionId: opened.projectSessionId!,
        entries: [
          {
            readKey: script!.id,
            projectRelativePath: script!.projectRelativePath,
            expectedContentHash: script!.contentHash as `xxh3-128:${string}`,
          },
        ],
      });
      expect(sourceRead.entries[0]).toMatchObject({
        status: 'ready',
        contentHash: script?.contentHash,
      });
      expect('requireActiveWorkspace' in sessions).toBe(false);
      const raw = await working.prepareCompleteWorking();
      const projected = projectFromNativeCompletePreparation(raw);
      // The production adapter does not normalize; this test-only comparison
      // proves native Feature Lab owners already materialize semantic defaults.
      expect(projected).toEqual(authoringProjectSchema.parse(projected));
      expect(projected.rooms).toBe((raw.completeProject as typeof projected).rooms);
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('opens Feature Lab and recovers native identity without instantiating a TypeScript Workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-only-open-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
      recursive: true,
    });
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: nativeAddon!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 100,
    });
    const controller = new NativeEditorSessionController(
      sessions,
      bridge,
      new NativeAuthoringWorkingProject(bridge),
    );
    try {
      const { id: sessionId, admitted } = await admitNativeSession(sessions, controller, root);
      expect(admitted.savedProject.project).toMatchObject({
        id: 'feature-lab',
        name: 'Feature Lab',
      });
      expect(admitted.revision).toBeGreaterThanOrEqual(0);
      expect(controller.isAdmitted(sessionId)).toBe(true);
      expect(await controller.currentWorkingProject(sessionId)).toEqual(admitted.savedProject);
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('publishes Project Explorer files and Material shader copies through the native journal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-source-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
      recursive: true,
    });
    await mkdir(path.join(root, 'support'), { recursive: true });
    await writeFile(path.join(root, 'support', 'issue-511-license.txt'), 'Native license\n');
    const assetRecord = path.join(root, 'records', 'assets', 'counter-template.yaml');
    await writeFile(
      assetRecord,
      (await readFile(assetRecord, 'utf8')) +
        '  attachments:\n    - path: support/issue-511-license.txt\n      purpose: reference\n',
    );
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: nativeAddon!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 100,
    });
    const controller = new NativeEditorSessionController(
      sessions,
      bridge,
      new NativeAuthoringWorkingProject(bridge),
    );
    try {
      const { id } = await admitNativeSession(sessions, controller, root);
      const created = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: { kind: 'create-file', path: 'scripts/issue-511.lua', fileKind: 'lua' },
      });
      expect(created.success, created.error).toBe(true);
      expect(created.nativeWorkingRevision).toBeDefined();
      expect(await readFile(path.join(root, 'scripts/issue-511.lua'), 'utf8')).toBe(
        '-- NovelTea Lua source\n',
      );
      const moved = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: {
          kind: 'move',
          fromPath: 'scripts/issue-511.lua',
          toPath: 'scripts/issue-511-moved.lua',
        },
      });
      expect(moved.success, moved.error).toBe(true);
      expect(await readFile(path.join(root, 'scripts/issue-511-moved.lua'), 'utf8')).toBe(
        '-- NovelTea Lua source\n',
      );
      await expect(
        controller.mutateProjectSources({
          projectSessionId: id,
          operation: { kind: 'delete', path: 'scripts/issue-511-moved.lua' },
          expectedRevisions: {
            'scripts/issue-511-moved.lua': `sha256:${'0'.repeat(64)}`,
          },
        }),
      ).rejects.toThrow('WORKSPACE_REVISION_CONFLICT');
      const removed = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: { kind: 'delete', path: 'scripts/issue-511-moved.lua' },
      });
      expect(removed.success, removed.error).toBe(true);
      const folder = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: { kind: 'create-folder', path: 'scripts/issue-511-empty' },
      });
      expect(folder.success, folder.error).toBe(true);
      const nestedFile = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: {
          kind: 'create-file',
          path: 'scripts/issue-511-empty/helper.lua',
          fileKind: 'lua',
        },
      });
      expect(nestedFile.success, nestedFile.error).toBe(true);
      const folderMoved = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: {
          kind: 'move',
          fromPath: 'scripts/issue-511-empty',
          toPath: 'scripts/issue-511-relocated',
        },
      });
      expect(folderMoved.success, folderMoved.error).toBe(true);
      await expect(readdir(path.join(root, 'scripts', 'issue-511-empty'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        await readFile(path.join(root, 'scripts', 'issue-511-relocated', 'helper.lua'), 'utf8'),
      ).toBe('-- NovelTea Lua source\n');
      const shader = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: {
          kind: 'material-shader-copy',
          materialId: 'lab-grade',
          stage: 'fragment',
          sourceIdentity: 'project:/shaders/lab-grade.fs.sc',
        },
      });
      expect(shader.success, shader.error).toBe(true);
      expect(shader.createdSourceIds).toEqual(['shaders/materials/lab-grade/fs.sc']);
      expect((await controller.currentWorkingProject(id)).materials['lab-grade']).toMatchObject({
        data: {
          shader: { fragment: { kind: 'project', path: 'shaders/materials/lab-grade/fs.sc' } },
        },
      });
      expect(await readFile(path.join(root, 'shaders/materials/lab-grade/fs.sc'), 'utf8')).toBe(
        await readFile(path.join(root, 'shaders/lab-grade.fs.sc'), 'utf8'),
      );
      expect(await controller.sourceUsages(id, 'shaders/materials/lab-grade/fs.sc')).toMatchObject({
        usages: [expect.objectContaining({ owner: 'materials/lab-grade' })],
      });
      const attachment = await controller.mutateProjectSources({
        projectSessionId: id,
        operation: {
          kind: 'move-attachment',
          fromPath: 'support/issue-511-license.txt',
          toPath: 'assets/issue-511-license.txt',
        },
      });
      expect(attachment.success, attachment.error).toBe(true);
      expect((await controller.currentWorkingProject(id)).assets['counter-template']).toMatchObject(
        {
          data: {
            attachments: [{ path: 'assets/issue-511-license.txt', purpose: 'reference' }],
          },
        },
      );
      expect(await readFile(path.join(root, 'assets', 'issue-511-license.txt'), 'utf8')).toBe(
        'Native license\n',
      );
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('admits the exact Feature Lab saved Project and revokes it on close', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'native-editor-lifecycle-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), fixture, {
      recursive: true,
    });
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
      const { id, admitted } = await admitNativeSession(sessions, controller, fixture);
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
          ...admitted.savedProject,
          project: { ...admitted.savedProject.project, name: 'Unsaved Native Name' },
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
      await expect(controller.admitFromNative('stale-id')).rejects.toThrow('stale');
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 120_000);

  it('restores real acknowledged native patches after main-controller and worker replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-restart-'));
    const source = path.resolve(process.cwd(), '../tests/projects/feature-lab');
    await cp(source, root, { recursive: true });
    const sessions = new ActiveProjectSessionService();
    const makeController = () => {
      const bridge = new NativeAuthoringSessionBridge(sessions, {
        addonPath: nativeAddon!,
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
      const { id: first } = await admitNativeSession(sessions, controller, root);
      const patched = await controller.applyRevisionedPatches(first, 0, [
        { op: 'replace', path: '/project/name', value: 'Recovered across restart' },
      ]);
      expect(patched.accepted).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toContain(
        'Recovered across restart',
      );
      controller.dispose();
      sessions.closeActiveProject();
      controller = makeController();
      const { admitted } = await admitNativeSession(sessions, controller, root);
      expect(admitted.revision).toBeGreaterThan(0);
      expect(controller.recoveredContentProject()?.project.name).toBe('Recovered across restart');
      expect(controller.isAdmitted(first)).toBe(false);
      const failed = await controller
        .applyRevisionedPatches(first, 1, [
          { op: 'replace', path: '/project/name', value: 'Stale Project' },
        ])
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      // No replay may persist dirty content without an explicit Save.
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toContain(
        'Recovered across restart',
      );
    } finally {
      controller.dispose();
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
