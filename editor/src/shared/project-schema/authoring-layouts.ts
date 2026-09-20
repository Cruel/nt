import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { systemCursorNames } from './authoring-cursor-vocabulary';
import { layoutContractIdSchema } from './authoring-common';
import { defaultedLuaExplicitDependenciesSchema } from './authoring-lua-analysis';
import { authoredRuntimeValueSchema } from './authoring-properties';
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
export const layoutScaleInheritanceValues = ['inherit', 'ignore'] as const;
export const layoutContractValueTypeValues = ['boolean', 'integer', 'number', 'string'] as const;
export const layoutStateShapeTypeValues = [
  'boolean',
  'integer',
  'number',
  'string',
  'array',
  'object',
] as const;
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
  'command-builder',
  'scene-text',
  'scene-choice',
] as const;

export type LayoutKind = (typeof layoutKindValues)[number];
export type LayoutTarget = (typeof layoutTargetValues)[number];
export type LayoutSourceMode = (typeof layoutSourceModeValues)[number];
export type LayoutPreviewBackground = (typeof layoutPreviewBackgroundValues)[number];
export type LayoutScaleInheritance = (typeof layoutScaleInheritanceValues)[number];
export type LayoutContractValueType = (typeof layoutContractValueTypeValues)[number];
export type LayoutStateShapeType = (typeof layoutStateShapeTypeValues)[number];
export type LayoutPersistableValue =
  | null
  | boolean
  | number
  | string
  | LayoutPersistableValue[]
  | { [key: string]: LayoutPersistableValue };
export type LayoutStateShapeData =
  | {
      type: 'boolean' | 'integer' | 'number' | 'string';
      nullable: boolean;
      defaultValue?: LayoutPersistableValue;
    }
  | {
      type: 'array';
      nullable: boolean;
      items: LayoutStateShapeData;
      defaultValue?: LayoutPersistableValue;
    }
  | {
      type: 'object';
      nullable: boolean;
      fields: Record<string, { required: boolean; shape: LayoutStateShapeData }>;
      defaultValue?: LayoutPersistableValue;
    };
export type SystemLayoutRole = (typeof systemLayoutRoleValues)[number];

export interface LayoutScalePolicy {
  ui: LayoutScaleInheritance;
  text: LayoutScaleInheritance;
}

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

export const layoutScriptPathSchema = z
  .string()
  .regex(/^scripts\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\/\/)[^/].*\.lua$/u);

export const layoutSourceDataSchema = z
  .object({
    sourceMode: z.enum(layoutSourceModeValues).default('inline'),
    sourceText: z.string().default(''),
    sourceAsset: layoutAssetRefSchema.nullable().default(null),
  })
  .strict();

export const layoutLuaSourceDataSchema = z
  .object({
    sourceMode: z.literal('inline').default('inline'),
    sourceText: z.string().default(''),
  })
  .strict();

export const layoutDependencyDataSchema = z
  .object({
    images: z.array(layoutAssetRefSchema).default([]),
    fonts: z.array(layoutAssetRefSchema).default([]),
    stylesheets: z.array(layoutAssetRefSchema).default([]),
    materials: z.array(layoutMaterialRefSchema).default([]),
    scripts: z.array(layoutScriptPathSchema).default([]),
    templates: z.array(layoutAssetRefSchema).optional(),
    data: z.array(layoutAssetRefSchema).optional(),
  })
  .strict();

export const layoutScriptDataSchema = z
  .object({
    enabled: z.boolean().default(true),
    namespace: z.string().check(z.trim()).optional(),
    additionalDependencies: defaultedLuaExplicitDependenciesSchema,
  })
  .strict();

export const layoutMountDataSchema = z
  .object({
    defaultParent: z.string().check(z.trim()).optional(),
    scopedStyles: z.boolean().default(true),
  })
  .strict();

const layoutContractValueShapeSchema = z
  .object({
    type: z.enum(layoutContractValueTypeValues),
    nullable: z.boolean().default(false),
  })
  .strict();

