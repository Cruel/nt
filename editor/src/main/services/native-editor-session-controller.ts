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

  constructor(
    private readonly authority: Pick<
      ActiveProjectSessionService,
      'isCurrent' | 'requireActiveProjectRoot'
    >,
    private readonly bridge: Pick<NativeAuthoringSessionBridge, 'close' | 'onFailure'>,
    private readonly working: Pick<
      NativeAuthoringWorkingProject,
      'open' | 'prepareCompleteWorking' | 'applyRevisionedPatches' | 'saveUnits' |
      'stageTextSource' | 'saveTextSources' | 'snapshot' | 'reconcile' | 'useDiskUnit'
    >,
  ) {
    this.unsubscribeFailure = bridge.onFailure(() => this.close());
  }

  /** Revoke the native session on replacement, explicit close or failure. */
  close(): void {
    this.generation++;
    this.activeId = null;
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
      this.activeId = projectSessionId;
      return prepared.workingRevision;
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
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    const result = await this.working.applyRevisionedPatches(expectedRevision, patches);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project mutation completed for a superseded session.');
    return result;
  }

  async saveUnit(
    projectSessionId: string,
    expectedRevision: number,
    saveUnitIds: string | readonly string[],
    options: { keepMine?: boolean; comments?: 'keep' | 'remove' | 'cancel' | 'perEdit' },
  ) {
    if (!this.isAdmitted(projectSessionId))
      throw new Error('Native Project is not admitted for this editor session.');
    const generation = this.generation;
    this.authority.requireActiveProjectRoot(projectSessionId);
    if (this.working.snapshot()?.workingRevision !== expectedRevision)
      throw new Error('Stale native Project Save revision.');
    const result = await this.working.saveUnits(
      typeof saveUnitIds === 'string' ? [saveUnitIds] : saveUnitIds,
      options,
      expectedRevision,
    );
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native Project Save completed for a superseded session.');
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
    const saved = await this.working.saveTextSources(staged.snapshot.workingRevision, [path]);
    if (generation !== this.generation || !this.isAdmitted(projectSessionId))
      throw new Error('Native text source Save was superseded by another Project.');
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
    ) throw new Error('Native Project validation was superseded by another edit or Project.');
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
      success: prepared.accepted &&
        !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
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
    ) throw new Error('Native runtime preparation was superseded during publication.');
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
      ) throw new Error('Native Test preparation was superseded.');
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
      ) throw new Error('Native Test result was superseded by a Project edit.');
      if (!outcome || typeof outcome !== 'object' || !('ok' in outcome) ||
          typeof outcome.ok !== 'boolean')
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
      ) throw new Error('Native Test suite preparation was superseded.');
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
      ) throw new Error('Native Test-suite result was superseded by a Project edit.');
      if (!outcome || typeof outcome !== 'object' || !('ok' in outcome) ||
          typeof outcome.ok !== 'boolean')
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
