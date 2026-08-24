import { z } from 'zod';
import {
  comfyUiSharedUserConfigSchema,
  defaultComfyUiSharedUserConfig,
  type ComfyUiSharedUserConfig,
} from './comfyui';
import {
  defaultUserExportConfig,
  userExportConfigSchema,
  type UserExportConfig,
} from './project-schema/platform-export-contracts';

export const NOVELTEA_USER_CONFIG_FORMAT = 'noveltea.user-config' as const;
export const NOVELTEA_USER_CONFIG_FORMAT_VERSION = 1 as const;

export const novelTeaUserPreferencesSchema = z.record(z.string(), z.unknown());
const defaultComfyUiSection = () =>
  comfyUiSharedUserConfigSchema.parse(defaultComfyUiSharedUserConfig());

export const novelTeaUserConfigSchema = z
  .object({
    format: z.literal(NOVELTEA_USER_CONFIG_FORMAT),
    formatVersion: z.literal(NOVELTEA_USER_CONFIG_FORMAT_VERSION),
    preferences: novelTeaUserPreferencesSchema.default({}),
    comfyui: comfyUiSharedUserConfigSchema.default(defaultComfyUiSection),
    export: userExportConfigSchema.default(defaultUserExportConfig),
  })
  .strict();

export type NovelTeaUserPreferences = z.infer<typeof novelTeaUserPreferencesSchema>;
export interface NovelTeaUserConfig {
  format: typeof NOVELTEA_USER_CONFIG_FORMAT;
  formatVersion: typeof NOVELTEA_USER_CONFIG_FORMAT_VERSION;
  preferences: NovelTeaUserPreferences;
  comfyui: ComfyUiSharedUserConfig;
  export: UserExportConfig;
}

export function defaultNovelTeaUserConfig(): NovelTeaUserConfig {
  return {
    format: NOVELTEA_USER_CONFIG_FORMAT,
    formatVersion: NOVELTEA_USER_CONFIG_FORMAT_VERSION,
    preferences: {},
    comfyui: defaultComfyUiSharedUserConfig(),
    export: defaultUserExportConfig(),
  };
}
