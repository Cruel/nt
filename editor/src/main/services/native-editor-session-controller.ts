import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { canonicalProjectPersistenceContentJson } from '../../shared/project-schema/editor-project-state';
import { projectFromNativeCompletePreparation } from './native-authoring-runtime-preparation';
import type { NativeAuthoringSessionBridge } from './native-authoring-session-bridge';
import type { NativeAuthoringWorkingProject } from './native-authoring-working-project';
import type { ActiveProjectSessionService } from './active-project-session-service';

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
      'open' | 'prepareCompleteWorking'
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

  async admit(projectSessionId: string, saved: AuthoringProject): Promise<void> {
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
    } catch (error) {
      if (generation === this.generation) this.close();
      throw error;
    }
  }

  /** No native mutations are exposed until the entire editor switches owners. */
  isAdmitted(projectSessionId: string): boolean {
    return this.activeId === projectSessionId && this.authority.isCurrent(projectSessionId);
  }

  dispose(): void {
    this.close();
    this.unsubscribeFailure();
  }
}