const layoutContractInputSchema = z
  .object({
    type: z.enum(layoutContractValueTypeValues),
    nullable: z.boolean().default(false),
    defaultValue: authoredRuntimeValueSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.defaultValue === undefined) return;
    const value = input.defaultValue;
    const valid =
      value === null
        ? input.nullable
        : input.type === 'boolean'
          ? typeof value === 'boolean'
          : input.type === 'integer'
            ? typeof value === 'number' && Number.isInteger(value)
            : input.type === 'number'
              ? typeof value === 'number'
              : typeof value === 'string';
    if (!valid)
      context.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: 'Layout input defaultValue must match its declared type and nullability.',
      });
  });

function stateValueMatchesShape(
  shape: LayoutStateShapeData,
  value: LayoutPersistableValue,
): boolean {
  if (value === null) return shape.nullable;
  if (shape.type === 'boolean') return typeof value === 'boolean';
  if (shape.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (shape.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (shape.type === 'string') return typeof value === 'string';
  if (shape.type === 'array')
    return Array.isArray(value) && value.every((item) => stateValueMatchesShape(shape.items, item));
  if (shape.type !== 'object' || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, LayoutPersistableValue>;
  for (const [key, member] of Object.entries(object)) {
    const field = shape.fields[key];
    if (!field || !stateValueMatchesShape(field.shape, member)) return false;
  }
  return Object.entries(shape.fields).every(
    ([key, field]) => !field.required || Object.prototype.hasOwnProperty.call(object, key),
  );
}

export const layoutPersistableValueSchema: z.ZodType<LayoutPersistableValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(layoutPersistableValueSchema),
    z.record(z.string().min(1), layoutPersistableValueSchema),
  ]),
);

export const layoutStateShapeSchema: z.ZodType<LayoutStateShapeData> = z.lazy(() =>
  z
    .discriminatedUnion('type', [
      z
        .object({
          type: z.enum(['boolean', 'integer', 'number', 'string']),
          nullable: z.boolean().default(false),
          defaultValue: layoutPersistableValueSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('array'),
          nullable: z.boolean().default(false),
          items: layoutStateShapeSchema,
          defaultValue: layoutPersistableValueSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('object'),
          nullable: z.boolean().default(false),
          fields: z
            .record(
              layoutContractIdSchema,
              z
                .object({
                  required: z.boolean().default(true),
                  shape: layoutStateShapeSchema,
                })
                .strict(),
            )
            .default({}),
          defaultValue: layoutPersistableValueSchema.optional(),
        })
        .strict(),
    ])
    .superRefine((shape, context) => {
      if (shape.defaultValue !== undefined && !stateValueMatchesShape(shape, shape.defaultValue))
        context.addIssue({
          code: 'custom',
          path: ['defaultValue'],
          message: 'Layout state defaultValue must match its recursive State Shape.',
        });
    }),
);

const layoutContractSignalSchema = z
  .object({
    fields: z
      .record(
        layoutContractIdSchema,
        layoutContractValueShapeSchema.extend({ required: z.boolean().default(true) }).strict(),
      )
      .default({}),
  })
  .strict();

export const layoutContractDataSchema = z
  .object({
    inputs: z.record(layoutContractIdSchema, layoutContractInputSchema).default({}),
    signals: z.record(layoutContractIdSchema, layoutContractSignalSchema).default({}),
    state: layoutStateShapeSchema.optional(),
  })
  .strict();

export const layoutScalePolicySchema = z
  .object({
    ui: z.enum(layoutScaleInheritanceValues),
    text: z.enum(layoutScaleInheritanceValues),
  })
  .strict();

export const layoutDataSchema = z
  .object({
    kind: z.literal('layout').default('layout'),
    layoutKind: z.enum(layoutKindValues).default('document'),
    displayName: z.string().optional(),
    target: z.enum(layoutTargetValues).default('default-ui'),
    scalePolicy: layoutScalePolicySchema.optional(),
    contract: layoutContractDataSchema.default({ inputs: {}, signals: {} }),
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
    lua: layoutLuaSourceDataSchema.default({
      sourceMode: 'inline',
      sourceText: '',
    }),
    script: layoutScriptDataSchema.default({ enabled: true }),
    mount: layoutMountDataSchema.default({ scopedStyles: true }),
    dependencies: layoutDependencyDataSchema.default({
      images: [],
      fonts: [],
      stylesheets: [],
      materials: [],
      scripts: [],
      templates: [],
    }),
    sampleState: z.record(z.string(), z.json()).default({}),
    preview: z
      .object({
        background: z.enum(layoutPreviewBackgroundValues).default('dark'),
      })
      .strict()
      .default({ background: 'dark' }),
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
    'command-builder': layoutRecordRefSchema.nullable().optional(),
    'scene-text': layoutRecordRefSchema.nullable().optional(),
    'scene-choice': layoutRecordRefSchema.nullable().optional(),
  })
  .strict()
  .default({});

