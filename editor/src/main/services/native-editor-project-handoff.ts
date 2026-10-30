import type { OpenProjectResponse } from '../../shared/editor-tooling';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { NativeEditorSessionController } from './native-editor-session-controller';
import { openNativeEditorProject } from './native-editor-project-open';

type NativeController = Pick<
  NativeEditorSessionController,
  | 'admitFromNative'
  | 'recoveredContentProject'
  | 'recoveredConflicts'
  | 'recoveredTextSources'
  | 'close'
  | 'dispose'
>;

/**
 * The incumbent's native worker must not be reopened to admit the next
 * Project. Every in-flight Open owns a fresh worker/controller until it has
 * passed native source admission and local recovery. Only a successfully
 * promoted session replaces the incumbent; failed or superseded candidates
 * can dispose only themselves.
 */
export class NativeEditorProjectHandoff<T extends NativeController> {
  private active: T | null = null;
  private readonly candidates = new Set<T>();

  constructor(
    private readonly sessions: ActiveProjectSessionService,
    private readonly createController: () => T,
  ) {}

  current(): T | null {
    return this.active;
  }

  async open(projectPath: string): Promise<OpenProjectResponse> {
    const candidate = this.createController();
    if (candidate === this.active || this.candidates.has(candidate))
      throw new Error('Native Project candidate must own an independent worker.');
    const generation = this.sessions.beginProjectActivation();
    this.candidates.add(candidate);
    try {
      const result = await openNativeEditorProject(
        projectPath,
        generation,
        this.sessions,
        candidate,
      );
      if (result.success) {
        const incumbent = this.active;
        this.active = candidate;
        // Promotion revokes the incumbent's authority before its worker is
        // disposed. No callback can rescue an old session after the switch.
        if (incumbent) incumbent.dispose();
      }
      return result;
    } finally {
      this.candidates.delete(candidate);
      if (this.active !== candidate) candidate.dispose();
    }
  }

  close(): void {
    this.sessions.closeActiveProject();
    const old = this.active;
    this.active = null;
    old?.dispose();
    for (const candidate of this.candidates) candidate.dispose();
    this.candidates.clear();
  }
}
