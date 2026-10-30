import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { guardNativeEditorProjectAuthority } from '../../shared/project-workspace/legacy-project-authority-guard';
import {
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  nativeProjectPatchArgumentsSchema,
  nativeProjectPrepareRuntimeArgumentsSchema,
  nativeProjectRunTestArgumentsSchema,
  nativeProjectSaveUnitArgumentsSchema,
  nativeProjectValidateArgumentsSchema,
  noArgumentsSchema,
  openProjectArgumentsSchema,
  type EditorIpcEvent,
  type EditorIpcMain,
  type EditorWebContents,
  type EditorWindow,
} from '../../main/editor-ipc-trust-boundary';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeEditorProjectHandoff } from '../../main/services/native-editor-project-handoff';
import { nativeSemanticGraphSchema } from '../../main/services/native-authoring-worker-contract';
import { projectNativeGraphForRenderer } from '../project/native-authoring-graph-projection';
import {
  preflightGraphCommand,
  semanticUsagesForTarget,
} from '../project/authoring-graph-consumers';
import { generateAuthoringRepairPlan, recordTarget } from '../project/authoring-repair';

class InProcessIpc implements EditorIpcMain {
  readonly handlers = new Map<string, (event: EditorIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, handler: (event: EditorIpcEvent, ...args: unknown[]) => unknown) {
    this.handlers.set(channel, handler);
  }
  invoke(channel: string, event: EditorIpcEvent, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing renderer-to-main IPC route: ${channel}`);
    return handler(event, ...args);
  }
}

describe.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
  'real native Editor candidate through authenticated renderer/main IPC',
  () => {
    it('authenticates Open, revisions, Save, validation, same-root reopen and Close', async () => {
      const releaseNativeAuthorityGuard = guardNativeEditorProjectAuthority();
      const root = await mkdtemp(path.join(tmpdir(), 'native-editor-ipc-'));
      await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
        recursive: true,
        filter: (source) => !source.split(path.sep).includes('.noveltea'),
      });
      const manifest = path.join(root, 'project.yaml');
      await writeFile(
        manifest,
        (await readFile(manifest, 'utf8')).replace(
          /entrypoint:\n(?:  [^\n]*\n)+/u,
          'entrypoint:\n  kind: room\n  id: feature-lab-home\n',
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
      const url = 'noveltea-editor://app/index.html';
      const mainFrame = { detached: false, url };
      const webContents: EditorWebContents = {
        mainFrame,
        isDestroyed: () => false,
      };
      const owner: EditorWindow = { webContents, isDestroyed: () => false };
      const trusted: EditorIpcEvent = { sender: webContents, senderFrame: mainFrame };
      const untrusted: EditorIpcEvent = {
        sender: { ...webContents },
        senderFrame: mainFrame,
      };
      const ipc = new InProcessIpc();
      const registrar = createGuardedIpcRegistrar({
        ipcMain: ipc,
        getOwner: () => owner,
        documentPolicy: createEditorDocumentPolicy(),
      });
      registrar.handle(
        IPC_CHANNELS.OPEN_PROJECT,
        (args) => openProjectArgumentsSchema.parse(args),
        (directory) => handoff.open(directory),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_PATCH,
        (args) => nativeProjectPatchArgumentsSchema.parse(args),
        (id, revision, patches, copies?: Record<string, string>) =>
          handoff.current()!.applyRevisionedPatches(id, revision, patches, copies),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_SAVE_UNIT,
        (args) => nativeProjectSaveUnitArgumentsSchema.parse(args),
        (id, revision, saveUnitIds, options) =>
          handoff.current()!.saveUnit(id, revision, saveUnitIds, options),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_VALIDATE,
        (args) => nativeProjectValidateArgumentsSchema.parse(args),
        (id, revision) => handoff.current()!.validate(id, revision),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH,
        (args) => nativeProjectValidateArgumentsSchema.parse(args),
        (id, revision) => handoff.current()!.semanticGraph(id, revision),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_PREPARE_RUNTIME,
        (args) => nativeProjectPrepareRuntimeArgumentsSchema.parse(args),
        (id, revision, shaderVariant) =>
          handoff.current()!.prepareRuntime(id, revision, shaderVariant),
      );
      registrar.handle(
        IPC_CHANNELS.NATIVE_PROJECT_RUN_TEST,
        (args) => nativeProjectRunTestArgumentsSchema.parse(args),
        (id, revision, testId) => handoff.current()!.runTest(id, revision, testId),
      );
      registrar.handle(
        IPC_CHANNELS.CLOSE_ACTIVE_PROJECT,
        (args) => noArgumentsSchema.parse(args),
        () => {
          handoff.close();
        },
      );
      try {
        await expect(ipc.invoke(IPC_CHANNELS.OPEN_PROJECT, untrusted, root)).rejects.toThrow();
        expect(sessions.currentSessionId()).toBeNull();
        await expect(ipc.invoke(IPC_CHANNELS.OPEN_PROJECT, trusted, root, root)).rejects.toThrow();
        expect(sessions.currentSessionId()).toBeNull();
        const first = await ipc.invoke(IPC_CHANNELS.OPEN_PROJECT, trusted, root);
        expect(first).toMatchObject({ success: true, nativeWorkingRevision: 0 });
        const id = (first as { projectSessionId: string }).projectSessionId;
        expect('requireActiveWorkspace' in sessions).toBe(false);
        await expect(
          ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_PATCH, trusted, id, 99, [
            { op: 'replace', path: '/project/name', value: 'Never admitted' },
          ]),
        ).rejects.toThrow();
        const patched = await ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_PATCH, trusted, id, 0, [
          { op: 'replace', path: '/project/name', value: 'IPC native edit' },
        ]);
        expect(patched).toMatchObject({ accepted: true, snapshot: { workingRevision: 1 } });
        const validated = await ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_VALIDATE, trusted, id, 1);
        expect(validated).toBeDefined();
        await expect(
          ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH, untrusted, id, 1),
        ).rejects.toThrow();
        await expect(
          ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH, trusted, id, 0),
        ).rejects.toThrow();
        const graph = await ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH, trusted, id, 1);
        expect(graph).toMatchObject({
          projectSessionId: id,
          workingRevision: 1,
          nodes: expect.any(Array),
          edges: expect.any(Array),
          occurrences: expect.any(Array),
        });
        // Exercise the actual renderer consumer seam using native addon bytes,
        // not a separately hand-authored TypeScript graph fixture.
        const nativeGraph = nativeSemanticGraphSchema.parse(graph);
        const roomBackground = nativeGraph.edges.find((edge) => edge.role === 'room-background');
        expect(roomBackground).toBeDefined();
        expect(roomBackground!.target.kind).toBe('record');
        const referencedAsset = recordTarget(
          'assets',
          roomBackground!.target.kind === 'record' ? roomBackground!.target.id : '',
        );
        expect(roomBackground?.repair).toEqual({
          kind: 'set-null',
          path: roomBackground?.sourcePath.replace(/\/\$ref$/u, ''),
        });
        const projected = projectNativeGraphForRenderer(nativeGraph, 'native-ipc-consumer', 1);
        expect(semanticUsagesForTarget(projected, referencedAsset)).toEqual(
          expect.arrayContaining([expect.objectContaining({ edgeId: roomBackground!.id })]),
        );
        expect(
          preflightGraphCommand({
            snapshot: projected,
            projectInstanceId: 'native-ipc-consumer',
            projectRevision: 1,
            target: referencedAsset,
            operation: 'delete',
          }),
        ).toMatchObject({ kind: 'blocked' });
        const isolated = projectNativeGraphForRenderer(
          {
            ...nativeGraph,
            edges: [roomBackground!],
            occurrences: [],
          },
          'native-ipc-consumer',
          1,
        );
        expect(
          generateAuthoringRepairPlan({
            snapshot: isolated,
            projectInstanceId: 'native-ipc-consumer',
            projectRevision: 1,
            target: referencedAsset,
            deletePath: roomBackground!.targetPath,
          }),
        ).toMatchObject({
          status: 'ready',
          plan: {
            patches: expect.arrayContaining([
              {
                op: 'replace',
                path: roomBackground!.repair.kind === 'set-null' ? roomBackground!.repair.path : '',
                value: null,
              },
            ]),
          },
        });
        const reopened = await ipc.invoke(IPC_CHANNELS.OPEN_PROJECT, trusted, root);
        expect(reopened).toMatchObject({
          success: true,
          nativeRecoveredContentProject: { project: { name: 'IPC native edit' } },
        });
        const reopenedId = (reopened as { projectSessionId: string }).projectSessionId;
        await expect(
          ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH, trusted, id, 1),
        ).rejects.toThrow();
        await expect(
          ipc.invoke(IPC_CHANNELS.NATIVE_PROJECT_SAVE_UNIT, trusted, id, 1, [], {
            structuralPathsByOwner: { project: ['/project/name'] },
          }),
        ).rejects.toThrow();
        const saved = await ipc.invoke(
          IPC_CHANNELS.NATIVE_PROJECT_SAVE_UNIT,
          trusted,
          reopenedId,
          (reopened as { nativeWorkingRevision: number }).nativeWorkingRevision,
          [],
          { structuralPathsByOwner: { project: ['/project/name'] }, comments: 'keep' },
        );
        expect(saved).toMatchObject({ accepted: true });
        const savedRevision = (saved as { snapshot: { workingRevision: number } }).snapshot
          .workingRevision;
        const nativePreview = await ipc.invoke(
          IPC_CHANNELS.NATIVE_PROJECT_PREPARE_RUNTIME,
          trusted,
          reopenedId,
          savedRevision,
          'glsl-330',
        );
        expect(nativePreview).toMatchObject({ status: 'prepared' });
        expect(nativePreview).toHaveProperty('artifact.compiledProject');
        const testReport = await ipc.invoke(
          IPC_CHANNELS.NATIVE_PROJECT_RUN_TEST,
          trusted,
          reopenedId,
          savedRevision,
          'active-text-flow',
        );
        // Feature Lab intentionally includes experimental video/material
        // references unsupported by the current runnable-player package.
        // A native runtime-admission diagnostic is a valid negative outcome;
        // silently succeeding through the old TypeScript Test route is not.
        if ((testReport as { ok: boolean }).ok === false) {
          expect(testReport).toMatchObject({
            compiledProjectAdmissionRejected: true,
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: 'runtime_package.missing_prepared_video_motion' }),
            ]),
          });
        } else {
          expect(testReport).toMatchObject({ ok: true, success: true });
        }
        expect((await handoff.current()!.prepareCleanExport(reopenedId)).project.name).toBe(
          'IPC native edit',
        );
        await expect(ipc.invoke(IPC_CHANNELS.CLOSE_ACTIVE_PROJECT, untrusted)).rejects.toThrow();
        await ipc.invoke(IPC_CHANNELS.CLOSE_ACTIVE_PROJECT, trusted);
        expect(sessions.currentSessionId()).toBeNull();
      } finally {
        handoff.close();
        sessions.dispose();
        releaseNativeAuthorityGuard();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
