import {
  defaultUserExportConfig,
  parseUserExportConfig,
  type UserExportConfig,
} from '../../shared/project-schema/platform-export-contracts';
import { novelTeaUserConfigPath, loadNovelTeaUserConfig, updateNovelTeaUserConfig } from './user-config-service';

export function userExportConfigRoot(): string {
  return novelTeaUserConfigPath();
}

export function userExportConfigPath(): string {
  return novelTeaUserConfigPath();
}

export async function loadUserExportConfig(): Promise<UserExportConfig> {
  return (await loadNovelTeaUserConfig()).export ?? defaultUserExportConfig();
}

export function saveUserExportConfig(value: unknown): Promise<UserExportConfig> {
  const parsed = parseUserExportConfig(value);
  return updateNovelTeaUserConfig((current) => ({ ...current, export: parsed })).then(
    (config) => config.export,
  );
}
