import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

export const layoutKindValues = ['document', 'fragment'] as const;

export const layoutTargetValues = [
  'default-ui',
  'dialogue-ui',
  'scene-overlay',
  'room-overlay',
  'menu-ui',
  'custom-overlay',
] as const;

export const layoutSourceModeValues = ['inline', 'asset'] as const;
export const layoutPreviewBackgroundValues = ['transparent', 'checker', 'dark', 'light'] as const;
export const systemLayoutRoleValues = [
  'title',
  'game-hud',
  'pause-menu',
  'save-menu',
  'load-menu',
  'settings-menu',
  'text-log',
  'modal',
  'debug-overlay',
] as const;

export type LayoutKind = (typeof layoutKindValues)[number];
export type LayoutTarget = (typeof layoutTargetValues)[number];
export type LayoutSourceMode = (typeof layoutSourceModeValues)[number];
export type LayoutPreviewBackground = (typeof layoutPreviewBackgroundValues)[number];
export type SystemLayoutRole = (typeof systemLayoutRoleValues)[number];

export const layoutAssetRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const layoutMaterialRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('materials'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const layoutRecordRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('layouts'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const layoutSourceDataSchema = z
  .object({
    sourceMode: z.enum(layoutSourceModeValues).default('inline'),
    sourceText: z.string().default(''),
    sourceAsset: layoutAssetRefSchema.nullable().default(null),
  })
  .strict();

export const layoutDependencyDataSchema = z
  .object({
    images: z.array(layoutAssetRefSchema).default([]),
    fonts: z.array(layoutAssetRefSchema).default([]),
    stylesheets: z.array(layoutAssetRefSchema).default([]),
    materials: z.array(layoutMaterialRefSchema).default([]),
    scripts: z.array(layoutAssetRefSchema).default([]),
  })
  .strict();

export const layoutScriptDataSchema = z
  .object({
    enabled: z.boolean().default(true),
    namespace: z.string().trim().optional(),
  })
  .strict();

export const layoutMountDataSchema = z
  .object({
    defaultParent: z.string().trim().optional(),
    scopedStyles: z.boolean().default(true),
  })
  .strict();

export const layoutDataSchema = z
  .object({
    kind: z.literal('layout').default('layout'),
    layoutKind: z.enum(layoutKindValues).default('document'),
    displayName: z.string().optional(),
    target: z.enum(layoutTargetValues).default('default-ui'),
    rml: layoutSourceDataSchema.default({
      sourceMode: 'inline',
      sourceText: '',
      sourceAsset: null,
    }),
    rcss: layoutSourceDataSchema.default({
      sourceMode: 'inline',
      sourceText: '',
      sourceAsset: null,
    }),
    lua: layoutSourceDataSchema.default({
      sourceMode: 'inline',
      sourceText: '',
      sourceAsset: null,
    }),
    script: layoutScriptDataSchema.default({ enabled: true }),
    mount: layoutMountDataSchema.default({ scopedStyles: true }),
    dependencies: layoutDependencyDataSchema.default({
      images: [],
      fonts: [],
      stylesheets: [],
      materials: [],
      scripts: [],
    }),
    sampleState: z.record(z.string(), z.json()).default({}),
    preview: z
      .object({
        width: z.number().int().min(160).max(7680).default(1280),
        height: z.number().int().min(90).max(4320).default(720),
        background: z.enum(layoutPreviewBackgroundValues).default('dark'),
      })
      .strict()
      .default({ width: 1280, height: 720, background: 'dark' }),
  })
  .strict();

export const systemLayoutSettingsSchema = z
  .object({
    title: layoutRecordRefSchema.nullable().optional(),
    'game-hud': layoutRecordRefSchema.nullable().optional(),
    'pause-menu': layoutRecordRefSchema.nullable().optional(),
    'save-menu': layoutRecordRefSchema.nullable().optional(),
    'load-menu': layoutRecordRefSchema.nullable().optional(),
    'settings-menu': layoutRecordRefSchema.nullable().optional(),
    'text-log': layoutRecordRefSchema.nullable().optional(),
    modal: layoutRecordRefSchema.nullable().optional(),
    'debug-overlay': layoutRecordRefSchema.nullable().optional(),
  })
  .strict()
  .default({});

export type LayoutAssetRef = z.infer<typeof layoutAssetRefSchema>;
export type LayoutMaterialRef = z.infer<typeof layoutMaterialRefSchema>;
export type LayoutRecordRef = z.infer<typeof layoutRecordRefSchema>;
export type LayoutSourceData = z.infer<typeof layoutSourceDataSchema>;
export type LayoutDependencyData = z.infer<typeof layoutDependencyDataSchema>;
export type LayoutScriptData = z.infer<typeof layoutScriptDataSchema>;
export type LayoutMountData = z.infer<typeof layoutMountDataSchema>;
export type LayoutData = z.infer<typeof layoutDataSchema>;
export type SystemLayoutSettings = z.infer<typeof systemLayoutSettingsSchema>;

export interface LayoutSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

const DEFAULT_RML_DOCUMENT_SOURCE = String.raw`<rml>
<head>
  <title>Default UI</title>
</head>
<body>
  <div class="noveltea-layout-preview">
    <h1>NovelTea Layout</h1>
    <p>Edit this RML, RCSS, and Lua to build runtime UI.</p>
    <button id="layout-preview-counter" onclick="layout_preview.on_click(event, element, document)">Clicked 0 times</button>
  </div>
</body>
</rml>
`;

const DEFAULT_RML_FRAGMENT_SOURCE = String.raw`<div class="noveltea-layout-preview">
  <h1>NovelTea Fragment</h1>
  <p>This reusable fragment is mounted into an internal preview host.</p>
  <button id="layout-preview-counter" onclick="layout_preview.on_click(event, element, document)">Clicked 0 times</button>
</div>
`;

const DEFAULT_RCSS_SOURCE = String.raw`.noveltea-layout-preview {
  margin: 48px;
  padding: 24px;
  background-color: rgba(15, 23, 42, 214);
  border-radius: 12px;
}
`;

const DEFAULT_LUA_SOURCE = String.raw`layout_preview = layout_preview or {}
layout_preview.click_count = layout_preview.click_count or 0

function layout_preview.on_click(event, element, document)
  layout_preview.click_count = layout_preview.click_count + 1
  element.inner_rml = 'Clicked ' .. layout_preview.click_count .. ' times'
end
`;

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): LayoutSchemaDiagnostic {
  return { severity, path, message, category: 'Layouts' };
}

function refId(ref: LayoutAssetRef | LayoutMaterialRef | LayoutRecordRef): string {
  return ref.$ref.id;
}

function assetExtension(project: AuthoringProject, assetId: string): string | null {
  const data = parseAssetData(project.assets[assetId]?.data);
  return data?.extension?.toLowerCase() ?? null;
}

function assetKind(project: AuthoringProject, assetId: string): string | null {
  return parseAssetData(project.assets[assetId]?.data)?.kind ?? null;
}

function pathJoin(path: string, segment: string) {
  return `${path}/${segment}`;
}

function sourceIsEmpty(source: LayoutSourceData): boolean {
  return source.sourceMode === 'inline' && source.sourceText.trim().length === 0;
}

function validateSourceAsset(
  project: AuthoringProject,
  source: LayoutSourceData,
  path: string,
  expected: 'rml' | 'rcss' | 'lua',
  diagnostics: LayoutSchemaDiagnostic[],
) {
  if (source.sourceMode === 'inline') {
    if (expected === 'rml' && source.sourceText.trim().length === 0) {
      diagnostics.push(
        diagnostic(pathJoin(path, 'sourceText'), 'Inline RML source cannot be empty.'),
      );
    } else if (expected === 'rcss' && source.sourceText.trim().length === 0) {
      diagnostics.push(
        diagnostic(pathJoin(path, 'sourceText'), 'Inline RCSS source is empty.', 'warning'),
      );
    }
    return;
  }

  if (!source.sourceAsset) {
    diagnostics.push(
      diagnostic(
        pathJoin(path, 'sourceAsset'),
        `${expected.toUpperCase()} asset source is required when source mode is asset.`,
      ),
    );
    return;
  }

  const assetId = refId(source.sourceAsset);
  if (!project.assets[assetId]) {
    diagnostics.push(
      diagnostic(
        pathJoin(path, 'sourceAsset/$ref'),
        `Missing ${expected.toUpperCase()} source asset '${assetId}'.`,
      ),
    );
    return;
  }

  const extension = assetExtension(project, assetId);
  const kind = assetKind(project, assetId);
  if (expected === 'rml') {
    if (extension && !['.rml', 'rml'].includes(extension)) {
      diagnostics.push(
        diagnostic(
          pathJoin(path, 'sourceAsset/$ref'),
          `RML source asset '${assetId}' has extension '${extension}'.`,
          'warning',
        ),
      );
    }
  } else if (expected === 'rcss') {
    if (extension && !['.rcss', 'rcss', '.css', 'css'].includes(extension)) {
      diagnostics.push(
        diagnostic(
          pathJoin(path, 'sourceAsset/$ref'),
          `RCSS source asset '${assetId}' has extension '${extension}'.`,
          'warning',
        ),
      );
    }
  } else if (extension && !['.lua', 'lua'].includes(extension)) {
    diagnostics.push(
      diagnostic(
        pathJoin(path, 'sourceAsset/$ref'),
        `Lua source asset '${assetId}' has extension '${extension}'.`,
        'warning',
      ),
    );
  }
  if (kind && !['text', 'data', 'script', 'shader-source'].includes(kind)) {
    diagnostics.push(
      diagnostic(
        pathJoin(path, 'sourceAsset/$ref'),
        `Source asset '${assetId}' is ${kind}, not text-like.`,
        'warning',
      ),
    );
  }
}

function validateRmlShape(data: LayoutData, base: string, diagnostics: LayoutSchemaDiagnostic[]) {
  if (data.rml.sourceMode !== 'inline' || sourceIsEmpty(data.rml)) return;
  const text = data.rml.sourceText.toLowerCase();
  const hasDocumentTags =
    /<\s*rml[\s>]/.test(text) || /<\s*head[\s>]/.test(text) || /<\s*body[\s>]/.test(text);
  if (data.layoutKind === 'fragment' && hasDocumentTags) {
    diagnostics.push(
      diagnostic(
        `${base}/rml/sourceText`,
        'Fragment layout RML should not include <rml>, <head>, or <body> tags.',
        'warning',
      ),
    );
  }
  if (data.layoutKind === 'document') {
    if (!/<\s*rml[\s>]/.test(text))
      diagnostics.push(
        diagnostic(
          `${base}/rml/sourceText`,
          'Document layout RML should include an <rml> root tag.',
          'warning',
        ),
      );
    if (!/<\s*body[\s>]/.test(text))
      diagnostics.push(
        diagnostic(
          `${base}/rml/sourceText`,
          'Document layout RML should include a <body> tag.',
          'warning',
        ),
      );
  }
}

function validateScriptMetadata(
  data: LayoutData,
  base: string,
  diagnostics: LayoutSchemaDiagnostic[],
) {
  const namespace = data.script.namespace?.trim();
  if (namespace && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(namespace)) {
    diagnostics.push(
      diagnostic(
        `${base}/script/namespace`,
        'Lua namespace must be a dot-separated Lua identifier path.',
        'warning',
      ),
    );
  }
  if (
    !data.script.enabled &&
    data.lua.sourceMode === 'inline' &&
    data.lua.sourceText.trim().length > 0
  ) {
    diagnostics.push(
      diagnostic(
        `${base}/script/enabled`,
        'Lua source is present but script execution is disabled.',
        'info',
      ),
    );
  }
}

function validateAssetRefs(
  project: AuthoringProject,
  refs: LayoutAssetRef[],
  path: string,
  expectedKind: 'image' | 'font' | 'stylesheet' | 'script',
  diagnostics: LayoutSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const id = refId(ref);
    const refPath = `${path}/${index}/$ref`;
    if (seen.has(id))
      diagnostics.push(
        diagnostic(refPath, `Duplicate ${expectedKind} dependency '${id}'.`, 'warning'),
      );
    seen.add(id);
    const record = project.assets[id];
    if (!record) {
      diagnostics.push(diagnostic(refPath, `Missing asset '${id}'.`));
      return;
    }
    const kind = assetKind(project, id);
    const extension = assetExtension(project, id);
    if (expectedKind === 'image' && kind && kind !== 'image')
      diagnostics.push(diagnostic(refPath, `Asset '${id}' is ${kind}, not image.`, 'warning'));
    if (expectedKind === 'font' && kind && kind !== 'font')
      diagnostics.push(diagnostic(refPath, `Asset '${id}' is ${kind}, not font.`, 'warning'));
    if (
      expectedKind === 'stylesheet' &&
      extension &&
      !['.rcss', 'rcss', '.css', 'css'].includes(extension)
    ) {
      diagnostics.push(
        diagnostic(refPath, `Stylesheet asset '${id}' has extension '${extension}'.`, 'warning'),
      );
    }
    if (expectedKind === 'script' && extension && !['.lua', 'lua'].includes(extension)) {
      diagnostics.push(
        diagnostic(refPath, `Script asset '${id}' has extension '${extension}'.`, 'warning'),
      );
    }
  });
}