export type LayoutAssetRef = z.infer<typeof layoutAssetRefSchema>;
export type LayoutMaterialRef = z.infer<typeof layoutMaterialRefSchema>;
export type LayoutRecordRef = z.infer<typeof layoutRecordRefSchema>;
export type LayoutScriptPath = z.infer<typeof layoutScriptPathSchema>;
export type LayoutSourceData = z.infer<typeof layoutSourceDataSchema>;
export type LayoutLuaSourceData = z.infer<typeof layoutLuaSourceDataSchema>;
export type LayoutDependencyData = z.infer<typeof layoutDependencyDataSchema>;
export type LayoutScriptData = z.infer<typeof layoutScriptDataSchema>;
export type LayoutMountData = z.infer<typeof layoutMountDataSchema>;
export type LayoutContractData = z.infer<typeof layoutContractDataSchema>;
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
<body onshow="layout_preview.on_show(event, element, document)">
  <div class="noveltea-layout-preview">
    <h1>NovelTea Layout</h1>
    <p>Edit this RML, RCSS, and Lua to build runtime UI.</p>
    <p>The Lua counter is not saved. Layout State is stored in NovelTea saves.</p>
    <div class="noveltea-layout-actions">
      <button id="layout-preview-lua-counter" onclick="layout_preview.on_lua_click(event, element, document)">Lua global: 0</button>
      <button id="layout-preview-state-counter" onclick="layout_preview.on_state_click(event, element, document)">Saved Layout State: 0</button>
    </div>
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

.noveltea-layout-actions {
  display: flex;
}

.noveltea-layout-actions button + button {
  margin-left: 8px;
}
`;

const DEFAULT_DOCUMENT_LUA_SOURCE = String.raw`layout_preview = layout_preview or {}
layout_preview.lua_count = layout_preview.lua_count or 0

local function saved_count()
  local mount = Game.mount_context()
  if not mount then
    return nil, nil
  end

  local state = mount:state('session')
  if not state then
    return 0, mount
  end
  return state.saved_count or 0, mount
end

function layout_preview.render(document)
  local lua_button = document:GetElementById('layout-preview-lua-counter')
  if lua_button then
    lua_button.inner_rml = 'Lua global: ' .. layout_preview.lua_count
  end

  local state_button = document:GetElementById('layout-preview-state-counter')
  if state_button then
    local count = saved_count()
    if count == nil then
      state_button.inner_rml = 'Saved Layout State: preview unavailable'
    else
      state_button.inner_rml = 'Saved Layout State: ' .. count
    end
  end
end

function layout_preview.on_show(event, element, document)
  layout_preview.render(document)
end

function layout_preview.on_lua_click(event, element, document)
  layout_preview.lua_count = layout_preview.lua_count + 1
  layout_preview.render(document)
end

function layout_preview.on_state_click(event, element, document)
  local count, mount = saved_count()
  if count == nil or not mount then
    element.inner_rml = 'Saved Layout State: preview unavailable'
    return
  end

  local next_count = count + 1
  if mount:commit_state('session', { saved_count = next_count }) then
    element.inner_rml = 'Saved Layout State: ' .. next_count
  end
end
`;

const DEFAULT_FRAGMENT_LUA_SOURCE = String.raw`layout_preview = layout_preview or {}
layout_preview.click_count = 0

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
  expected: 'rml' | 'rcss',
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
  }
  if (kind && !['text', 'data'].includes(kind)) {
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
  expectedKind: 'image' | 'font' | 'stylesheet' | 'data',
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
    if (
      expectedKind === 'data' &&
      (kind !== 'data' || parseAssetData(record.data)?.extension?.toLowerCase() !== '.json')
    )
      diagnostics.push(diagnostic(refPath, `Data dependency '${id}' must be a JSON data Asset.`));
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
  });
}

