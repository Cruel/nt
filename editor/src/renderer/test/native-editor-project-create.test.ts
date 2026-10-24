import { describe, expect, it } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeEditorProject } from '../../main/services/native-editor-project-create';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';

describe('native editor Project Create candidate', () => {
  it('uses only the native Project operation, returning its exact physical identity', async () => {
    const destination = path.resolve(tmpdir(), 'candidate-create-contract');
    const call = async (operation: string, request: unknown) => {
      expect(operation).toBe('native-project-create');
      expect(request).toEqual({
        projectRoot: destination,
        name: 'My Project',
      });
      return {
        ok: true,
        projectRoot: destination,
        projectFilePath: path.join(destination, 'project.yaml'),
        projectId: 'my-project',
      };
    };
    expect(
      await createNativeEditorProject(
        { projectName: 'My Project', projectDirectory: destination },
        call,
      ),
    ).toMatchObject({ success: true, projectPath: destination });
    const swappedIdentity = await createNativeEditorProject(
      { projectName: 'My Project', projectDirectory: destination },
      async () => ({
        ok: true,
        projectRoot: path.join(tmpdir(), 'substituted'),
        projectFilePath: path.join(destination, 'project.yaml'),
        projectId: 'my-project',
      }),
    );
    expect(swappedIdentity.success).toBe(false);
    expect(swappedIdentity.error).toContain('invalid destination');
  });
});

describe.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
  'native editor Project Create to Open with real native CLI and worker',
  () => {
    it('creates and admits the native starter without any TypeScript Workspace reader', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'native-editor-created-'));
      const projectRoot = path.join(parent, 'New Project');
      const sessions = new ActiveProjectSessionService();
      const handoff = new NativeEditorProjectHandoff(sessions, () => {
        const bridge = new NativeAuthoringSessionBridge(sessions, {
          addonPath: process.env.NOVELTEA_AUTHORING_NODE_ADDON!,
          workerScript: path.resolve(
            process.cwd(),
            'dist-electron/authoring-worker/native-authoring-worker.cjs',
          ),
        });
        return new NativeEditorSessionController(
          sessions,
          bridge,
          new NativeAuthoringWorkingProject(bridge),
        );
      });
      try {
        const created = await createNativeEditorProject({
          projectName: 'Created in Native',
          projectDirectory: projectRoot,
        });
        expect(created.success, created.error).toBe(true);
        expect(await readFile(path.join(projectRoot, 'project.yaml'), 'utf8')).toContain(
          'created-in-native',
        );
        const duplicate = await createNativeEditorProject({
          projectName: 'Duplicate',
          projectDirectory: projectRoot,
        });
        expect(duplicate.success).toBe(false);
        const admitted = await handoff.open(projectRoot);
        expect(admitted.success, admitted.error).toBe(true);
        expect(sessions.currentProjectIdentity()).toMatchObject({
          id: 'created-in-native',
          name: 'Created in Native',
        });
        expect(() => sessions.requireActiveWorkspace(admitted.projectSessionId!)).toThrow(
          'no workspace',
        );
      } finally {
        handoff.close();
        sessions.dispose();
        await rm(parent, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
