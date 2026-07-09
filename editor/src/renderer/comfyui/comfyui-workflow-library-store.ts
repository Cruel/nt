import type { ComfyUiConfig } from '../../shared/comfyui';
import { useProjectStore } from '@/project/project-store';
import { listComfyUiWorkflowLibrary, verifyComfyUiWorkflowLibrary } from './comfyui-service';

const verifiedSessionKeys = new Set<string>();
let inFlightKey: string | null = null;

function packageSessionKey(config: ComfyUiConfig, projectFilePath: string | null | undefined, parts: string[]) {
  return [
    config.serverUrl,
    projectFilePath ?? '',
    ...parts.sort(),
  ].join('|');
}

export function invalidateComfyUiWorkflowVerification() {
  verifiedSessionKeys.clear();
  inFlightKey = null;
}

export async function triggerComfyUiWorkflowVerification(config: ComfyUiConfig, projectFilePath?: string | null, comfyUiVersion?: string) {
  if (!config.enabled) return;
  const library = await listComfyUiWorkflowLibrary({ projectFilePath, includeOverridden: true, comfyUiVersion });
  const packageParts = library.entries
    .filter((entry) => entry.offlineStatus !== 'invalid' && entry.packageHash)
    .map((entry) => `${entry.workflowKey}:${entry.packageHash}`);
  const sessionKey = packageSessionKey(config, projectFilePath, [comfyUiVersion ?? 'unknown-version', ...packageParts]);
  if (verifiedSessionKeys.has(sessionKey) || inFlightKey) return;

  inFlightKey = sessionKey;
  try {
    await verifyComfyUiWorkflowLibrary({ projectFilePath, config });
    verifiedSessionKeys.add(sessionKey);
  } finally {
    if (inFlightKey === sessionKey) inFlightKey = null;
  }
}

useProjectStore.subscribe((state, previousState) => {
  if (state.projectFilePath !== previousState.projectFilePath) invalidateComfyUiWorkflowVerification();
});