function validateRcssCursors(
  project: AuthoringProject,
  layoutId: string,
  data: LayoutData,
  base: string,
  diagnostics: LayoutSchemaDiagnostic[],
) {
  if (data.rcss.sourceMode !== 'inline') return;

  const sourcePath = `${base}/rcss/sourceText`;
  const source = data.rcss.sourceText.replace(/\/\*[\s\S]*?\*\//g, '');
  const namedCursorIds = new Set(project.settings.cursors?.named.map((cursor) => cursor.id) ?? []);
  const imageDependencyIds = new Set(data.dependencies.images.map(refId));
  const authoredCursorNames = new Set<string>([...systemCursorNames, 'auto', 'none']);

  const rmlSourcePath =
    data.rml.sourceMode === 'asset' && data.rml.sourceAsset
      ? parseAssetData(project.assets[refId(data.rml.sourceAsset)]?.data)?.source.path
      : `__noveltea_inline_layout_${layoutId.replace(/[^A-Za-z0-9_-]/g, '_')}.rml`;
  const rmlSourceDirectory = rmlSourcePath?.includes('/')
    ? rmlSourcePath.slice(0, rmlSourcePath.lastIndexOf('/') + 1)
    : '';

  const normalizeProjectPath = (path: string): string | null => {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    return segments.join('/');
  };

  const projectAssetForPath = (path: string) => {
    let logical: string;
    if (path.startsWith('project:/')) {
      logical = path.slice('project:/'.length);
    } else if (path.startsWith('/')) {
      logical = path.slice(1);
    } else {
      logical = `${rmlSourceDirectory}${path}`;
    }
    const normalized = normalizeProjectPath(logical);
    if (!normalized) return undefined;
    return Object.values(project.assets).find((record) => {
      const asset = parseAssetData(record.data);
      return asset?.source.path === normalized;
    });
  };

  const declarations = source.matchAll(/(?:^|[;{])\s*cursor\s*:\s*([^;}]+)/gim);
  for (const declaration of declarations) {
    const rawValue = declaration[1]?.trim().replace(/\s*!important\s*$/i, '') ?? '';
    if (!rawValue) continue;

    if (/^image\s*\(/i.test(rawValue)) {
      const image = rawValue.match(/^image\s*\(([\s\S]*)\)$/i);
      if (!image) {
        diagnostics.push(
          diagnostic(sourcePath, 'cursor: image(...) requires exactly one image source.'),
        );
        continue;
      }
      const argument = image[1]?.trim() ?? '';
      let resource = '';
      if (
        argument.length >= 2 &&
        ((argument.startsWith('"') && argument.endsWith('"')) ||
          (argument.startsWith("'") && argument.endsWith("'")))
      ) {
        resource = argument.slice(1, -1);
      } else if (argument && !/[\s,'"()]/.test(argument)) {
        resource = argument;
      }
      if (!resource) {
        diagnostics.push(
          diagnostic(sourcePath, 'cursor: image(...) requires exactly one image source.'),
        );
        continue;
      }

      const scheme = resource.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
      if (scheme && scheme[1] !== 'project' && scheme[1] !== 'system') {
        diagnostics.push(
          diagnostic(
            sourcePath,
            `Cursor image '${resource}' uses unsupported resource scheme '${scheme[1]}:'.`,
          ),
        );
        continue;
      }
      if (resource.startsWith('system:/')) continue;
      if (resource.startsWith('\\') || resource.includes('\\')) {
        diagnostics.push(
          diagnostic(sourcePath, `Cursor image '${resource}' must use an RmlUi resource path.`),
        );
        continue;
      }

      const record = projectAssetForPath(resource);
      if (!record) {
        diagnostics.push(
          diagnostic(sourcePath, `Cursor image '${resource}' does not resolve to a Project Asset.`),
        );
        continue;
      }
      const asset = parseAssetData(record.data);
      if (asset?.kind !== 'image') {
        diagnostics.push(
          diagnostic(sourcePath, `Cursor image '${resource}' is not an Image Asset.`),
        );
        continue;
      }
      if (!imageDependencyIds.has(record.id)) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            `Cursor image '${resource}' must already be declared as a Layout image dependency.`,
          ),
        );
      }
      continue;
    }

    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(rawValue)) continue;
    if (
      !authoredCursorNames.has(rawValue) &&
      !namedCursorIds.has(rawValue) &&
      !rawValue.startsWith('rmlui-')
    ) {
      diagnostics.push(diagnostic(sourcePath, `Unknown cursor '${rawValue}'.`));
    }
  }
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

