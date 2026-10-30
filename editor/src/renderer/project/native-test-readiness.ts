import type { TestRunReadiness } from '../../shared/project-schema/test-playback-projection';
import { useCommandStore } from '../commands/command-store';
import { useProjectStore } from './project-store';

export async function getNativeTestRunReadiness(testId: string): Promise<TestRunReadiness> {
  const projectSessionId = useProjectStore.getState().projectSessionId;
  const revision = useCommandStore.getState().nativeWorkingRevision;
  try {
    if (!projectSessionId || revision === null)
      throw new Error('Native Test readiness requires an active Project session.');
    return await window.noveltea.nativeProjectTestReadiness(projectSessionId, revision, testId);
  } catch (error) {
    return {
      runnable: false,
      reason: 'not-runnable-project-compilation-failed',
      diagnostics: [
        {
          code: 'native.test.readiness',
          severity: 'error',
          path: `/tests/${testId}`,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
