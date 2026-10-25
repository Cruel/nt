import { describe, expect, it } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeEditorProject } from '../../main/services/native-editor-project-create';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { importNativeDesktopProject } from '../../main/services/native-desktop-project-import-service';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';

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
  it('treats desktop import identity and errors as native-only transaction results', async () => {
    const destination = path.resolve(tmpdir(), 'native-editor-import-contract');
    const request = {
      request: {
        source: { kind: 'local' as const, bundlePath: '/source/portable.ntproject' },
        suggestedName: 'Original',
      },
      destination,
      projectName: 'Confirmed Import',
    };
    const imported = await importNativeDesktopProject(request, async (op, body) => {
      expect(op).toBe('native-project-import');
      expect(body).toEqual({
        bundlePath: '/source/portable.ntproject',
        destination,
        projectName: 'Confirmed Import',
      });
      return {
        ok: true,
        projectRoot: destination,
        projectFilePath: path.join(destination, 'project.yaml'),
      };
    });
    expect(imported).toMatchObject({ success: true, projectPath: destination });
    const refused = await importNativeDesktopProject(request, async () => ({
      ok: false,
      kind: 'invalid-bundle',
      error: 'Archive manifest hash mismatch',
    }));
    expect(refused).toMatchObject({ success: false, error: 'Archive manifest hash mismatch' });
    const forged = await importNativeDesktopProject(request, async () => ({
      ok: true,
      projectRoot: path.join(tmpdir(), 'wrong-import-root'),
      projectFilePath: path.join(destination, 'project.yaml'),
    }));
    expect(forged).toMatchObject({ success: false });
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
        expect('requireActiveWorkspace' in sessions).toBe(false);
      } finally {
        handoff.close();
        sessions.dispose();
        await rm(parent, { recursive: true, force: true });
      }
    }, 120_000);

    it('imports a portable bundle with the confirmed name and opens it natively without a fallback', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'native-editor-import-'));
      const createdRoot = path.join(root, 'original');
      const destination = path.join(root, 'imported');
      const bundlePath = path.join(root, 'story.ntproject');
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
          projectName: 'Original Story',
          projectDirectory: createdRoot,
        });
        expect(created.success, created.error).toBe(true);
        // Export uses the existing public CLI fixture transport. The import
        // itself must go through the isolated native-editor candidate operation.
        const exported = JSON.parse(
          execFileSync(
            resolveNovelTeaCliPath(),
            [
              '--no-daemon',
              '--json',
              '--project',
              createdRoot,
              'project',
              'export',
              '--output',
              bundlePath,
            ],
            { encoding: 'utf8', timeout: 45_000 },
          ),
        ) as { success: boolean };
        expect(exported.success).toBe(true);
        const input = {
          request: {
            source: { kind: 'local' as const, bundlePath },
            suggestedName: 'Original Story',
          },
          projectName: 'Imported & Renamed Story',
          destination,
        };
        const imported = await importNativeDesktopProject(input);
        expect(imported.success, imported.error).toBe(true);
        const manifest = await readFile(path.join(destination, 'project.yaml'), 'utf8');
        expect(manifest).toContain('Imported & Renamed Story');
        expect(manifest).toContain('original-story');
        const opened = await handoff.open(destination);
        expect(opened.success, opened.error).toBe(true);
        expect(sessions.currentProjectIdentity()).toEqual({
          id: 'original-story',
          name: 'Imported & Renamed Story',
        });
        expect('requireActiveWorkspace' in sessions).toBe(false);
        expect((await importNativeDesktopProject(input)).success).toBe(false);
        expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).toBe(manifest);
      } finally {
        handoff.close();
        sessions.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
