import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import { describe, it, expect } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { createNativeEditorProject } from '../../main/services/native-editor-project-create';
import { exportPackage } from '../../main/services/native-runtime-tool-service';
import {
  exportNativeEditorPackage,
  prepareNativeEditorExportAssessment,
} from '../../main/services/native-editor-export-service';

describe.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
  'production native Test and runtime package on runnable starter',
  () => {
    it('builds and runs a valid authored Test with no legacy Workspace or material fallback', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'native-editor-smoke-'));
      const root = path.join(parent, 'starter');
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
          projectName: 'Native Run',
          projectDirectory: root,
        });
        expect(created.success, created.error).toBe(true);
        const manifestPath = path.join(root, 'project.yaml');
        const manifest = parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        manifest.entrypoint = { kind: 'room', id: 'native-room' };
        await writeFile(manifestPath, stringify(manifest));
        await mkdir(path.join(root, 'records/rooms'), { recursive: true });
        await writeFile(
          path.join(root, 'records/rooms/native-room.yaml'),
          stringify({
            id: 'native-room',
            label: 'Native Room',
            data: {
              displayName: 'Native Room',
              background: { asset: null },
              presentationSpace: {
                size: { width: 1920, height: 1080 },
                defaultView: { center: { x: 960, y: 540 } },
              },
            },
          }).replace(/^(\s*)y:/gmu, '$1"y":'),
        );
        await mkdir(path.join(root, 'records/tests'), { recursive: true });
        await writeFile(
          path.join(root, 'records/tests/native-smoke.yaml'),
          stringify({
            id: 'native-smoke',
            label: 'Native Smoke',
            data: {
              displayName: 'Native Smoke',
              steps: [{ id: 'start', input: 'tick', label: 'Start' }],
            },
          }),
        );
        const opened = await handoff.open(root);
        const diagnostics = opened.success
          ? ''
          : spawnSync(
              resolveNovelTeaCliPath(),
              ['--no-daemon', '--json', '--project', root, 'validate'],
              { encoding: 'utf8' },
            ).stdout;
        expect(opened.success, `${JSON.stringify(opened)}; validate: ${diagnostics}`).toBe(true);
        const id = opened.projectSessionId!;
        expect('requireActiveWorkspace' in sessions).toBe(false);
        const native = handoff.current()!;
        const prepared = await native.prepareRuntime(id, opened.nativeWorkingRevision!, 'glsl-330');
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 'prepared' });
        if (prepared.status !== 'prepared') return;
        // Compare native working preparation with the *same native-admitted*
        // clean export path and a reference-independent runtime expectation.
        expect(prepared.artifact.manifestPreview.projectName).toBe('Native Run');
        expect(prepared.artifact.compiledProject.definitions.rooms).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'native-room' })]),
        );
        const previewBundle = path.join(parent, 'native-preview.ntpkg');
        const previewPublished = await exportPackage(
          prepared.artifact.compiledProject,
          previewBundle,
          prepared.artifact.packageOptions,
        );
        expect(previewPublished).toMatchObject({ success: true });
        const report = await native.runTest(id, opened.nativeWorkingRevision!, 'native-smoke');
        expect(report, JSON.stringify(report)).toMatchObject({
          ok: true,
          report: { id: 'native-smoke', passed: true },
        });
        expect((await native.prepareCleanExport(id)).project.id).toBe('native-run');
        const nativePreflight = await prepareNativeEditorExportAssessment(
          native,
          id,
          opened.nativeWorkingRevision!,
          root,
          'runtime',
        );
        expect(nativePreflight.status).toBe('prepared');
        const nativePackagePath = path.join(parent, 'native-editor-export.ntpkg');
        const nativePackage = await exportNativeEditorPackage(
          native,
          id,
          root,
          nativePackagePath,
          {
            publish: exportPackage,
          },
          opened.nativeWorkingRevision!,
        );
        expect(nativePackage).toMatchObject({ success: true });
        expect((await readFile(nativePackagePath)).length).toBeGreaterThan(0);
        expect(await readFile(nativePackagePath)).toEqual(await readFile(previewBundle));

        // Native editor admission must use acknowledged dirty content for
        // Preview/Tests without silently falling back to the saved manifest.
        const dirty = await native.applyRevisionedPatches(id, opened.nativeWorkingRevision!, [
          { op: 'replace', path: '/project/name', value: 'Unsaved Native Preview' },
        ]);
        expect(dirty.accepted, dirty.error).toBe(true);
        const dirtyRevision = dirty.snapshot.workingRevision;
        const dirtyPreview = await native.prepareRuntime(id, dirtyRevision, 'glsl-330');
        expect(dirtyPreview.status).toBe('prepared');
        if (dirtyPreview.status === 'prepared')
          expect(dirtyPreview.artifact.manifestPreview.projectName).toBe('Unsaved Native Preview');
        expect(await readFile(manifestPath, 'utf8')).not.toContain('Unsaved Native Preview');
        expect(await native.runTest(id, dirtyRevision, 'native-smoke')).toMatchObject({
          ok: true,
          report: { id: 'native-smoke', passed: true },
        });
        await expect(native.prepareCleanExportAdmission(id)).rejects.toThrow(/Save or resolve/);
        await expect(
          native.prepareRuntime(id, opened.nativeWorkingRevision!, 'glsl-330'),
        ).rejects.toThrow(/Stale native runtime preparation revision/);

        // Out-of-band CLI/source writes must either invalidate admission or
        // reprepare from the new physical source, never return stale Play data.
        const roomPath = path.join(root, 'records/rooms/native-room.yaml');
        const roomSource = await readFile(roomPath, 'utf8');
        expect(roomSource).toContain('width: 1920');
        await writeFile(roomPath, roomSource.replace('width: 1920', 'width: 1600'));
        const externalEdit = await native.prepareRuntime(id, dirtyRevision, 'glsl-330');
        if (externalEdit.status === 'prepared') {
          expect(
            externalEdit.artifact.compiledProject.definitions.rooms[0]?.presentationSpace.size
              .width,
          ).toBe(1600);
        } else {
          expect(externalEdit.status).toBe('blocked');
        }
      } finally {
        handoff.close();
        sessions.dispose();
        await rm(parent, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
