import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { canonicalProjectPersistenceContentJson } from '../../shared/project-schema/editor-project-state';
import { projectFromNativeCompletePreparation } from './native-authoring-runtime-preparation';
import type { NativeAuthoringSessionBridge } from './native-authoring-session-bridge';
import type { NativeAuthoringWorkingProject } from './native-authoring-working-project';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { JsonPatchOperation } from '../../renderer/project/json-patch';

/**
 * Editor-main integration for the native Project admission lifecycle.
 *
 * During the coordinated cutover this is deliberately an opt-in, read-only
 * gate: native admission must agree with the existing saved Workspace before
 * the renderer can open. It never mirrors renderer edits or writes source;
 * doing that without moving the synchronous Command Store would create two
 * independently mutable production Projects.
 */
export class NativeEditorSessionController {
  private activeId: string | null = null;
  private generation = 0;
  private readonly unsubscribeFailure: () => void;

  constructor(
    private readonly authority: Pick<
      ActiveProjectSessionService,
      'isCurrent' | 'requireActiveProjectRoot'
    >,
    private readonly bridge: Pick<NativeAuthoringSessionBridge, 'close' | 'onFailure'>,
    private readonly working: Pick<
      NativeAuthoringWorkingProject,
      'open' | 'prepareCompleteWorking' | 'applyRevisionedPatches' | 'saveUnits' | 'snapshot'
    >,
  ) {
    this.unsubscribeFailure = bridge.onFailure(() => this.close());
  }

  /** Revoke the native session on replacement, explicit close or failure. */
  close(): void {
    this.generation++;
    this.activeId = null;
    this.bridge.close();
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

  /** No native mutations are exposed until the entire editor switches owners. */
  isAdmitted(projectSessionId: string): boolean {
    return this.activeId === projectSessionId && this.authority.isCurrent(projectSessionId);
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

  dispose(): void {
    this.close();
    this.unsubscribeFailure();
  }
}
