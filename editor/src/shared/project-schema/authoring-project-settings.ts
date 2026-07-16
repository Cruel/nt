import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { exportSettingsSchema } from './authoring-export';
import type { AuthoringProject, ProjectEntrypoint } from './authoring-project';
import { systemLayoutRoleValues, systemLayoutSettingsSchema } from './authoring-layouts';
import { projectPlatformExportSettingsSchema } from './platform-export-contracts';

const assetRecordRefSchema = z.object({
  $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
}).strict();

const fontAssetRefSchema = assetRecordRefSchema.nullable();
const imageAssetRefSchema = assetRecordRefSchema.nullable();

export const projectTextSettingsSchema = z.object({
  defaultFont: fontAssetRefSchema.default(null),
}).strict();

export const projectTitleScreenSettingsSchema = z.object({
  titleImage: imageAssetRefSchema.default(null),
  showProjectTitle: z.boolean().default(true),
  showAuthor: z.boolean().default(false),
  subtitle: z.string().default(''),
  startLabel: z.string().min(1, 'Start label is required.').default('Start'),
}).strict();

const optionalTrimmedString = z.string().trim().min(1).optional();
const positiveBuildNumber = z.number().int().positive();
const identityColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a six-digit hex color.');
const localizedAppIdentitySchema = z.object({
  displayName: optionalTrimmedString,
  shortName: optionalTrimmedString,
  description: optionalTrimmedString,
}).strict();

export const applicationIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
export const applicationIdSchema = z.string().trim().regex(
  applicationIdPattern,
  'Application ID must be a reverse-DNS identifier such as com.example.game.',
);

export const projectAppSettingsSchema = z.object({
  displayName: z.string().trim().min(1, 'Display name is required.'),
  shortName: optionalTrimmedString,
  publisher: optionalTrimmedString,
  copyright: optionalTrimmedString,
  description: z.string().optional(),
  defaultLocale: optionalTrimmedString,
  localized: z.record(z.string(), localizedAppIdentitySchema).default({}),
  applicationId: applicationIdSchema,
  saveNamespace: z.string().trim().min(1, 'Save namespace is required.'),
  versionName: z.string().trim().min(1, 'Version name is required.'),
  buildNumber: positiveBuildNumber.optional(),
  icon: imageAssetRefSchema.default(null),
  iconBackgroundColor: identityColorSchema.optional(),
  accentColor: identityColorSchema.optional(),
  themeColor: identityColorSchema.optional(),
  launchImage: imageAssetRefSchema.default(null),
  launchBackgroundColor: identityColorSchema.optional(),
  desktop: z.object({
    appleBundleId: applicationIdSchema.optional(),
    linuxDesktopId: applicationIdSchema.optional(),
    windowsIdentity: optionalTrimmedString,
    buildNumber: positiveBuildNumber.optional(),
  }).strict().default({}),
  web: z.object({ manifestId: optionalTrimmedString, buildNumber: positiveBuildNumber.optional() }).strict().default({}),
  android: z.object({
    applicationId: applicationIdSchema.optional(),
    versionCode: positiveBuildNumber.optional(),
    allowBackup: z.boolean().optional(),
    isGame: z.boolean().optional(),
  }).strict().default({}),
  lastExportedIdentity: z.object({
    applicationId: applicationIdSchema,
    saveNamespace: z.string().trim().min(1),
  }).strict().optional(),
}).strict();

export const DEFAULT_PROJECT_DISPLAY_SETTINGS = {
  aspectRatio: { width: 16, height: 9 },
  orientation: 'landscape',
  barColor: '#000000',
} as const;
export const MAX_ASPECT_RATIO_COMPONENT = 10_000;

const aspectRatioComponentSchema = z.number().int().positive().max(MAX_ASPECT_RATIO_COMPONENT);
export const projectDisplaySettingsSchema = z.object({
  aspectRatio: z.object({ width: aspectRatioComponentSchema, height: aspectRatioComponentSchema }).strict(),
  orientation: z.enum(['landscape', 'portrait']),
  barColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Bar color must be a six-digit hex color.'),
}).strict();

export type ProjectDisplaySettings = z.infer<typeof projectDisplaySettingsSchema>;

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function normalizeProjectDisplaySettings(value: unknown): ProjectDisplaySettings {
  const parsed = projectDisplaySettingsSchema.parse(value ?? DEFAULT_PROJECT_DISPLAY_SETTINGS);
  const divisor = greatestCommonDivisor(parsed.aspectRatio.width, parsed.aspectRatio.height);
  return {
    aspectRatio: {
      width: parsed.aspectRatio.width / divisor,
      height: parsed.aspectRatio.height / divisor,
    },
    orientation: parsed.orientation,
    barColor: parsed.barColor.toLowerCase(),
  };
}

export const typedProjectSettingsSchema = z.object({
  ui: z.object({ systemLayouts: systemLayoutSettingsSchema }).strict().default({ systemLayouts: {} }),
  text: projectTextSettingsSchema.default({ defaultFont: null }),
  titleScreen: projectTitleScreenSettingsSchema.default({
    titleImage: null,
    showProjectTitle: true,
    showAuthor: false,
    subtitle: '',
    startLabel: 'Start',
  }),
  app: projectAppSettingsSchema.optional(),
  display: projectDisplaySettingsSchema.default(DEFAULT_PROJECT_DISPLAY_SETTINGS),
  export: exportSettingsSchema.optional(),
  platformExport: projectPlatformExportSettingsSchema.optional(),
}).strict();

