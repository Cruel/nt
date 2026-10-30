import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { yamlCommentImpacts } from '../../shared/project-workspace/yaml-comment-impact';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { canonicalProjectPersistenceContentJson } from '../../shared/project-schema/editor-project-state';
import { projectFromNativeCompletePreparation } from './native-authoring-runtime-preparation';
import type { NativeAuthoringSessionBridge } from './native-authoring-session-bridge';
import type { NativeAuthoringWorkingProject } from './native-authoring-working-project';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import {
  NativeWorkingRuntimePreparationCache,
  runNativeWorkingTest,
} from './native-authoring-runtime-preparation';
import { projectWithPreviewLocale, effectivePreviewLocale } from '../../shared/preview-locale';
import { PSEUDO_PREVIEW_LOCALE } from '../../shared/pseudo-localization';
import type { ShaderVariant } from '../../shared/shader-variants';
import type { EditorRuntimePreparationResult } from '../../shared/editor-runtime-cache';
import type { PlaybackReportResponse } from '../../shared/editor-tooling';
import { buildRuntimeTestCatalog } from '../../shared/runtime-test-catalog';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { NativeDirtyCheckpointStore } from './native-dirty-checkpoint-store';
import type { NativeDirtyCheckpoint } from './native-authoring-working-project';
import { NativeAssetStagingService } from './native-asset-staging-service';
import type { ProjectSourceStructuralRequest } from '../../shared/project-source-files';
import { planNativeProjectSourceTransaction } from './native-project-source-transactions';
import { projectSourceUsages } from './project-source-usage-reader';
import { diffJsonDocuments } from '../../renderer/project/project-external-reconciliation';
import type { JsonValue } from '../../renderer/project/json-value';
import { nativeAssetContentHashes, verifyNativeSourceBytes } from './native-authoring-source-proof';
import { classifyProjectValidationDiagnostics } from '../../shared/project-schema/project-diagnostic-projection';

export interface NativeCleanExportAdmission {
  readonly project: AuthoringProject;
  readonly diagnostics: ReturnType<typeof classifyProjectValidationDiagnostics>;
  readonly runtimeAssetReferences: readonly string[];
  readonly workingRevision: number;
  readonly sourceRevisions: Readonly<Record<string, string>>;
}

/**
 * Editor-main integration for the native Project admission lifecycle.
 *
 * Native admission is independent of the TypeScript Workspace. The candidate
 * parity entrypoint can additionally compare against a saved legacy snapshot,
 * but production entrypoints must consume admitFromNative instead.
 */
export class NativeEditorSessionController {
  private activeId: string | null = null;
  private generation = 0;
  private readonly unsubscribeFailure: () => void;
  private readonly runtimeCache = new NativeWorkingRuntimePreparationCache();
  private checkpointWrites: Promise<void> = Promise.resolve();
  private recoveredProject: AuthoringProject | null = null;
  private recoveryFailure: string | null = null;
  private assetStaging: NativeAssetStagingService | null = null;

  constructor(
    private readonly authority: Pick<
      ActiveProjectSessionService,
      'isCurrent' | 'requireActiveProjectRoot'
    >,
    private readonly bridge: Pick<NativeAuthoringSessionBridge, 'close' | 'onFailure'>,
    private readonly working: Pick<
      NativeAuthoringWorkingProject,
      | 'open'
      | 'prepareCompleteWorking'
      | 'validateWorking'
      | 'semanticGraph'
      | 'applyRevisionedPatches'
      | 'saveUnits'
      | 'saveOwners'
      | 'mutateSourceDirectory'
      | 'stageTextSource'
      | 'saveTextSources'
      | 'snapshot'
      | 'reconcile'
      | 'useDiskUnit'
      | 'dirtyCheckpoint'
      | 'restoreDirtyCheckpoint'
      | 'reopenAndReplay'
    >,
    private readonly checkpoints: Pick<
      NativeDirtyCheckpointStore,
      'read' | 'write'
    > = new NativeDirtyCheckpointStore(),
  ) {
    this.unsubscribeFailure = bridge.onFailure((error) => {
      const sessionId = this.activeId;
      if (!sessionId) return;
      this.activeId = null;
      const generation = ++this.generation;
      this.recoveryFailure = `Native Project worker failed: ${error.message}. Reopen the Project to restore acknowledged unsaved changes.`;
      void this.recoverWorker(sessionId, generation);
    });
  }

  private async recoverWorker(sessionId: string, generation: number): Promise<void> {
    try {
      await this.checkpointWrites;
      if (generation !== this.generation || !this.authority.isCurrent(sessionId)) return;
      const root = this.authority.requireActiveProjectRoot(sessionId);
      const projectId = this.projectIdentity;
      if (!projectId) throw new Error('Native Project identity is no longer available.');
      const checkpoint = await this.checkpoints.read(root, projectId);
      if (generation !== this.generation || !this.authority.isCurrent(sessionId)) return;
      if (checkpoint) await this.working.restoreDirtyCheckpoint(sessionId, checkpoint);
      else await this.working.open(sessionId);
      if (generation !== this.generation || !this.authority.isCurrent(sessionId)) return;
      // A renderer whose request was interrupted has an uncertain revision;
      // reopen is required to resynchronize its command and Save baselines.
    } catch (error) {
      if (generation === this.generation)
        this.recoveryFailure = `Native Project recovery blocked: ${error instanceof Error ? error.message : String(error)}. Unsaved changes remain in the local recovery journal; resolve the changed source or reopen in normal mode.`;
    }
  }

