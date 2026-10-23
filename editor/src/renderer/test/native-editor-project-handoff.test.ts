import { describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';

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
});