function validateMaterialRefs(
  project: AuthoringProject,
  refs: LayoutMaterialRef[],
  path: string,
  diagnostics: LayoutSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const id = refId(ref);
    const refPath = `${path}/${index}/$ref`;
    if (seen.has(id))
      diagnostics.push(diagnostic(refPath, `Duplicate material dependency '${id}'.`, 'warning'));
    seen.add(id);
    if (!project.materials[id]) diagnostics.push(diagnostic(refPath, `Missing material '${id}'.`));
  });
}

export function parseLayoutData(value: unknown): LayoutData | null {
  const parsed = layoutDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultLayoutData(
  label = 'Layout',
  layoutKind: LayoutKind = 'fragment',
): LayoutData {
  return layoutDataSchema.parse({
    kind: 'layout',
    layoutKind,
    displayName: label,
    target: 'default-ui',
    rml: {
      sourceMode: 'inline',
      sourceText:
        layoutKind === 'fragment' ? DEFAULT_RML_FRAGMENT_SOURCE : DEFAULT_RML_DOCUMENT_SOURCE,
      sourceAsset: null,
    },
    rcss: { sourceMode: 'inline', sourceText: DEFAULT_RCSS_SOURCE, sourceAsset: null },
    lua: { sourceMode: 'inline', sourceText: DEFAULT_LUA_SOURCE, sourceAsset: null },
    script: { enabled: true, namespace: 'layout_preview' },
    mount: { defaultParent: 'nt-layout-preview-mount', scopedStyles: true },
    dependencies: { images: [], fonts: [], stylesheets: [], materials: [], scripts: [] },
    sampleState: { projectTitle: 'NovelTea Layout' },
    preview: { width: 1280, height: 720, background: 'dark' },
  });
}

export function validateLayoutData(
  project: AuthoringProject,
  layoutId: string,
  record: AuthoringRecordBase,
): LayoutSchemaDiagnostic[] {
  const diagnostics: LayoutSchemaDiagnostic[] = [];
  const parsed = layoutDataSchema.safeParse(record.data);
  const base = `/layouts/${layoutId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;
  validateSourceAsset(project, data.rml, `${base}/rml`, 'rml', diagnostics);
  validateSourceAsset(project, data.rcss, `${base}/rcss`, 'rcss', diagnostics);
  validateSourceAsset(project, data.lua, `${base}/lua`, 'lua', diagnostics);
  validateRmlShape(data, base, diagnostics);
  validateScriptMetadata(data, base, diagnostics);
  validateAssetRefs(
    project,
    data.dependencies.images,
    `${base}/dependencies/images`,
    'image',
    diagnostics,
  );
  validateAssetRefs(
    project,
    data.dependencies.fonts,
    `${base}/dependencies/fonts`,
    'font',
    diagnostics,
  );
  validateAssetRefs(
    project,
    data.dependencies.stylesheets,
    `${base}/dependencies/stylesheets`,
    'stylesheet',
    diagnostics,
  );
  validateAssetRefs(
    project,
    data.dependencies.scripts,
    `${base}/dependencies/scripts`,
    'script',
    diagnostics,
  );
  validateMaterialRefs(
    project,
    data.dependencies.materials,
    `${base}/dependencies/materials`,
    diagnostics,
  );
  return diagnostics;
}

export function layoutRecordRef(layoutId: string): LayoutRecordRef {
  return { $ref: { collection: 'layouts', id: layoutId } };
}

export function getSystemLayoutSetting(
  project: AuthoringProject,
  role: SystemLayoutRole,
): LayoutRecordRef | null {
  const ui = project.settings.ui;
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) return null;
  const systemLayouts = (ui as Record<string, unknown>).systemLayouts;
  if (
    typeof systemLayouts === 'object' &&
    systemLayouts !== null &&
    !Array.isArray(systemLayouts)
  ) {
    const parsed = layoutRecordRefSchema
      .nullable()
      .safeParse((systemLayouts as Record<string, unknown>)[role]);
    if (parsed.success && parsed.data) return parsed.data;
  }
  return null;
}

export function validateSystemLayoutSettings(project: AuthoringProject): LayoutSchemaDiagnostic[] {
  const ui = project.settings.ui;
  if (ui === undefined) return [];
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) {
    return [diagnostic('/settings/ui', 'UI settings must be an object.')];
  }
  const systemLayouts = (ui as Record<string, unknown>).systemLayouts;
  if (systemLayouts === undefined || systemLayouts === null) return [];
  const parsed = systemLayoutSettingsSchema.safeParse(systemLayouts);
  if (!parsed.success) {
    return [
      diagnostic(
        '/settings/ui/systemLayouts',
        'System layouts must be a map of system role keys to layout references or null.',
      ),
    ];
  }
  const diagnostics: LayoutSchemaDiagnostic[] = [];
  for (const role of systemLayoutRoleValues) {
    const ref = parsed.data[role];
    if (!ref) continue;
    const id = ref.$ref.id;
    if (!project.layouts[id]) {
      diagnostics.push(
        diagnostic(
          `/settings/ui/systemLayouts/${role}/$ref`,
          `Missing ${role} system layout '${id}'.`,
        ),
      );
    }
  }
  return diagnostics;
}
