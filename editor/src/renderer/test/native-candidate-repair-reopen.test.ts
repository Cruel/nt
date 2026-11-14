import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { ProjectCandidateRepairService } from '../../main/services/project-candidate-repair-service';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { guardNativeEditorProjectAuthority } from '../../shared/project-workspace/legacy-project-authority-guard';

describe.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
  'native pre-admission candidate repair handoff',
  () => {
    it('retains incumbent admission, repairs original malformed bytes and reopens normally', async () => {
      const releaseGuard = guardNativeEditorProjectAuthority();
      const roots = await Promise.all(
        Array.from({ length: 2 }, () =>
          mkdtemp(path.join(tmpdir(), 'nt-native-candidate-repair-')),
        ),
      );
      const sessions = new ActiveProjectSessionService();
      const handoff = new NativeEditorProjectHandoff(sessions, () => {
        const bridge = new NativeAuthoringSessionBridge(sessions, {
          addonPath: process.env.NOVELTEA_AUTHORING_NODE_ADDON!,
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
      });
      try {
        for (const root of roots) {
          await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
            recursive: true,
            filter: (source) => !source.split(path.sep).includes('.noveltea'),
          });
          const manifest = path.join(root, 'project.yaml');
          const original = await readFile(manifest, 'utf8');
          await writeFile(
            manifest,
            original.replace(
              /entrypoint:\n(?:  [^\n]*\n)+/u,
              'entrypoint:\n  kind: room\n  id: feature-lab-home\n',
            ),
          );
        }
        const incumbent = await handoff.open(roots[0]!);
        expect(incumbent.success).toBe(true);
        const sessionId = sessions.currentSessionId();
        const manifest = path.join(roots[1]!, 'project.yaml');
        const original = await readFile(manifest, 'utf8');
        const damaged = original.replace(
          'schema: noveltea.project.workspace',
          'schema: noveltea.project.workspace\ninvalid: [',
        );
        await writeFile(manifest, damaged);
        const otherSource = path.join(roots[1]!, 'editor.yaml');
        const otherBytes = await readFile(otherSource);
        const failed = await handoff.open(roots[1]!);
        expect(failed.success).toBe(false);
        expect(sessions.currentSessionId()).toBe(sessionId);
        const repairs = new ProjectCandidateRepairService();
        const candidate = await repairs.registerFailedOpen(roots[1]!);
        expect(candidate?.recognition).toBe('strong');
        const source = await repairs.read(candidate!.id);
        expect(source.text).toBe(damaged);
        expect((await repairs.save(candidate!.id, source.revision, original)).text).toBe(original);
        expect(await readFile(otherSource)).toEqual(otherBytes);
        const reopened = await handoff.open(roots[1]!);
        expect(reopened.success).toBe(true);
        expect(sessions.currentSessionId()).not.toBe(sessionId);
        await repairs.revokeRoot(roots[1]!);
        await expect(repairs.read(candidate!.id)).rejects.toThrow(/expired/u);
      } finally {
        await handoff.close();
        sessions.dispose();
        releaseGuard();
        // The native worker can be finishing its cache write as the handoff
        // shuts down. Retry transient ENOTEMPTY rather than treating a test
        // fixture teardown race as an authoring failure.
        await Promise.all(
          roots.map((root) =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
          ),
        );
      }
    }, 120_000);
  },
);
