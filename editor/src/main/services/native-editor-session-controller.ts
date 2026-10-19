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

/**
 * Editor-main integration for the native Project admission lifecycle.
 *
 * During the coordinated cutover this remains an opt-in certification gate:
 * native admission must agree with the existing saved Workspace before the
 * renderer can open. Commands, source staging, scoped Save, validation,
 * previews and authored Tests then operate only through the active native
 * Project. Legacy Project writers remain rejected in this mode; no
 * independent TypeScript authoring fallback is permitted.
 */
export class NativeEditorSessionController {
  private activeId: string | null = null;
  private generation = 0;
  private readonly unsubscribeFailure: () => void;
  private readonly runtimeCache = new NativeWorkingRuntimePreparationCache();
  private checkpointWrites: Promise<void> = Promise.resolve();
  private recoveredProject: AuthoringProject | null = null;
  private recoveryFailure: string | null = null;

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
      | 'applyRevisionedPatches'
      | 'saveUnits'
      | 'saveOwners'
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

  async admit(projectSessionId: string, saved: AuthoringProject): Promise<number> {
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
      const checkpoint = await this.checkpoints.read(root, saved.project.id);
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
        canonicalProjectPersistenceContentJson(native) !==
        canonicalProjectPersistenceContentJson(saved)
      )
        throw new Error('Native Project admission differs from the saved editor Workspace.');
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
      this.projectIdentity = saved.project.id;
      this.activeId = projectSessionId;
      return finalRevision;
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
    const result = options.structuralPathsByOwner
      ? await this.working.saveOwners(Object.keys(options.structuralPathsByOwner).sort(), {
          pathsByOwner: options.structuralPathsByOwner,
          comments: options.comments,
          keepMine: options.keepMine,
          expectedRevision,
          assetTransition: options.assetTransition,
        })
      : await this.working.saveUnits(
          typeof saveUnitIds === 'string' ? [saveUnitIds] : saveUnitIds,
          options,
          expectedRevision,
        );
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project Save completed for a superseded session.');
    if (result.accepted) await this.persistAcknowledged(projectSessionId, generation);
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
    const prepared = await this.working.prepareCompleteWorking();
    if (
      generation !== this.generation ||
      !this.isAdmitted(projectSessionId) ||
      this.working.snapshot()?.workingRevision !== expectedRevision
    )
      throw new Error('Native Project validation was superseded by another edit or Project.');
    const diagnostics = prepared.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      category: 'Native authoring validation',
      path: diagnostic.path,
      message: diagnostic.sourcePath
        ? `${diagnostic.message} [${diagnostic.sourcePath}${diagnostic.line ? `:${diagnostic.line}` : ''}]`
        : diagnostic.message,
    }));
    if (!prepared.accepted && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      diagnostics.push({
        code: 'editor.native-validation.rejected',
        severity: 'error',
        category: 'Native authoring validation',
        path: '/',
        message: prepared.error || 'Native Project validation rejected the working generation.',
      });
    }
    return {
      ok: true,
      success:
        prepared.accepted && !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      diagnostics,
    };
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
