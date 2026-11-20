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
> & {
  waitForPublicationDrain?(): Promise<void>;
  waitForShutdown?(): Promise<void>;
};

async function awaitControllerShutdown(controller: NativeController): Promise<void> {
  if (controller.waitForShutdown) await controller.waitForShutdown();
  else await controller.waitForPublicationDrain?.();
}

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
        if (incumbent) {
          incumbent.dispose();
          await awaitControllerShutdown(incumbent);
        }
      }
      return result;
    } finally {
      this.candidates.delete(candidate);
      if (this.active !== candidate) {
        candidate.dispose();
        await awaitControllerShutdown(candidate);
      }
    }
  }

  async close(): Promise<void> {
    this.sessions.closeActiveProject();
    const old = this.active;
    this.active = null;
    const controllers = [...this.candidates];
    this.candidates.clear();
    const remaining = [old, ...controllers].filter((item): item is T => item !== null);
    for (const controller of remaining) controller.dispose();
    await Promise.all(
      remaining.map((controller) => awaitControllerShutdown(controller)),
    );
  }
}
