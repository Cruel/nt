import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, ReferenceTarget } from './authoring-project';
import { defaultLayoutSettingSchema } from './authoring-layouts';

const assetRecordRefSchema = z.object({
  $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }),
});

const fontAssetRefSchema = assetRecordRefSchema.nullable();
const imageAssetRefSchema = assetRecordRefSchema.nullable();

export const projectStartupSettingsSchema = z.object({
  initScript: z.string().default(''),
});

export const projectTextSettingsSchema = z.object({
  defaultFont: fontAssetRefSchema.default(null),
});

export const projectTitleScreenSettingsSchema = z.object({
  titleImage: imageAssetRefSchema.default(null),
  showProjectTitle: z.boolean().default(true),
  showAuthor: z.boolean().default(false),
  subtitle: z.string().default(''),
  startLabel: z.string().min(1, 'Start label is required.').default('Start'),
});

export const projectAppSettingsSchema = z.object({
  icon: imageAssetRefSchema.default(null),
});

export const projectComfyUiSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().trim().default('http://127.0.0.1:8000'),
  defaultWorkflowId: z.string().min(1).default('flux2-klein-text-to-image'),
  defaultWorkflows: z.object({
    'image.generate': z.string().min(1).default('flux2-klein-text-to-image'),
    'image.edit': z.string().min(1).default('flux2-klein-image-edit'),
  }).partial().default({
    'image.generate': 'flux2-klein-text-to-image',
    'image.edit': 'flux2-klein-image-edit',
  }),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  connectionCheckIntervalMs: z.number().int().min(3000).max(120000).default(10000),
}).default({
  enabled: false,
  serverUrl: 'http://127.0.0.1:8000',
  defaultWorkflowId: 'flux2-klein-text-to-image',
  defaultWorkflows: {
    'image.generate': 'flux2-klein-text-to-image',
    'image.edit': 'flux2-klein-image-edit',
  },
  requestTimeoutMs: 15000,
  connectionCheckIntervalMs: 10000,
});

export const typedProjectSettingsSchema = z.object({
  startup: projectStartupSettingsSchema.default({ initScript: '' }),
  ui: z.object({ defaultLayout: defaultLayoutSettingSchema.default(null) }).default({ defaultLayout: null }),
  text: projectTextSettingsSchema.default({ defaultFont: null }),
  titleScreen: projectTitleScreenSettingsSchema.default({
    titleImage: null,
    showProjectTitle: true,
    showAuthor: false,
    subtitle: '',
    startLabel: 'Start',
  }),
  app: projectAppSettingsSchema.default({ icon: null }),
  comfyui: projectComfyUiSettingsSchema,
}).passthrough();

export type AssetRecordRef = z.infer<typeof assetRecordRefSchema>;
export type ProjectStartupSettings = z.infer<typeof projectStartupSettingsSchema>;
export type ProjectTextSettings = z.infer<typeof projectTextSettingsSchema>;
export type ProjectTitleScreenSettings = z.infer<typeof projectTitleScreenSettingsSchema>;
export type ProjectAppSettings = z.infer<typeof projectAppSettingsSchema>;
export type ProjectComfyUiSettings = z.infer<typeof projectComfyUiSettingsSchema>;
export type TypedProjectSettings = z.infer<typeof typedProjectSettingsSchema>;

export interface ProjectSettingsDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: ProjectSettingsDiagnostic['severity'] = 'error'): ProjectSettingsDiagnostic {
  return { severity, path, message, category: 'authoring-project-settings' };
}

export function assetRef(assetId: string): AssetRecordRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

export function roomEntrypointRef(roomId: string): ReferenceTarget {
  return { collection: 'rooms', id: roomId };
}

export function parseTypedProjectSettings(value: unknown): TypedProjectSettings {
  return typedProjectSettingsSchema.parse(value ?? {});
}

export function projectSettingsFromProject(project: AuthoringProject): TypedProjectSettings {
  return parseTypedProjectSettings(project.settings);
}

function assetKind(project: AuthoringProject, assetId: string): string | null {
  return parseAssetData(project.assets[assetId]?.data)?.kind ?? null;
}

function validateAssetRef(
  project: AuthoringProject,
  ref: AssetRecordRef | null | undefined,
  path: string,
  expectedKind: 'font' | 'image',
  diagnostics: ProjectSettingsDiagnostic[],
) {
  if (!ref) return;
  const id = ref.$ref.id;
  if (!project.assets[id]) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing asset '${id}'.`));
    return;
  }
  const kind = assetKind(project, id);
  if (kind !== expectedKind) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Asset '${id}' is ${kind ?? 'unknown'}, not ${expectedKind}.`));
  }
}

export function validateTypedProjectSettings(project: AuthoringProject): ProjectSettingsDiagnostic[] {
  const diagnostics: ProjectSettingsDiagnostic[] = [];
  const parsed = typedProjectSettingsSchema.safeParse(project.settings ?? {});
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic(`/settings/${issue.path.map(String).join('/')}`, issue.message));
    }
    return diagnostics;
  }

  const settings = parsed.data;
  if (!project.project.name.trim()) diagnostics.push(diagnostic('/project/name', 'Project title is required.'));
  if (!project.project.version.trim()) diagnostics.push(diagnostic('/project/version', 'Project version is required.'));
  if (project.project.version.trim() && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(project.project.version.trim())) {
    diagnostics.push(diagnostic('/project/version', 'Project version should use a semver-like value such as 0.1.0.', 'warning'));
  }
  if (settings.startup.initScript !== undefined && typeof settings.startup.initScript !== 'string') {
    diagnostics.push(diagnostic('/settings/startup/initScript', 'Startup init script must be a string.'));
  }
  if (settings.ui.defaultLayout && !project.layouts[settings.ui.defaultLayout.$ref.id]) {
    diagnostics.push(diagnostic('/settings/ui/defaultLayout/$ref', `Missing default layout '${settings.ui.defaultLayout.$ref.id}'.`));
  }
  validateAssetRef(project, settings.text.defaultFont, '/settings/text/defaultFont', 'font', diagnostics);
  validateAssetRef(project, settings.titleScreen.titleImage, '/settings/titleScreen/titleImage', 'image', diagnostics);
  validateAssetRef(project, settings.app.icon, '/settings/app/icon', 'image', diagnostics);
  if (settings.comfyui.enabled) {
    try {
      const url = new URL(settings.comfyui.serverUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        diagnostics.push(diagnostic('/settings/comfyui/serverUrl', 'ComfyUI server URL must use http or https.'));
      }
      const host = url.hostname.toLowerCase();
      const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
      if (!localHosts.has(host)) {
        diagnostics.push(diagnostic('/settings/comfyui/serverUrl', 'Remote ComfyUI servers should only be used deliberately.', 'warning'));
      }
    } catch {
      diagnostics.push(diagnostic('/settings/comfyui/serverUrl', 'ComfyUI server URL is invalid.'));
    }
  }
  return diagnostics;
}