  private async persistAcknowledged(projectSessionId: string, generation: number): Promise<void> {
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project changed before recovery checkpoint publication.');
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    const projectId = this.projectIdentity;
    if (!projectId) throw new Error('Native recovery Project identity is unavailable.');
    const checkpoint = this.working.dirtyCheckpoint();
    const next = this.checkpointWrites.then(() =>
      this.checkpoints.write(root, projectId, checkpoint),
    );
    this.checkpointWrites = next.catch(() => undefined);
    try {
      await next;
    } catch (error) {
      this.recoveryFailure = `Native recovery checkpoint failed: ${error instanceof Error ? error.message : String(error)}. Reopen this Project before editing.`;
      this.activeId = null;
      this.bridge.close();
      throw error;
    }
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project was superseded during recovery checkpoint publication.');
  }

  private projectIdentity: string | null = null;

  recoveredContentProject(): AuthoringProject | null {
    return this.recoveredProject;
  }

  recoveredTextSources(): NativeDirtyCheckpoint['textSources'] {
    return this.recoveredProject ? this.working.dirtyCheckpoint().textSources : {};
  }

  recoveredConflicts(): Record<string, { paths: string[]; revision: string }> {
    if (!this.recoveredProject) return {};
    const snapshot = this.working.snapshot();
    const sources = [
      ...(snapshot ? [['project', snapshot] as const] : []),
      ...Object.entries(snapshot?.recordSnapshots ?? {}),
    ];
    return Object.fromEntries(
      sources.flatMap(([owner, source]) =>
        source.conflictingPaths?.length
          ? [[owner, { paths: [...source.conflictingPaths], revision: source.diskSourceRevision }]]
          : [],
      ),
    );
  }

  recoveryError(): string | null {
    return this.recoveryFailure;
  }

  /** Revoke the native session on replacement, explicit close or failure. */
  close(): void {
    this.assetStaging?.close();
    this.assetStaging = null;
    this.generation++;
    this.activeId = null;
    this.projectIdentity = null;
    this.recoveredProject = null;
    this.recoveryFailure = null;
    this.bridge.close();
    void this.runtimeCache.clear().catch((error) => {
      console.error('Failed to release native Project runtime cache:', error);
    });
  }

  /** Open only through native Project authority and recover against the native
   * identity. No TypeScript workspace or caller-supplied Project is required. */
  async admitFromNative(projectSessionId: string): Promise<{
    revision: number;
    savedProject: AuthoringProject;
    sourceRevisions: Record<string, string>;
    diagnostics: {
      code: string;
      severity: 'error' | 'warning' | 'info';
      path: string;
      message: string;
    }[];
  }> {
    return this.admitInternal(projectSessionId);
  }

  /** Differential certification only: reject a native/legacy Project mismatch. */
  async admit(projectSessionId: string, saved: AuthoringProject): Promise<number> {
    return (await this.admitInternal(projectSessionId, saved)).revision;
  }

