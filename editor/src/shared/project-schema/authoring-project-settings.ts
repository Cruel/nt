import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { exportSettingsSchema } from './authoring-export';
import type { AuthoringProject, ProjectEntrypoint } from './authoring-project';
import { systemLayoutRoleValues, systemLayoutSettingsSchema } from './authoring-layouts';
import { projectPlatformExportSettingsSchema } from './platform-export-contracts';
import {
  roomNavigationTransitionSchema,
  validateRoomNavigationTransition,
} from './authoring-rooms';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationBoundariesForAuthoringPath,
  type ProjectValidationDiagnostic,
} from './project-validation';

const assetRecordRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();

const fontAssetRefSchema = assetRecordRefSchema.nullable();
const imageAssetRefSchema = assetRecordRefSchema.nullable();

export const projectTextSettingsSchema = z
  .object({
    defaultFont: fontAssetRefSchema.default(null),
  })
  .strict();

export const projectTitleScreenSettingsSchema = z
  .object({
    titleImage: imageAssetRefSchema.default(null),
    showProjectTitle: z.boolean().default(true),
    showAuthor: z.boolean().default(false),
    subtitle: z.string().default(''),
    startLabel: z.string().min(1, 'Start label is required.').default('Start'),
  })
  .strict();

const optionalTrimmedString = z.string().trim().min(1).optional();
const positiveBuildNumber = z.number().int().positive();
const identityColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a six-digit hex color.');
const localizedAppIdentitySchema = z
  .object({
    displayName: optionalTrimmedString,
    shortName: optionalTrimmedString,
    description: optionalTrimmedString,
  })
  .strict();

export const applicationIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
export const applicationIdSchema = z
  .string()
  .trim()
  .regex(
    applicationIdPattern,
    'Application ID must be a reverse-DNS identifier such as com.example.game.',
  );