export function layoutTargetUsesWorldOverlay(target: LayoutTarget): boolean {
  return target === 'scene-overlay' || target === 'room-overlay' || target === 'custom-overlay';
}

export function defaultLayoutScalePolicy(target: LayoutTarget): LayoutScalePolicy {
  return layoutTargetUsesWorldOverlay(target)
    ? { ui: 'ignore', text: 'inherit' }
    : { ui: 'inherit', text: 'inherit' };
}

export function resolveLayoutScalePolicy(
  target: LayoutTarget,
  authored: LayoutScalePolicy | undefined,
): LayoutScalePolicy {
  return authored ?? defaultLayoutScalePolicy(target);
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
    contract:
      layoutKind === 'document'
        ? {
            inputs: {},
            signals: {},
            state: {
              type: 'object',
              nullable: false,
              fields: {
                saved_count: {
                  required: true,
                  shape: { type: 'integer', nullable: false },
                },
              },
              defaultValue: { saved_count: 0 },
            },
          }
        : { inputs: {}, signals: {} },
    rml: {
      sourceMode: 'inline',
      sourceText:
        layoutKind === 'fragment' ? DEFAULT_RML_FRAGMENT_SOURCE : DEFAULT_RML_DOCUMENT_SOURCE,
      sourceAsset: null,
    },
    rcss: { sourceMode: 'inline', sourceText: DEFAULT_RCSS_SOURCE, sourceAsset: null },
    lua: {
      sourceMode: 'inline',
      sourceText:
        layoutKind === 'fragment' ? DEFAULT_FRAGMENT_LUA_SOURCE : DEFAULT_DOCUMENT_LUA_SOURCE,
    },
    script: { enabled: true, namespace: 'layout_preview' },
    mount: { defaultParent: 'nt-layout-preview-mount', scopedStyles: true },
    dependencies: { images: [], fonts: [], stylesheets: [], materials: [], scripts: [] },
    sampleState: layoutKind === 'document' ? { state: { saved_count: 0 } } : {},
    preview: { background: 'dark' },
  });
}

export function validateLayoutData(
  project: AuthoringProject,
  layoutId: string,
  record: AuthoringRecordBase,
): LayoutSchemaDiagnostic[] {
  const diagnostics: LayoutSchemaDiagnostic[] = [];
  if (layoutId === 'builtin-inventory') {
    diagnostics.push(
      diagnostic(
        `/layouts/${layoutId}`,
        "Layout ID 'builtin-inventory' is reserved for NovelTea's built-in Inventory fallback.",
      ),
    );
  }
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
  const seenScriptPaths = new Set<string>();
  data.dependencies.scripts.forEach((scriptPath, index) => {
    if (seenScriptPaths.has(scriptPath))
      diagnostics.push(
        diagnostic(
          `${base}/dependencies/scripts/${index}`,
          `Duplicate script dependency '${scriptPath}'.`,
          'warning',
        ),
      );
    seenScriptPaths.add(scriptPath);
  });
  validateAssetRefs(
    project,
    data.dependencies.data ?? [],
    `${base}/dependencies/data`,
    'data',
    diagnostics,
  );
  validateMaterialRefs(
    project,
    data.dependencies.materials,
    `${base}/dependencies/materials`,
    diagnostics,
  );
  validateRcssCursors(project, layoutId, data, base, diagnostics);
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

export function isSystemLayoutCompatible(value: unknown): boolean {
  const data = parseLayoutData(value);
  return (
    data !== null &&
    Object.keys(data.contract.inputs).length === 0 &&
    Object.keys(data.contract.signals).length === 0 &&
    data.contract.state === undefined
  );
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
    const layout = project.layouts[id];
    if (!layout) {
      diagnostics.push(
        diagnostic(
          `/settings/ui/systemLayouts/${role}/$ref`,
          `Missing ${role} system layout '${id}'.`,
        ),
      );
      continue;
    }
    const data = parseLayoutData(layout.data);
    if (data && !isSystemLayoutCompatible(data)) {
      diagnostics.push(
        diagnostic(
          `/settings/ui/systemLayouts/${role}/$ref`,
          `System layout role '${role}' uses the fixed engine contract; Layout '${id}' must not declare custom inputs, signals, or State Shapes.`,
        ),
      );
    }
  }
  return diagnostics;
}
