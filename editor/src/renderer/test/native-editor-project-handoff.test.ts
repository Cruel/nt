import { describe, expect, it, vi } from 'vite-plus/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeEditorObserverWatchService } from '../../main/services/native-editor-observer-watch-service';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-watch-events';

async function projectRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-project-handoff-'));
  await writeFile(path.join(root, 'project.yaml'), 'schema: test\n');
  return root;
}

function controller(identity: string) {
  const savedProject = createAuthoringProject({ id: identity, name: identity });
  return {
    admitFromNative: vi.fn(async () => ({
      revision: 0,
      savedProject,
      sourceRevisions: {},
      diagnostics: [],
    })),
    recoveredContentProject: vi.fn(() => null),
    recoveredConflicts: vi.fn(() => ({})),
    recoveredTextSources: vi.fn(() => ({})),
    close: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('native-only Project handoff keeps independent workers', () => {
  it('preserves the incumbent worker and Project when the candidate is invalid', async () => {
    const roots = [await projectRoot(), await projectRoot()];
    const sessions = new ActiveProjectSessionService();
    const first = controller('original');
    const rejected = controller('rejected');
    rejected.admitFromNative.mockRejectedValueOnce(new Error('bad native source'));
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(rejected);
    const handoff = new NativeEditorProjectHandoff(sessions, factory);
    try {
      expect((await handoff.open(roots[0]!)).success).toBe(true);
      const incumbent = sessions.currentSessionId();
      const next = await handoff.open(roots[1]!);
      expect(next.success).toBe(false);
      expect(next.error).toContain('bad native source');
      expect(sessions.currentSessionId()).toBe(incumbent);
      expect(handoff.current()).toBe(first);
      expect(first.close).not.toHaveBeenCalled();
      expect(first.dispose).not.toHaveBeenCalled();
      expect(rejected.close).toHaveBeenCalledOnce();
      expect(rejected.dispose).toHaveBeenCalledOnce();
    } finally {
      handoff.close();
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it('promotes the new worker before disposing the incumbent on successful handoff', async () => {
    const roots = [await projectRoot(), await projectRoot()];
    const sessions = new ActiveProjectSessionService();
    const first = controller('original');
    const next = controller('next');
    const handoff = new NativeEditorProjectHandoff(
      sessions,
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next),
    );
    try {
      const incumbent = await handoff.open(roots[0]!);
      expect(incumbent.success).toBe(true);
      const switched = await handoff.open(roots[1]!);
      expect(switched.success).toBe(true);
      expect(switched.projectSessionId).not.toBe(incumbent.projectSessionId);
      expect(sessions.currentProjectIdentity()?.id).toBe('next');
      expect(handoff.current()).toBe(next);
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(next.dispose).not.toHaveBeenCalled();
      expect(sessions.isCurrent(incumbent.projectSessionId!)).toBe(false);
    } finally {
      handoff.close();
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it('cannot allow a superseded native candidate to replace a newer Project', async () => {
    const roots = [await projectRoot(), await projectRoot(), await projectRoot()];
    const sessions = new ActiveProjectSessionService();
    const first = controller('original');
    const stale = controller('stale');
    const last = controller('last');
    let release!: (value: Awaited<ReturnType<typeof stale.admitFromNative>>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    stale.admitFromNative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          markStarted();
        }),
    );
    const handoff = new NativeEditorProjectHandoff(
      sessions,
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(stale).mockReturnValueOnce(last),
    );
    try {
      await handoff.open(roots[0]!);
      const openingStale = handoff.open(roots[1]!);
      await started;
      expect(handoff.current()).toBe(first);
      expect(first.dispose).not.toHaveBeenCalled();
      const openedLast = await handoff.open(roots[2]!);
      expect(openedLast.success).toBe(true);
      release({
        revision: 0,
        savedProject: createAuthoringProject({ id: 'stale', name: 'stale' }),
        sourceRevisions: {},
        diagnostics: [],
      });
      const staleResult = await openingStale;
      expect(staleResult.success).toBe(false);
      expect(handoff.current()).toBe(last);
      expect(sessions.currentSessionId()).toBe(openedLast.projectSessionId);
      expect(stale.dispose).toHaveBeenCalledOnce();
    } finally {
      handoff.close();
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it('reopens the same root through a fresh worker without discarding the incumbent', async () => {
    const root = await projectRoot();
    const sessions = new ActiveProjectSessionService();
    const first = controller('original');
    const second = controller('original');
    const handoff = new NativeEditorProjectHandoff(
      sessions,
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    );
    try {
      const opened = await handoff.open(root);
      expect(opened.success).toBe(true);
      second.admitFromNative.mockImplementationOnce(async () => {
        expect(handoff.current()).toBe(first);
        expect(sessions.currentSessionId()).toBe(opened.projectSessionId);
        return {
          revision: 1,
          savedProject: createAuthoringProject({ id: 'original', name: 'original' }),
          sourceRevisions: {},
          diagnostics: [],
        };
      });
      const reopened = await handoff.open(root);
      expect(reopened.success, reopened.error).toBe(true);
      expect(reopened.projectSessionId).not.toBe(opened.projectSessionId);
      expect(first.dispose).toHaveBeenCalledOnce();
    } finally {
      handoff.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const nativeAddon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
describe.skipIf(!nativeAddon)('native editor lifecycle with real addon workers', () => {
  it('keeps acknowledged dirty edits across rejected Open and same-root handoff, with native observation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-handoff-real-'));
    const invalid = await mkdtemp(path.join(tmpdir(), 'native-handoff-invalid-'));
    await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
      recursive: true,
    });
    await writeFile(path.join(invalid, 'project.yaml'), 'invalid: [');
    const sessions = new ActiveProjectSessionService();
    const observers = new Map<NativeEditorSessionController, NativeEditorObserverWatchService>();
    const events: ProjectWorkspaceWatchEvent[] = [];
    const handoff = new NativeEditorProjectHandoff(sessions, () => {
      const bridge = new NativeAuthoringSessionBridge(sessions, {
        addonPath: path.resolve(nativeAddon!),
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
      observers.set(
        controller,
        new NativeEditorObserverWatchService(bridge, sessions, (event) => events.push(event)),
      );
      return controller;
    });
    try {
      const opened = await handoff.open(root);
      expect(opened.success, opened.error).toBe(true);
      const first = handoff.current()!;
      const firstId = opened.projectSessionId!;
      expect(() => sessions.requireActiveWorkspace(firstId)).toThrow('no workspace');
      expect((await sessions.listProjectSourceFiles({ projectSessionId: firstId })).files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'layouts/feature-lab-hud/layout.rml',
            kind: 'layout-rml',
          }),
        ]),
      );
      const patched = await first.applyRevisionedPatches(firstId, opened.nativeWorkingRevision!, [
        { op: 'replace', path: '/project/name', value: 'Native unsaved handoff' },
      ]);
      expect(patched.accepted).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).not.toContain(
        'Native unsaved handoff',
      );
      const refused = await handoff.open(invalid);
      expect(refused.success).toBe(false);
      expect(handoff.current()).toBe(first);
      expect(first.isAdmitted(firstId)).toBe(true);
      const reopened = await handoff.open(root);
      expect(reopened.success, reopened.error).toBe(true);
      expect(reopened.nativeRecoveredContentProject).toMatchObject({
        project: { name: 'Native unsaved handoff' },
      });
      expect(handoff.current()).not.toBe(first);
      expect(first.isAdmitted(firstId)).toBe(false);
      const newId = reopened.projectSessionId!;
      const current = handoff.current()!;
      await expect(current.prepareCleanExport(newId)).rejects.toThrow('Save or resolve');
      const saved = await current.saveUnit(newId, reopened.nativeWorkingRevision!, [], {
        structuralPathsByOwner: { project: ['/project/name'] },
        comments: 'keep',
      });
      expect(saved.accepted, saved.error).toBe(true);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toContain(
        'Native unsaved handoff',
      );
      expect((await current.prepareCleanExport(newId)).project.name).toBe('Native unsaved handoff');
      observers.get(current)!.start(newId);
      const sourcePath = path.join(root, 'records/rooms/room-lifecycle-roundtrip.yaml');
      await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\n# observed externally\n`);
      await vi.waitFor(
        () =>
          expect(
            events.some((event) =>
              event.authoringChangedPaths.includes('records/rooms/room-lifecycle-roundtrip.yaml'),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      expect((await current.currentWorkingProject(newId)).project.name).toBe(
        'Native unsaved handoff',
      );
    } finally {
      for (const observer of observers.values()) observer.close();
      handoff.close();
      sessions.dispose();
      await Promise.all(
        [root, invalid].map((value) => rm(value, { recursive: true, force: true })),
      );
    }
  }, 120_000);
});