export const projectAppSettingsSchema = z
  .object({
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
    desktop: z
      .object({
        appleBundleId: applicationIdSchema.optional(),
        linuxDesktopId: applicationIdSchema.optional(),
        windowsIdentity: optionalTrimmedString,
        buildNumber: positiveBuildNumber.optional(),
      })
      .strict()
      .default({}),
    web: z
      .object({ manifestId: optionalTrimmedString, buildNumber: positiveBuildNumber.optional() })
      .strict()
      .default({}),
    android: z
      .object({
        applicationId: applicationIdSchema.optional(),
        versionCode: positiveBuildNumber.optional(),
        allowBackup: z.boolean().optional(),
        isGame: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const DEFAULT_PROJECT_DISPLAY_SETTINGS = {
  referenceResolution: { width: 1920, height: 1080 },
  worldRasterPolicy: 'capped',
  barColor: '#000000',
} as const;

export const DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS = {
  uiScale: { enabled: true, minimum: 1, maximum: 2 },
  textScale: { enabled: true, minimum: 1, maximum: 2 },
} as const;

export type ProjectWorldRasterPolicy = 'capped' | 'native';

const projectWorldRasterPolicySchema = z
  .string()
  .refine(
    (value): value is ProjectWorldRasterPolicy => value === 'capped' || value === 'native',
    "World raster policy must be 'capped' or 'native'.",
  );

export const projectAccessibilityScalePolicySchema = z
  .object({
    enabled: z.boolean(),
    minimum: z.number(),
    maximum: z.number(),
  })
  .strict();

export const projectAccessibilitySettingsSchema = z
  .object({
    uiScale: projectAccessibilityScalePolicySchema.default(
      DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS.uiScale,
    ),
    textScale: projectAccessibilityScalePolicySchema.default(
      DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS.textScale,
    ),
  })
  .strict();

export const projectDisplaySettingsSchema = z
  .object({
    referenceResolution: z.object({ width: z.number(), height: z.number() }).strict(),
    worldRasterPolicy: projectWorldRasterPolicySchema,
    barColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Bar color must be a six-digit hex color.'),
  })
  .strict();

export type ProjectDisplaySettings = z.infer<typeof projectDisplaySettingsSchema>;
export type ProjectAccessibilityScalePolicy = z.infer<typeof projectAccessibilityScalePolicySchema>;
export type ProjectAccessibilitySettings = z.infer<typeof projectAccessibilitySettingsSchema>;

export interface DerivedProjectDisplayGeometry {
  aspectRatio: { width: number; height: number };
  orientation: 'landscape' | 'portrait';
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function deriveProjectDisplayGeometry(referenceResolution: {
  width: number;
  height: number;
}): DerivedProjectDisplayGeometry | null {
  const { width, height } = referenceResolution;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
    return null;
  const divisor = greatestCommonDivisor(width, height);
  return {
    aspectRatio: {
      width: width / divisor,
      height: height / divisor,
    },
    orientation: width >= height ? 'landscape' : 'portrait',
  };
}

/**
 * Temporary compatibility projection for pre-2D compiled/export/preview contracts where
 * orientation is stored separately from a landscape-normalized aspect ratio.
 */
export function deriveLegacyProjectDisplayGeometry(referenceResolution: {
  width: number;
  height: number;
}): DerivedProjectDisplayGeometry | null {
  const geometry = deriveProjectDisplayGeometry(referenceResolution);
  if (!geometry || geometry.orientation === 'landscape') return geometry;
  return {
    aspectRatio: {
      width: geometry.aspectRatio.height,
      height: geometry.aspectRatio.width,
    },
    orientation: geometry.orientation,
  };
}

export function effectiveProjectAccessibilityScale(
  policy: ProjectAccessibilityScalePolicy,
  requestedValue = 1,
): number {
  if (!policy.enabled) return 1;
  if (!Number.isFinite(requestedValue)) return 1;
  return Math.min(policy.maximum, Math.max(policy.minimum, requestedValue));
}

export const typedProjectSettingsSchema = z
  .object({
    ui: z
      .object({ systemLayouts: systemLayoutSettingsSchema })
      .strict()
      .default({ systemLayouts: {} }),
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
    accessibility: projectAccessibilitySettingsSchema.default(
      DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS,
    ),
    presentation: z
      .object({
        roomNavigationTransition: roomNavigationTransitionSchema,
      })
      .strict()
      .default({
        roomNavigationTransition: { kind: 'cut', durationMs: 0, color: null, skippable: true },
      }),
    export: exportSettingsSchema.optional(),
    platformExport: projectPlatformExportSettingsSchema.optional(),
  })
  .strict();

export type AssetRecordRef = z.infer<typeof assetRecordRefSchema>;
export type ProjectTextSettings = z.infer<typeof projectTextSettingsSchema>;
export type ProjectTitleScreenSettings = z.infer<typeof projectTitleScreenSettingsSchema>;
export type ProjectAppSettings = z.infer<typeof projectAppSettingsSchema>;
export type TypedProjectSettings = z.infer<typeof typedProjectSettingsSchema> & {
  app: ProjectAppSettings;
};

export type ProjectSettingsDiagnostic = ProjectValidationDiagnostic;

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function diagnostic(
  code: string,
  path: string,
  message: string,
  severity: ProjectSettingsDiagnostic['severity'] = 'error',
): ProjectSettingsDiagnostic {
  return createProjectValidationDiagnostic({
    code,
    severity,
    path,
    message,
    category: 'Project settings',
    boundaries: projectValidationBoundariesForAuthoringPath(path),
    ownerPaths: [path],
  });
}

export function assetRef(assetId: string): AssetRecordRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

export function roomEntrypointRef(roomId: string): ProjectEntrypoint {
  return { kind: 'room', id: roomId };
}

export function parseTypedProjectSettings(
  value: unknown,
): z.infer<typeof typedProjectSettingsSchema> {
  return typedProjectSettingsSchema.parse(value ?? {});
}

function normalizeProjectAppInput(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  for (const key of [
    'shortName',
    'publisher',
    'copyright',
    'description',
    'defaultLocale',
    'iconBackgroundColor',
    'accentColor',
    'themeColor',
    'launchBackgroundColor',
  ]) {
    if (normalized[key] === null) delete normalized[key];
  }
  return normalized;
}

export function projectSettingsFromProject(project: AuthoringProject): TypedProjectSettings {
  const raw = project.settings as Record<string, unknown>;
  const rawApp: Record<string, unknown> =
    typeof raw.app === 'object' && raw.app !== null && !Array.isArray(raw.app)
      ? (raw.app as Record<string, unknown>)
      : {};
  const settings = parseTypedProjectSettings({
    ...raw,
    app: { ...defaultProjectAppIdentity(project), ...normalizeProjectAppInput(rawApp) },
  });
  return {
    ...settings,
    app: projectAppSettingsSchema.parse(settings.app ?? defaultProjectAppIdentity(project)),
  } as TypedProjectSettings;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Builds the Project Settings editing view without normalizing away present semantic errors.
 * Structural decoding guarantees the value shapes used here; defaults are applied only when a
 * field is absent. Persisted invalid strings and numbers remain visible and editable.
 */
export function projectSettingsForEditing(project: AuthoringProject): TypedProjectSettings {
  const raw = objectValue(project.settings);
  const rawUi = objectValue(raw.ui);
  const rawText = objectValue(raw.text);
  const rawTitleScreen = objectValue(raw.titleScreen);
  const rawApp = objectValue(raw.app);
  const rawDisplay = objectValue(raw.display);
  const rawReferenceResolution = objectValue(rawDisplay.referenceResolution);
  const rawAccessibility = objectValue(raw.accessibility);
  const rawUiScale = objectValue(rawAccessibility.uiScale);
  const rawTextScale = objectValue(rawAccessibility.textScale);
  const rawPresentation = objectValue(raw.presentation);
  const rawTransition = objectValue(rawPresentation.roomNavigationTransition);
  const defaults = defaultProjectAppIdentity(project);
  const app = {
    ...defaults,
    ...rawApp,
    localized: { ...objectValue(rawApp.localized) },
    desktop: { ...objectValue(rawApp.desktop) },
    web: { ...objectValue(rawApp.web) },
    android: { ...objectValue(rawApp.android) },
    icon: Object.prototype.hasOwnProperty.call(rawApp, 'icon') ? rawApp.icon : defaults.icon,
    launchImage: Object.prototype.hasOwnProperty.call(rawApp, 'launchImage')
      ? rawApp.launchImage
      : defaults.launchImage,
  };
  return {
    ...raw,
    ui: {
      ...rawUi,
      systemLayouts: { ...objectValue(rawUi.systemLayouts) },
    },
    text: {
      ...rawText,
      defaultFont: Object.prototype.hasOwnProperty.call(rawText, 'defaultFont')
        ? rawText.defaultFont
        : null,
    },
    titleScreen: {
      titleImage: null,
      showProjectTitle: true,
      showAuthor: false,
      subtitle: '',
      startLabel: 'Start',
      ...rawTitleScreen,
    },
    app,
    display: {
      ...DEFAULT_PROJECT_DISPLAY_SETTINGS,
      ...rawDisplay,
      referenceResolution: {
        ...DEFAULT_PROJECT_DISPLAY_SETTINGS.referenceResolution,
        ...rawReferenceResolution,
      },
    },
    accessibility: {
      ...rawAccessibility,
      uiScale: {
        ...DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS.uiScale,
        ...rawUiScale,
      },
      textScale: {
        ...DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS.textScale,
        ...rawTextScale,
      },
    },
    presentation: {
      ...rawPresentation,
      roomNavigationTransition: {
        kind: 'cut',
        durationMs: 0,
        color: null,
        skippable: true,
        ...rawTransition,
      },
    },
  } as unknown as TypedProjectSettings;
}

export function defaultProjectAppIdentity(
  project: Pick<AuthoringProject, 'project'>,
): ProjectAppSettings {
  const id =
    project.project.id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'game';
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
    diagnostics.push(
      diagnostic('authoring.settings.asset.missing', `${path}/$ref`, `Missing asset '${id}'.`),
    );
    return;
  }
  const kind = assetKind(project, id);
  if (kind !== expectedKind) {
    diagnostics.push(
      diagnostic(
        'authoring.settings.asset.kind-mismatch',
        `${path}/$ref`,
        `Asset '${id}' is ${kind ?? 'unknown'}, not ${expectedKind}.`,
      ),
    );
  }
}

function validateDisplayAndAccessibilitySettings(
  settings: TypedProjectSettings,
  diagnostics: ProjectSettingsDiagnostic[],
) {
  for (const field of ['width', 'height'] as const) {
    const value = settings.display.referenceResolution[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      diagnostics.push(
        diagnostic(
          'authoring.settings.display.reference-resolution.invalid',
          `/settings/display/referenceResolution/${field}`,
          `Reference resolution ${field} must be a positive integer.`,
        ),
      );
    }
  }

  for (const scale of ['uiScale', 'textScale'] as const) {
    const policy = settings.accessibility[scale];
    const basePath = `/settings/accessibility/${scale}`;
    for (const field of ['minimum', 'maximum'] as const) {
      const value = policy[field];
      if (!Number.isFinite(value) || value <= 0) {
        diagnostics.push(
          diagnostic(
            'authoring.settings.accessibility.scale.positive',
            `${basePath}/${field}`,
            `${field === 'minimum' ? 'Minimum' : 'Maximum'} scale must be finite and positive.`,
          ),
        );
      }
    }
    if (
      Number.isFinite(policy.minimum) &&
      Number.isFinite(policy.maximum) &&
      policy.minimum > policy.maximum
    ) {
      diagnostics.push(
        diagnostic(
          'authoring.settings.accessibility.scale.range-order',
          `${basePath}/maximum`,
          'Maximum scale must be greater than or equal to minimum scale.',
        ),
      );
    }
    if (policy.enabled && Number.isFinite(policy.minimum) && policy.minimum > 1) {
      diagnostics.push(
        diagnostic(
          'authoring.settings.accessibility.scale.default-below-minimum',
          `${basePath}/minimum`,
          'An enabled scale range must include the default value 1.0.',
        ),
      );
    }
    if (policy.enabled && Number.isFinite(policy.maximum) && policy.maximum < 1) {
      diagnostics.push(
        diagnostic(
          'authoring.settings.accessibility.scale.default-above-maximum',
          `${basePath}/maximum`,
          'An enabled scale range must include the default value 1.0.',
        ),
      );
    }
  }
}

export function validateTypedProjectSettings(
  project: AuthoringProject,
): ProjectSettingsDiagnostic[] {
  const diagnostics: ProjectSettingsDiagnostic[] = [];
  if (!project.project.name.trim())
    diagnostics.push(
      diagnostic('authoring.project.name.required', '/project/name', 'Project title is required.'),
    );
  if (!project.project.version.trim())
    diagnostics.push(
      diagnostic(
        'authoring.project.version.required',
        '/project/version',
        'Project version is required.',
      ),
    );
  if (
    project.project.version.trim() &&
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(project.project.version.trim())
  ) {
    diagnostics.push(
      diagnostic(
        'authoring.project.version.semver-recommended',
        '/project/version',
        'Project version should use a semver-like value such as 0.1.0.',
        'warning',
      ),
    );
  }
  const raw = project.settings as Record<string, unknown>;
  const rawApp: Record<string, unknown> =
    typeof raw.app === 'object' && raw.app !== null && !Array.isArray(raw.app)
      ? (raw.app as Record<string, unknown>)
      : {};
  const parsed = typedProjectSettingsSchema.safeParse({
    ...raw,
    app: { ...defaultProjectAppIdentity(project), ...normalizeProjectAppInput(rawApp) },
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(
        diagnostic(
          `authoring.settings.schema.${issue.code}`,
          `/settings/${issue.path.map(String).map(escapeJsonPointerSegment).join('/')}`,
          issue.message,
        ),
      );
    }
    const structurallyUnsafe = parsed.error.issues.some((issue) =>
      ['invalid_type', 'invalid_union', 'invalid_key', 'invalid_element'].includes(issue.code),
    );
    if (structurallyUnsafe) return collectProjectValidationDiagnostics(diagnostics);
  }

  const settings = parsed.success
    ? projectSettingsFromProject(project)
    : projectSettingsForEditing(project);
  validateDisplayAndAccessibilitySettings(settings, diagnostics);
  const transitionDiagnostics: Array<{
    severity: 'error' | 'warning' | 'info';
    path: string;
    message: string;
    category?: string;
  }> = [];
  validateRoomNavigationTransition(
    settings.presentation.roomNavigationTransition,
    '/settings/presentation/roomNavigationTransition',
    transitionDiagnostics,
  );
  diagnostics.push(
    ...classifyProjectValidationDiagnostics(transitionDiagnostics, {
      producer: 'authoring',
      codePrefix: 'authoring.settings.presentation',
    }),
  );
  for (const role of systemLayoutRoleValues) {
    const ref = settings.ui.systemLayouts[role];
    if (ref && !project.layouts[ref.$ref.id]) {
      diagnostics.push(
        diagnostic(
          'authoring.settings.ui.system-layout.missing',
          `/settings/ui/systemLayouts/${role}/$ref`,
          `Missing ${role} system layout '${ref.$ref.id}'.`,
        ),
      );
    }
  }
  validateAssetRef(
    project,
    settings.text.defaultFont,
    '/settings/text/defaultFont',
    'font',
    diagnostics,
  );
  validateAssetRef(
    project,
    settings.titleScreen.titleImage,
    '/settings/titleScreen/titleImage',
    'image',
    diagnostics,
  );
  validateAssetRef(project, settings.app.icon, '/settings/app/icon', 'image', diagnostics);
  validateAssetRef(
    project,
    settings.app.launchImage,
    '/settings/app/launchImage',
    'image',
    diagnostics,
  );
  const localeTags = [
    ...(settings.app.defaultLocale
      ? [{ locale: settings.app.defaultLocale, path: '/settings/app/defaultLocale' }]
      : []),
    ...Object.keys(settings.app.localized).map((locale) => ({
      locale,
      path: `/settings/app/localized/${escapeJsonPointerSegment(locale)}`,
    })),
  ];
  for (const { locale, path } of localeTags) {
    try {
      const normalized = new Intl.Locale(locale).toString();
      if (normalized !== locale)
        diagnostics.push(
          diagnostic(
            'authoring.settings.app.locale.not-normalized',
            path,
            `Locale tag should be normalized as '${normalized}'.`,
            'warning',
          ),
        );
    } catch {
      diagnostics.push(
        diagnostic(
          'authoring.settings.app.locale.invalid',
          path,
          `Invalid BCP 47 locale tag '${locale}'.`,
        ),
      );
    }
  }
  return collectProjectValidationDiagnostics(diagnostics);
}

export function validateProjectSettingsAuthoringState(
  project: AuthoringProject,
): ProjectSettingsDiagnostic[] {
  const diagnostics = [...validateTypedProjectSettings(project)];
  const entrypoint = project.entrypoint;
  if (entrypoint) {
    const collection = `${entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues';
    if (!project[collection][entrypoint.id]) {
      diagnostics.push(
        diagnostic(
          'authoring.entrypoint.target-missing',
          '/entrypoint',
          `Missing ${entrypoint.kind} '${entrypoint.id}'.`,
        ),
      );
    }
  }
  return collectProjectValidationDiagnostics(diagnostics);
}