export type AssetRecordRef = z.infer<typeof assetRecordRefSchema>;
export type ProjectTextSettings = z.infer<typeof projectTextSettingsSchema>;
export type ProjectTitleScreenSettings = z.infer<typeof projectTitleScreenSettingsSchema>;
export type ProjectAppSettings = z.infer<typeof projectAppSettingsSchema>;
export type TypedProjectSettings = z.infer<typeof typedProjectSettingsSchema> & { app: ProjectAppSettings };

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

export function roomEntrypointRef(roomId: string): ProjectEntrypoint {
  return { kind: 'room', id: roomId };
}

export function parseTypedProjectSettings(value: unknown): z.infer<typeof typedProjectSettingsSchema> {
  return typedProjectSettingsSchema.parse(value ?? {});
}

function normalizeProjectAppInput(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  for (const key of [
    'shortName', 'publisher', 'copyright', 'description', 'defaultLocale',
    'iconBackgroundColor', 'accentColor', 'themeColor', 'launchBackgroundColor',
  ]) {
    if (normalized[key] === null) delete normalized[key];
  }
  return normalized;
}

export function projectSettingsFromProject(project: AuthoringProject): TypedProjectSettings {
  const raw = project.settings as Record<string, unknown>;
  const rawApp: Record<string, unknown> = typeof raw.app === 'object' && raw.app !== null && !Array.isArray(raw.app)
    ? raw.app as Record<string, unknown>
    : {};
  const settings = parseTypedProjectSettings({ ...raw, app: { ...defaultProjectAppIdentity(project), ...normalizeProjectAppInput(rawApp) } });
  return {
    ...settings,
    app: projectAppSettingsSchema.parse(settings.app ?? defaultProjectAppIdentity(project)),
  } as TypedProjectSettings;
}

export function defaultProjectAppIdentity(project: Pick<AuthoringProject, 'project'>): ProjectAppSettings {
  const id = project.project.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
  const applicationId = `org.noveltea.${id}`;
  return {
    displayName: project.project.name || 'Untitled Game',
    description: project.project.description || undefined,
    publisher: project.project.author || undefined,
    localized: {},
    applicationId,
    saveNamespace: applicationId,
    versionName: project.project.version || '0.1.0',
    icon: null,
    launchImage: null,
    desktop: {},
    web: {},
    android: {},
  };
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
  const raw = project.settings as Record<string, unknown>;
  const rawApp: Record<string, unknown> = typeof raw.app === 'object' && raw.app !== null && !Array.isArray(raw.app)
    ? raw.app as Record<string, unknown>
    : {};
  const parsed = typedProjectSettingsSchema.safeParse({ ...raw, app: { ...defaultProjectAppIdentity(project), ...normalizeProjectAppInput(rawApp) } });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic(`/settings/${issue.path.map(String).join('/')}`, issue.message));
    }
    return diagnostics;
  }

  const settings = projectSettingsFromProject(project);
  if (!project.project.name.trim()) diagnostics.push(diagnostic('/project/name', 'Project title is required.'));
  if (!project.project.version.trim()) diagnostics.push(diagnostic('/project/version', 'Project version is required.'));
  if (project.project.version.trim() && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(project.project.version.trim())) {
    diagnostics.push(diagnostic('/project/version', 'Project version should use a semver-like value such as 0.1.0.', 'warning'));
  }
  for (const role of systemLayoutRoleValues) {
    const ref = settings.ui.systemLayouts[role];
    if (ref && !project.layouts[ref.$ref.id]) {
      diagnostics.push(diagnostic(`/settings/ui/systemLayouts/${role}/$ref`, `Missing ${role} system layout '${ref.$ref.id}'.`));
    }
  }
  validateAssetRef(project, settings.text.defaultFont, '/settings/text/defaultFont', 'font', diagnostics);
  validateAssetRef(project, settings.titleScreen.titleImage, '/settings/titleScreen/titleImage', 'image', diagnostics);
  validateAssetRef(project, settings.app.icon, '/settings/app/icon', 'image', diagnostics);
  validateAssetRef(project, settings.app.launchImage, '/settings/app/launchImage', 'image', diagnostics);
  const localeTags = [settings.app.defaultLocale, ...Object.keys(settings.app.localized)].filter((tag): tag is string => Boolean(tag));
  for (const locale of localeTags) {
    try {
      const normalized = new Intl.Locale(locale).toString();
      if (normalized !== locale) diagnostics.push(diagnostic(`/settings/app/localized/${locale}`, `Locale tag should be normalized as '${normalized}'.`, 'warning'));
    } catch {
      diagnostics.push(diagnostic('/settings/app/defaultLocale', `Invalid BCP 47 locale tag '${locale}'.`));
    }
  }
  const recorded = settings.app.lastExportedIdentity;
  if (recorded && recorded.applicationId !== settings.app.applicationId) {
    diagnostics.push(diagnostic('/settings/app/applicationId', `Application ID changed after export from '${recorded.applicationId}'; installed-app identity will change.`, 'warning'));
  }
  if (recorded && recorded.saveNamespace !== settings.app.saveNamespace) {
    diagnostics.push(diagnostic('/settings/app/saveNamespace', `Save namespace changed after export from '${recorded.saveNamespace}'; existing save data will not move automatically.`, 'warning'));
  }
  return diagnostics;
}