  private async admitInternal(
    projectSessionId: string,
    legacySaved?: AuthoringProject,
  ): ReturnType<NativeEditorSessionController['admitFromNative']> {
    // There is no arbitrary renderer-selected worker root. The trusted main
    // Project session is rechecked before and after asynchronous admission.
    this.authority.requireActiveProjectRoot(projectSessionId);
    this.close();
    const generation = this.generation;
    try {
      await this.checkpointWrites;
      if (generation !== this.generation || !this.authority.isCurrent(projectSessionId))
        throw new Error('Native Project admission was superseded.');
      const root = this.authority.requireActiveProjectRoot(projectSessionId);
      await this.working.open(projectSessionId);
      if (generation !== this.generation || !this.authority.isCurrent(projectSessionId))
        throw new Error('Native Project admission was superseded.');
      const prepared = await this.working.prepareCompleteWorking();
      if (generation !== this.generation || !this.authority.isCurrent(projectSessionId))
        throw new Error('Native Project admission was superseded.');
      if (!prepared.accepted)
        throw new Error(`Native Project admission rejected: ${prepared.error}`);
      const native = projectFromNativeCompletePreparation(prepared);
      if (
        legacySaved &&
        canonicalProjectPersistenceContentJson(native) !==
          canonicalProjectPersistenceContentJson(legacySaved)
      )
        throw new Error('Native Project admission differs from the saved editor Workspace.');
      const checkpoint = await this.checkpoints.read(root, native.project.id);
      if (generation !== this.generation || !this.authority.isCurrent(projectSessionId))
        throw new Error('Native Project admission was superseded during recovery lookup.');
      let finalRevision = prepared.workingRevision;
      if (
        checkpoint &&
        (checkpoint.batches.length ||
          Object.keys(checkpoint.textSources).length ||
          Object.keys(checkpoint.conflicts).length ||
          Object.keys(checkpoint.pendingFields).length)
      ) {
        await this.working.restoreDirtyCheckpoint(projectSessionId, checkpoint);
        if (generation !== this.generation || !this.authority.isCurrent(projectSessionId))
          throw new Error('Native Project recovery was superseded.');
        const recovered = await this.working.prepareCompleteWorking();
        if (!recovered.accepted)
          throw new Error(
            `Native Project recovery cannot prepare dirty content: ${recovered.error}`,
          );
        this.recoveredProject = projectFromNativeCompletePreparation(recovered);
        finalRevision = recovered.workingRevision;
      }
      this.projectIdentity = native.project.id;
      this.assetStaging = new NativeAssetStagingService(root);
      this.activeId = projectSessionId;
      return {
        revision: finalRevision,
        savedProject: native,
        sourceRevisions: { ...prepared.sourceRevisions },
        diagnostics: prepared.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          path: diagnostic.path,
          message: diagnostic.sourcePath
            ? `${diagnostic.message} [${diagnostic.sourcePath}${diagnostic.line ? `:${diagnostic.line}` : ''}]`
            : diagnostic.message,
        })),
      };
    } catch (error) {
      if (generation === this.generation) this.close();
      throw error;
    }
  }

  /** An admitted native Project is the only mutable authority in certification mode. */
  isAdmitted(projectSessionId: string): boolean {
    return this.activeId === projectSessionId && this.authority.isCurrent(projectSessionId);
  }

  currentRevision(projectSessionId: string): number {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const revision = this.working.snapshot()?.workingRevision;
    if (revision === undefined) throw new Error('Native Project working revision is unavailable.');
    return revision;
  }

  async stageAsset(projectSessionId: string, path: string, bytes: Uint8Array): Promise<void> {
    if (!this.isAdmitted(projectSessionId) || !this.assetStaging)
      throw new Error('Native Project Asset import requires an admitted Project session.');
    const generation = this.generation;
    await this.assetStaging.stage(path, bytes);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project Asset import was superseded.');
  }

  async discardStagedAssets(projectSessionId: string, paths: string[]): Promise<void> {
    if (!this.isAdmitted(projectSessionId) || !this.assetStaging)
      throw new Error('Native Asset staging cleanup requires an admitted Project session.');
    await this.assetStaging.discard(paths);
  }

  async publishAttachments(
    projectSessionId: string,
    files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  ): Promise<void> {
    if (!files.every((file) => file.path.startsWith('support/') || file.path.startsWith('assets/')))
      throw new Error('Native supporting files must be placed under support/ or assets/.');
    const staged: string[] = [];
    try {
      for (const file of files) {
        await this.stageAsset(projectSessionId, file.path, file.bytes);
        staged.push(file.path);
      }
      const saved = await this.saveUnit(
        projectSessionId,
        this.currentRevision(projectSessionId),
        [],
        {
          structuralPathsByOwner: {},
          assetTransition: { kind: 'publish', projectRelativePaths: staged },
        },
      );
      if (!saved.accepted)
        throw new Error(saved.error || 'Native supporting file publication failed.');
    } catch (error) {
      if (staged.length && this.assetStaging?.hasAll(staged))
        await this.assetStaging.discard(staged);
      throw error;
    }
  }

  async transitionAssetFiles(
    projectSessionId: string,
    transition: Exclude<
      NonNullable<
        import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition']
      >,
      { kind: 'publish' }
    >,
  ) {
    const result = await this.saveUnit(
      projectSessionId,
      this.currentRevision(projectSessionId),
      [],
      {
        structuralPathsByOwner: {},
        assetTransition: transition,
      },
    );
    if (!result.accepted) throw new Error(result.error || 'Native Asset file transition rejected.');
    return result;
  }

  async trashOrDiscardAssetFiles(projectSessionId: string, paths: string[]) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project Asset cleanup requires an admitted session.');
    if (this.assetStaging?.hasAll(paths)) {
      await this.assetStaging.discard(paths);
      return { ok: true, success: true, diagnostics: [], moved: [] };
    }
    const result = await this.transitionAssetFiles(projectSessionId, {
      kind: 'trash',
      projectRelativePaths: paths,
    });
    return { ok: true, success: true, diagnostics: [], moved: result.assetTrashMoves ?? [] };
  }

  async organizeUntrackedAsset(
    projectSessionId: string,
    fromPath: string,
    toPath: string,
  ): Promise<void> {
    if (
      !fromPath.startsWith('assets/') ||
      !(toPath.startsWith('assets/') || toPath.startsWith('support/'))
    )
      throw new Error('Native Asset organization has invalid Project-relative paths.');
    const result = await this.saveUnit(
      projectSessionId,
      this.currentRevision(projectSessionId),
      [],
      {
        structuralPathsByOwner: {},
        assetTransition: { kind: 'move', moves: [{ fromPath, toPath }] },
      },
    );
    if (!result.accepted) throw new Error(result.error || 'Native Asset organization rejected.');
  }

  /** File bytes and affected semantic owners share one native crash-journal commit.
   * Planning only reads bytes. No legacy workspace writer is invoked. */
  async mutateProjectSources(request: ProjectSourceStructuralRequest) {
    const { projectSessionId } = request;
    const generation = this.generation;
    const revision = this.currentRevision(projectSessionId);
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    const prepared = await this.working.prepareCompleteWorking();
    if (!prepared.accepted || !prepared.completeProject)
      throw new Error(prepared.error || 'Native source transaction cannot prepare Project.');
    if (generation !== this.generation || revision !== this.currentRevision(projectSessionId))
      throw new Error('Native source transaction was superseded.');
    const pendingText = Object.keys(this.working.dirtyCheckpoint().textSources);
    const operation = request.operation;
    const relocating =
      operation.kind === 'move'
        ? operation.fromPath
        : operation.kind === 'delete'
          ? operation.path
          : operation.kind === 'material-shader-copy' &&
              operation.sourceIdentity.startsWith('project:/')
            ? operation.sourceIdentity.slice('project:/'.length)
            : null;
    if (
      relocating &&
      pendingText.some((source) => source === relocating || source.startsWith(`${relocating}/`))
    )
      throw new Error('Save or discard staged source text before relocating this source.');
    const previous = projectFromNativeCompletePreparation(prepared);
    const plan = await planNativeProjectSourceTransaction(
      root,
      previous,
      request.operation,
      request.expectedRevisions ?? {},
      prepared.sourceRevisions,
    );
    if (!plan.response.success) return plan.response;
    if (generation !== this.generation || revision !== this.currentRevision(projectSessionId))
      throw new Error('Native source transaction was superseded.');
    if (
      plan.transition?.kind === 'source-files' &&
      plan.transition.files.some((file) => pendingText.includes(file.path))
    )
      throw new Error('Save or discard staged source text before changing its physical file.');
    if (plan.emptyDirectory) {
      const { from, to, kind } = plan.emptyDirectory;
      const moved = await this.working.mutateSourceDirectory(revision, kind, from, to);
      if (!moved.accepted)
        throw new Error(moved.error || 'Native source folder transaction failed.');
      if (generation !== this.generation || !this.isAdmitted(projectSessionId))
        throw new Error('Native source folder operation was superseded.');
      await this.persistAcknowledged(projectSessionId, generation);
      return { ...plan.response, nativeWorkingRevision: this.currentRevision(projectSessionId) };
    }
    if (!plan.transition) throw new Error('Native source transaction has no physical targets.');
    let patched = false;
    try {
      if (plan.patches.length) {
        const result = await this.applyRevisionedPatches(projectSessionId, revision, plan.patches);
        if (!result.accepted) throw new Error(result.error || 'Native source references rejected.');
        patched = true;
      }
      const saved = await this.working.saveOwners(Object.keys(plan.savePaths).sort(), {
        expectedRevision: this.currentRevision(projectSessionId),
        pathsByOwner: plan.savePaths,
        assetTransition: plan.transition,
      });
      if (!saved.accepted) throw new Error(saved.error || 'Native file transaction failed.');
      // The files and references have committed together; never roll them
      // back because a now-empty directory cannot be pruned. Directory
      // removal itself is still native-session revisioned and checks emptiness.
      patched = false;
      for (const folder of plan.cleanupDirectories ?? []) {
        try {
          const cleaned = await this.working.mutateSourceDirectory(
            this.currentRevision(projectSessionId),
            'delete',
            folder,
          );
          if (!cleaned.accepted)
            throw new Error(cleaned.error || 'Native source folder cleanup rejected.');
        } catch (error) {
          console.warn('Retained source folder after native file transaction:', folder, error);
          break;
        }
      }
      if (generation !== this.generation || !this.isAdmitted(projectSessionId))
        throw new Error('Native Project changed after source transaction.');
      await this.persistAcknowledged(projectSessionId, generation);
      return { ...plan.response, nativeWorkingRevision: this.currentRevision(projectSessionId) };
    } catch (error) {
      if (patched && generation === this.generation && this.isAdmitted(projectSessionId)) {
        try {
          const latest = await this.working.prepareCompleteWorking();
          if (latest.accepted && latest.completeProject) {
            const rollback = diffJsonDocuments(
              projectFromNativeCompletePreparation(latest) as unknown as JsonValue,
              previous as unknown as JsonValue,
            );
            if (rollback.length) {
              const restored = await this.applyRevisionedPatches(
                projectSessionId,
                this.currentRevision(projectSessionId),
                rollback,
              );
              if (!restored.accepted) throw new Error(restored.error);
            }
          }
        } catch (rollbackError) {
          this.recoveryFailure =
            'Native source transaction failed and working reference rollback requires recovery: ' +
            String(rollbackError);
        }
      }
      throw error;
    }
  }

  async sourceUsages(projectSessionId: string, sourcePath: string) {
    if (
      !/^(?:scripts|shaders)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(sourcePath) ||
      sourcePath.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error('Project source usages require a contained scripts/ or shaders/ path.');
    const native = await this.currentWorkingProject(projectSessionId);
    const scriptSourcePaths = Object.fromEntries(
      Object.entries(native.scripts).flatMap(([id, record]) =>
        record.data.source.kind === 'project-file' ? [[id, record.data.source.path]] : [],
      ),
    );
    return {
      usages: await projectSourceUsages(
        this.authority.requireActiveProjectRoot(projectSessionId),
        { project: native, scriptSourcePaths },
        sourcePath,
      ),
    };
  }

  /** Preparatory native query seam for the #521 renderer migration. Caller
   * identity and latest working revision must still match after worker I/O. */
  async semanticGraph(projectSessionId: string, expectedRevision: number) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project graph requires the active admitted session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Project graph query revision.');
    const graph = await this.working.semanticGraph();
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      graph.projectSessionId !== projectSessionId ||
      graph.workingRevision !== expectedRevision ||
      this.working.snapshot()?.workingRevision !== expectedRevision
    )
      throw new Error('Native Project graph completed for a superseded session or revision.');
    return graph;
  }

  /** The first mutation boundary for native-backed renderer commands. It is
   * only callable from a trusted, separately gated main IPC handler, never
   * the legacy TypeScript Save path. Native is the sole mutation authority. */
  async applyRevisionedPatches(
    projectSessionId: string,
    expectedRevision: number,
    patches: readonly JsonPatchOperation[],
    layoutCopySources?: Record<string, string>,
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    const result = layoutCopySources
      ? await this.working.applyRevisionedPatches(expectedRevision, patches, layoutCopySources)
      : await this.working.applyRevisionedPatches(expectedRevision, patches);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project mutation completed for a superseded session.');
    if (result.accepted) await this.persistAcknowledged(projectSessionId, generation);
    return result;
  }

  async saveUnit(
    projectSessionId: string,
    expectedRevision: number,
    saveUnitIds: string | readonly string[],
    options: {
      keepMine?: boolean;
      comments?: 'keep' | 'remove' | 'cancel' | 'perEdit';
      textPaths?: string[];
      textContents?: Record<string, string>;
      structuralPathsByOwner?: Record<string, string[]>;
      assetTransition?: import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition'];
    },
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Project Save revision.');
    if (options.assetTransition?.kind === 'publish' && !this.assetStaging)
      throw new Error('Native Asset staging authority is unavailable.');
    const assetTransition =
      options.assetTransition?.kind === 'publish'
        ? this.assetStaging!.publication(options.assetTransition.projectRelativePaths)
        : options.assetTransition;
    const result = options.structuralPathsByOwner
      ? await this.working.saveOwners(Object.keys(options.structuralPathsByOwner).sort(), {
          pathsByOwner: options.structuralPathsByOwner,
          comments: options.comments,
          keepMine: options.keepMine,
          expectedRevision,
          assetTransition,
        })
      : await this.working.saveUnits(
          typeof saveUnitIds === 'string' ? [saveUnitIds] : saveUnitIds,
          options,
          expectedRevision,
        );
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project Save completed for a superseded session.');
    if (result.accepted) {
      if (options.assetTransition?.kind === 'publish')
        this.assetStaging?.committed(options.assetTransition.projectRelativePaths);
      await this.persistAcknowledged(projectSessionId, generation);
    }
    if (
      options.structuralPathsByOwner &&
      !result.accepted &&
      result.error.includes('Deleting commented records requires explicit Remove Comments approval')
    ) {
      const root = this.authority.requireActiveProjectRoot(projectSessionId);
      const canonicalRoot = await realpath(root);
      const impacts = [] as Array<{ file: string; path: string; comment: string; kind: 'deleted' }>;
      for (const [owner, fields] of Object.entries(options.structuralPathsByOwner)) {
        const match = /^([a-z]+)\/([a-z][a-z0-9-]*)$/u.exec(owner);
        if (!match || !fields.includes('/')) continue;
        const relative =
          match[1] === 'layouts'
            ? `records/layouts/${match[2]}/layout.yaml`
            : `records/${match[1]}/${match[2]}.yaml`;
        const canonical = await realpath(path.join(root, relative));
        const inside = path.relative(canonicalRoot, canonical);
        if (
          !inside ||
          inside === '..' ||
          inside.startsWith(`..${path.sep}`) ||
          path.isAbsolute(inside)
        )
          throw new Error('Native structural comment source escaped the active Project.');
        const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
        let source: string;
        try {
          source = await file.readFile('utf8');
        } finally {
          await file.close();
        }
        for (const impact of yamlCommentImpacts(source)) {
          if (impact.kind !== 'deleted') continue;
          impacts.push({
            file: relative,
            path: impact.path,
            comment: impact.comment,
            kind: 'deleted',
          });
        }
      }
      return { ...result, commentImpacts: impacts.slice(0, 256) };
    }
    return result;
  }

  /** Stage in native working memory and journal the exact source bytes through
   * the same physical Save authority. A rejected Save retains the overlay for
   * retry/reconciliation rather than falling back to the legacy source writer. */
  async saveText(
    projectSessionId: string,
    expectedRevision: number,
    path: string,
    diskRevision: string,
    text: string,
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native text source Save revision.');
    const staged = await this.working.stageTextSource(path, text, diskRevision);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native text source stage was superseded by another Project.');
    if (!staged.accepted) return staged;
    await this.persistAcknowledged(projectSessionId, generation);
    const saved = await this.working.saveTextSources(staged.snapshot.workingRevision, [path]);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native text source Save was superseded by another Project.');
    if (saved.accepted) await this.persistAcknowledged(projectSessionId, generation);
    return saved;
  }

  async stageText(
    projectSessionId: string,
    expectedRevision: number,
    path: string,
    diskRevision: string,
    text: string,
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native text source stage revision.');
    const staged = await this.working.stageTextSource(path, text, diskRevision);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native text source stage completed for a superseded Project.');
    if (staged.accepted) await this.persistAcknowledged(projectSessionId, generation);
    return staged;
  }

  /** Reconcile one native source owner; never trust renderer-supplied disk values. */
  async reconcile(projectSessionId: string, expectedRevision: number, owner: string) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Project reconciliation revision.');
    const result = await this.working.reconcile(owner);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native reconciliation completed for a superseded Project.');
    if (result.accepted) await this.persistAcknowledged(projectSessionId, generation);
    return result;
  }

  /** Discard the selected logical owner's local changes only after a native
   * revision check. Native handles the multi-file baseline and conflict state. */
  async useDiskUnit(projectSessionId: string, expectedRevision: number, saveUnitId: string) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Use Disk revision.');
    const result = await this.working.useDiskUnit(saveUnitId);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Use Disk completed for a superseded Project.');
    if (result.accepted) await this.persistAcknowledged(projectSessionId, generation);
    return result;
  }

  async validate(projectSessionId: string, expectedRevision: number) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native validation working revision.');
    const validated = await this.working.validateWorking();
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      this.working.snapshot()?.workingRevision !== expectedRevision ||
      validated.workingRevision !== expectedRevision
    )
      throw new Error('Native Project validation was superseded by another edit or Project.');
    const diagnostics = validated.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      category: 'Native authoring validation',
      path: diagnostic.path,
      message: diagnostic.sourcePath
        ? `${diagnostic.message} [${diagnostic.sourcePath}${diagnostic.line ? `:${diagnostic.line}` : ''}]`
        : diagnostic.message,
    }));
    if (!validated.valid && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      diagnostics.push({
        code: 'editor.native-validation.rejected',
        severity: 'error',
        category: 'Native authoring validation',
        path: '/',
        message: 'Native working Project validation rejected the current revision.',
      });
    }
    return {
      ok: true,
      success:
        validated.valid && !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      diagnostics,
    };
  }

  /** Read-only Asset discovery and other editor file consumers use the same
   * native working generation as commands and source editing, even when a
   * different Save unit remains dirty. */
  async currentWorkingProject(projectSessionId: string): Promise<AuthoringProject> {
    const generation = this.generation;
    const revision = this.currentRevision(projectSessionId);
    const prepared = await this.working.prepareCompleteWorking();
    if (!prepared.accepted || !prepared.completeProject)
      throw new Error(prepared.error || 'Native working Project is unavailable.');
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      revision !== this.currentRevision(projectSessionId)
    )
      throw new Error('Native working Project changed during Asset discovery.');
    return projectFromNativeCompletePreparation(prepared);
  }

  /** Export uses admitted, *saved* native source, never a renderer document or
   * the TypeScript workspace reader. Check every admitted source against the
   * physical bytes at the start and publication boundary. */
  async prepareCleanExportAdmission(projectSessionId: string): Promise<NativeCleanExportAdmission> {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Export requires an admitted native Project.');
    const revision = this.currentRevision(projectSessionId);
    const dirty = this.working.dirtyCheckpoint();
    if (
      dirty.batches.length ||
      Object.keys(dirty.textSources).length ||
      Object.keys(dirty.pendingFields).length ||
      Object.keys(dirty.conflicts).length
    )
      throw new Error('Save or resolve all dirty Project and source files before exporting.');
    const prepared = await this.working.prepareCompleteWorking();
    if (
      !prepared.accepted ||
      !prepared.completeProject ||
      prepared.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    )
      throw new Error(prepared.error || 'Native Project export source is invalid.');
    if (!Array.isArray(prepared.referencedAssetIds))
      throw new Error('Native Project export admission omitted Runtime Asset references.');
    const nativeProject = projectFromNativeCompletePreparation(prepared);
    const assetHashes = nativeAssetContentHashes(nativeProject);
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    const canonicalRoot = await realpath(root);
    for (const [relative, revisionHash] of Object.entries(prepared.sourceRevisions)) {
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes('\\') ||
        path.posix.normalize(relative) !== relative ||
        relative.split('/').includes('..')
      )
        throw new Error('Invalid native export source path.');
      const absolute = path.resolve(root, relative);
      const canonical = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
        if (revisionHash === 'absent' && error.code === 'ENOENT') return null;
        throw error;
      });
      if (revisionHash === 'absent') {
        if (canonical !== null)
          throw new Error(`Native export source unexpectedly exists: ${relative}`);
        continue;
      }
      if (
        !canonical ||
        path.relative(canonicalRoot, canonical) !== relative.split('/').join(path.sep)
      )
        throw new Error(`Native export source escaped its verified path: ${relative}`);
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      verifyNativeSourceBytes(relative, revisionHash, bytes, assetHashes);
    }
    if (revision !== this.currentRevision(projectSessionId))
      throw new Error('Native Project changed during export preparation.');
    return {
      project: nativeProject,
      diagnostics: classifyProjectValidationDiagnostics(prepared.diagnostics, {
        producer: 'authoring',
      }),
      runtimeAssetReferences: prepared.referencedAssetIds,
      workingRevision: revision,
      sourceRevisions: prepared.sourceRevisions,
    };
  }

  async prepareCleanExport(projectSessionId: string): Promise<AuthoringProject> {
    return (await this.prepareCleanExportAdmission(projectSessionId)).project;
  }

  /** Save Copy As copies saved physical sources, not the unsaved working
   * projection. Dirty editor edits are deliberately allowed: the caller
   * carries only their local recovery metadata to the copy. */
  async verifySavedCopySources(projectSessionId: string): Promise<void> {
    const generation = this.generation;
    const revision = this.currentRevision(projectSessionId);
    const prepared = await this.working.prepareCompleteWorking();
    if (!prepared.sourceRevisions || !Object.keys(prepared.sourceRevisions).length)
      throw new Error('Native saved source inventory is unavailable.');
    if (!prepared.accepted || !prepared.completeProject)
      throw new Error(prepared.error || 'Native saved Project could not be prepared.');
    const assetHashes = nativeAssetContentHashes(projectFromNativeCompletePreparation(prepared));
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    const canonicalRoot = await realpath(root);
    for (const [relative, revisionHash] of Object.entries(prepared.sourceRevisions)) {
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes('\\') ||
        path.posix.normalize(relative) !== relative ||
        relative.split('/').some((part) => part === '..' || part === '.')
      )
        throw new Error('Invalid native source inventory path.');
      const absolute = path.join(root, relative);
      const resolved = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
        if (revisionHash === 'absent' && error.code === 'ENOENT') return null;
        throw error;
      });
      if (revisionHash === 'absent') {
        if (resolved !== null)
          throw new Error('Native saved source unexpectedly exists: ' + relative);
        continue;
      }
      if (
        !resolved ||
        path.relative(canonicalRoot, resolved) !== relative.split('/').join(path.sep)
      )
        throw new Error('Native saved source escapes its admitted identity: ' + relative);
      const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        verifyNativeSourceBytes(relative, revisionHash, await file.readFile(), assetHashes);
      } finally {
        await file.close();
      }
    }
    if (generation !== this.generation || revision !== this.currentRevision(projectSessionId))
      throw new Error('Native Project changed during saved-source copy verification.');
  }

  /** Prepare playable content from the native complete Project, including
   * acknowledged dirty YAML and text/shader overlays. No renderer Project
   * argument is used to fill missing records or compile a separate copy. */
  async prepareRuntime(
    projectSessionId: string,
    expectedRevision: number,
    shaderVariant: ShaderVariant,
  ): Promise<EditorRuntimePreparationResult> {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native runtime preparation revision.');
    const prepared = await this.working.prepareCompleteWorking();
    const project = prepared.accepted
      ? projectWithPreviewLocale(projectFromNativeCompletePreparation(prepared))
      : null;
    const locale = project ? effectivePreviewLocale(project) : null;
    const buildContext: EditorRuntimePreparationResult['buildContext'] =
      project && locale !== project.localization.defaultLocale && locale
        ? locale === PSEUDO_PREVIEW_LOCALE
          ? { kind: 'pseudo-preview-locale', locale, shaderVariant }
          : { kind: 'preview-locale', locale, shaderVariant }
        : { kind: 'canonical', shaderVariant };
    const result = await this.runtimeCache.prepare({
      prepared,
      projectRoot: root,
      shaderVariant,
    });
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      this.working.snapshot()?.workingRevision !== expectedRevision
    ) {
      if (result.status === 'prepared') await result.dispose();
      throw new Error('Native runtime preparation was superseded by another edit or Project.');
    }
    if (result.status === 'blocked') {
      return {
        status: 'blocked',
        diagnostics: result.diagnostics.map((diagnostic) => ({
          code: 'native.runtime.prepare',
          severity: 'error' as const,
          category: 'Native runtime preparation',
          path: diagnostic.path,
          message: diagnostic.message,
          boundaries: ['runtime-package'] as const,
          ownerPaths: [diagnostic.path],
        })),
        buildContext,
        cache: { scope: 'session-local', status: 'prepared' },
      };
    }
    // The cache retains the prepared input roots until eviction or close.
    // Release the caller lease, not the verified backing files.
    const artifact = result.artifact;
    await result.dispose();
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      this.working.snapshot()?.workingRevision !== expectedRevision
    )
      throw new Error('Native runtime preparation was superseded during publication.');
    return {
      status: 'prepared',
      artifact,
      buildContext,
      cache: { scope: 'session-local', status: 'prepared' },
    };
  }

  async testReadiness(
    projectSessionId: string,
    expectedRevision: number,
    testId: string,
  ): Promise<import('../../shared/project-schema/test-playback-projection').TestRunReadiness> {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Test readiness revision.');
    const prepared = await this.working.prepareCompleteWorking(testId);
    const result = await this.runtimeCache.prepare({ prepared, projectRoot: root, testId });
    let readiness: import('../../shared/project-schema/test-playback-projection').TestRunReadiness;
    try {
      if (
        generation !== this.generation ||
        !this.isAdmitted(projectSessionId) ||
        this.working.snapshot()?.workingRevision !== expectedRevision
      )
        throw new Error('Native Test readiness was superseded.');
      readiness =
        result.status === 'blocked'
          ? {
              runnable: false,
              reason: 'not-runnable-project-compilation-failed',
              diagnostics: result.diagnostics.map((diagnostic) => ({
                code: 'native.test.prepare',
                severity: 'error' as const,
                path: diagnostic.path,
                message: diagnostic.message,
              })),
            }
          : { runnable: true, reason: 'runnable', diagnostics: [] };
    } finally {
      if (result.status === 'prepared') await result.dispose();
    }
    // Disposing the caller's runtime lease is asynchronous. A Project switch,
    // worker failure or further edit during disposal must not publish a stale
    // runnable status back to an editor tab that has already changed.
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      this.working.snapshot()?.workingRevision !== expectedRevision
    )
      throw new Error('Native Test readiness was superseded during lease release.');
    return readiness;
  }

  async runTest(
    projectSessionId: string,
    expectedRevision: number,
    testId: string,
  ): Promise<PlaybackReportResponse> {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Test execution revision.');
    const prepared = await this.working.prepareCompleteWorking(testId);
    const result = await this.runtimeCache.prepare({
      prepared,
      projectRoot: root,
      testId,
    });
    try {
      if (
        generation !== this.generation ||
        !this.isAdmitted(projectSessionId) ||
        this.working.snapshot()?.workingRevision !== expectedRevision
      )
        throw new Error('Native Test preparation was superseded.');
      if (result.status === 'blocked')
        return {
          ok: false,
          success: false,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            code: 'native.test.prepare',
            severity: 'error' as const,
            category: 'Native authored Test',
            path: diagnostic.path,
            message: diagnostic.message,
          })),
        };
      const outcome = await runNativeWorkingTest(result, root);
      if (
        generation !== this.generation ||
        !this.isAdmitted(projectSessionId) ||
        this.working.snapshot()?.workingRevision !== expectedRevision
      )
        throw new Error('Native Test result was superseded by a Project edit.');
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        !('ok' in outcome) ||
        typeof outcome.ok !== 'boolean'
      )
        throw new Error('Native Test runner returned an invalid response.');
      return outcome as PlaybackReportResponse;
    } finally {
      if (result.status === 'prepared') await result.dispose();
    }
  }

  async runSuite(
    projectSessionId: string,
    expectedRevision: number,
  ): Promise<PlaybackReportResponse> {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    const root = this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Test-suite execution revision.');
    const prepared = await this.working.prepareCompleteWorking();
    const result = await this.runtimeCache.prepare({
      prepared,
      projectRoot: root,
      testSuite: true,
    });
    try {
      if (
        generation !== this.generation ||
        !this.isAdmitted(projectSessionId) ||
        this.working.snapshot()?.workingRevision !== expectedRevision
      )
        throw new Error('Native Test suite preparation was superseded.');
      if (result.status === 'blocked')
        return {
          ok: false,
          success: false,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            code: 'native.test-suite.prepare',
            severity: 'error' as const,
            category: 'Native authored Tests',
            path: diagnostic.path,
            message: diagnostic.message,
          })),
        };
      const outcome = await invokeNovelTeaNativeOperation('run-test-suite', {
        project: result.artifact.compiledProject,
        catalog: buildRuntimeTestCatalog(projectFromNativeCompletePreparation(prepared)),
        projectRoot: root,
        shaderMaterialMetadata: result.artifact.shaderMaterialMetadata ?? null,
        shaderVariants: result.artifact.packageOptions.shaderVariants,
      });
      if (
        generation !== this.generation ||
        !this.isAdmitted(projectSessionId) ||
        this.working.snapshot()?.workingRevision !== expectedRevision
      )
        throw new Error('Native Test-suite result was superseded by a Project edit.');
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        !('ok' in outcome) ||
        typeof outcome.ok !== 'boolean'
      )
        throw new Error('Native Test-suite runner returned an invalid response.');
      return outcome as PlaybackReportResponse;
    } finally {
      if (result.status === 'prepared') await result.dispose();
    }
  }

  dispose(): void {
    this.close();
    this.unsubscribeFailure();
  }
}
