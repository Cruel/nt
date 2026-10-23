import { describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { openNativeEditorProject } from '../../main/services/native-editor-project-open';

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-open-contract-'));
  await writeFile(path.join(root, 'project.yaml'), 'schema: native-test\n');
  return root;
}

function nativeStub() {
  const savedProject = createAuthoringProject({ id: 'native-source', name: 'Native Source' });
  return {
    savedProject,
    admitFromNative: vi.fn(async (_projectSessionId: string) => ({
      savedProject,
      revision: 2,
      diagnostics: [],
      sourceRevisions: {},
    })),
    recoveredContentProject: vi.fn(() => null),
    recoveredConflicts: vi.fn(() => ({})),
    recoveredTextSources: vi.fn(() => ({})),
    close: vi.fn(),
  };
}

describe('native-only editor Open lifecycle', () => {
  it('preserves the previous session on an attempted unverified Project handoff', async () => {
    const original = await workspace();
    const candidate = await workspace();
    const sessions = new ActiveProjectSessionService();
    const native = nativeStub();
    native.admitFromNative.mockRejectedValueOnce(new Error('Native candidate verification failed'));
    try {
      const originalId = await sessions.activateProjectFile(path.join(original, 'project.yaml'));
      const attempted = await openNativeEditorProject(
        candidate,
        sessions.beginProjectActivation(),
        sessions,
        native,
      );
      expect(attempted.success).toBe(false);
      expect(attempted.error).toMatch(/candidate verification failed/);
      expect(sessions.currentSessionId()).toBe(originalId);
      expect(native.admitFromNative).toHaveBeenCalledOnce();
      expect(native.close).toHaveBeenCalledOnce();
    } finally {
      sessions.dispose();
      await Promise.all(
        [original, candidate].map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  });

  it('keeps the incumbent visible through native admission and promotes only after verification', async () => {
    const original = await workspace();
    const candidate = await workspace();
    const sessions = new ActiveProjectSessionService();
    const native = nativeStub();
    try {
      const originalId = await sessions.activateProjectFile(path.join(original, 'project.yaml'));
      native.admitFromNative.mockImplementationOnce(async (id) => {
        expect(sessions.currentSessionId()).toBe(originalId);
        expect(sessions.isCurrent(originalId)).toBe(true);
        expect(sessions.isCurrent(id)).toBe(true);
        expect(sessions.requireActiveProjectRoot(id)).toBe(candidate);
        return {
          savedProject: native.savedProject,
          revision: 2,
          diagnostics: [],
          sourceRevisions: {},
        };
      });
      const opened = await openNativeEditorProject(
        candidate,
        sessions.beginProjectActivation(),
        sessions,
        native,
      );
      expect(opened.success).toBe(true);
      expect(opened.projectSessionId).not.toBe(originalId);
      expect(sessions.currentSessionId()).toBe(opened.projectSessionId);
      expect(sessions.isCurrent(originalId)).toBe(false);
      expect(native.close).not.toHaveBeenCalled();
    } finally {
      sessions.dispose();
      await Promise.all(
        [original, candidate].map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  });

  it('rejects native Project admission without retrying the TypeScript reader', async () => {
    const root = await workspace();
    const sessions = new ActiveProjectSessionService();
    const native = nativeStub();
    native.admitFromNative.mockRejectedValueOnce(new Error('Native Project admission rejected'));
    try {
      const response = await openNativeEditorProject(
        root,
        sessions.beginProjectActivation(),
        sessions,
        native,
      );
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/Native Project admission rejected/);
      expect(native.admitFromNative).toHaveBeenCalledOnce();
      expect(sessions.currentSessionId()).toBeNull();
      expect(native.close).toHaveBeenCalledOnce();
    } finally {
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes only native Project content and an admitted identity with no TS workspace', async () => {
    const root = await workspace();
    const sessions = new ActiveProjectSessionService();
    const native = nativeStub();
    try {
      const response = await openNativeEditorProject(
        root,
        sessions.beginProjectActivation(),
        sessions,
        native,
      );
      expect(response.success).toBe(true);
      expect(response.contentProject).toEqual(native.savedProject);
      expect(response.nativeWorkingRevision).toBe(2);
      expect(response.editorState?.chapters).toEqual(native.savedProject.editor.chapters);
      expect(sessions.currentProjectIdentity()).toEqual({
        id: 'native-source',
        name: 'Native Source',
      });
      expect(() => sessions.requireActiveWorkspace(response.projectSessionId!)).toThrow(
        'no workspace',
      );
    } finally {
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves corrupt local recovery and revokes native session without fallback', async () => {
    const root = await workspace();
    const sessions = new ActiveProjectSessionService();
    const native = nativeStub();
    try {
      const dirname = path.join(root, '.noveltea', 'editor');
      await mkdir(dirname, { recursive: true });
      const filename = path.join(dirname, 'state.json');
      await writeFile(filename, '{bad json');
      const result = await openNativeEditorProject(
        path.join(root, 'project.yaml'),
        sessions.beginProjectActivation(),
        sessions,
        native,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cannot be recovered/);
      expect(sessions.currentSessionId()).toBeNull();
      expect(native.close).toHaveBeenCalledOnce();
      expect(await readFile(filename, 'utf8')).toBe('{bad json');
    } finally {
      sessions.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
