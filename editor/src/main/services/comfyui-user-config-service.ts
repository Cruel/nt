import {
  comfyUiSharedUserConfigSchema,
  normalizeComfyUiSharedUserConfig,
  type ComfyUiSharedUserConfig,
} from '../../shared/comfyui';
import {
  novelTeaUserConfigPath,
  loadNovelTeaUserConfig,
  updateNovelTeaUserConfig,
} from './user-config-service';

export function comfyUiUserConfigPath(): string {
  return novelTeaUserConfigPath();
}

export async function loadComfyUiUserConfig(): Promise<ComfyUiSharedUserConfig> {
  return (await loadNovelTeaUserConfig()).comfyui;
}

export function saveComfyUiUserConfig(value: unknown): Promise<ComfyUiSharedUserConfig> {
  const parsed = normalizeComfyUiSharedUserConfig(comfyUiSharedUserConfigSchema.parse(value));
  return updateNovelTeaUserConfig((current) => ({ ...current, comfyui: parsed })).then(
    (config) => config.comfyui,
  );
}
