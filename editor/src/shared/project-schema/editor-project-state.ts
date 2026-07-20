import { z } from 'zod';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from './project-validation';

export const EDITOR_PROJECT_STATE_SCHEMA = 'noveltea.editor.project-state' as const;
export const EDITOR_PROJECT_STATE_SCHEMA_VERSION = 2 as const;
export const EMPTY_CONTENT_FINGERPRINT = '0'.repeat(64);

const workbenchResourceKindSchema = z.enum(['record', 'preview', 'tool', 'project', 'raw']);

export const editorWorkbenchResourceSchema = z
  .object({
    kind: workbenchResourceKindSchema,
    stableId: z.string().min(1),
    collection: z.string().optional(),
    entityId: z.string().optional(),
    testId: z.string().optional(),
    explorerNodeId: z.string().optional(),
    generationMode: z.enum(['generate', 'edit']).optional(),
    sourceProjectRelativePath: z.string().optional(),
  })
  .strict();

export const editorWorkbenchTabSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    editorType: z.string().min(1),
    resource: editorWorkbenchResourceSchema.optional(),
    pinned: z.boolean().optional(),
    preview: z.boolean().optional(),
  })
  .strict();

export const editorWorkbenchGroupSchema = z
  .object({
    id: z.string().min(1),
    tabIds: z.array(z.string()),
    activeTabId: z.string().nullable(),
    activationHistory: z.array(z.string()).optional(),
  })
  .strict();

type EditorWorkbenchLayoutNode =
  | { kind: 'group'; groupId: string }
  | {
      kind: 'split';
      id: string;
      direction: 'horizontal' | 'vertical';
      children: EditorWorkbenchLayoutNode[];
      sizesByChild?: Record<string, number>;
    };

export const editorWorkbenchLayoutNodeSchema: z.ZodType<EditorWorkbenchLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('group'), groupId: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal('split'),
        id: z.string().min(1),
        direction: z.enum(['horizontal', 'vertical']),
        children: z.array(editorWorkbenchLayoutNodeSchema),
        sizesByChild: z.record(z.string(), z.number()).optional(),
      })
      .strict(),
  ]),
);

export const editorWorkbenchStateSchema = z
  .object({
    layout: editorWorkbenchLayoutNodeSchema,
    groupsById: z.record(z.string(), editorWorkbenchGroupSchema),
    tabsById: z.record(z.string(), editorWorkbenchTabSchema),
    activeGroupId: z.string().min(1),
  })
  .strict();

export const editorTabStateSchema = z
  .object({
    schema: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    payload: z.unknown().optional(),
  })
  .strict();

export const editorDraftStateSchema = z
  .object({
    schema: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    tabId: z.string().min(1),
    label: z.string().optional(),
    payload: z.unknown(),
  })
  .strict();

export const editorExplorerStateSchema = z
  .object({
    expandedNodeIds: z.array(z.string()).default([]),
    hiddenCollectionKeys: z.array(z.string()).default([]),
    followActiveTab: z.boolean().default(true),
    organizeByChapter: z.boolean().default(true),
    groupUnassignedItems: z.boolean().default(true),
    hideEmptyCategories: z.boolean().default(false),
    showInfoOnHover: z.boolean().default(true),
    searchQuery: z.string().default(''),
    filterTags: z.array(z.string()).default([]),
    showTagFilter: z.boolean().default(false),
    exactMatch: z.boolean().default(false),
  })
  .strict();

export const editorChapterRecordSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    color: z.string().nullable().optional(),
    sortKey: z.string().nullable().optional(),
  })
  .strict();

export const editorChaptersStateSchema = z
  .object({
    records: z.record(z.string(), editorChapterRecordSchema).default({}),
    assignments: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();

export const editorTagRecordSchema = z
  .object({
    name: z.string().min(1),
    color: z.string().min(1),
    sortKey: z.string().nullable().optional(),
  })
  .strict();

export const editorTagsStateSchema = z
  .object({ records: z.record(z.string(), editorTagRecordSchema).default({}) })
  .strict();

export const editorRecordMetadataSchema = z
  .object({
    tags: z.array(z.string()).default([]),
    color: z.string().nullable().optional(),
    sortKey: z.string().nullable().optional(),
  })
  .strict();

export const editorRecordMetadataStateSchema = z.record(
  z.string(),
  z.record(z.string(), editorRecordMetadataSchema),
);

export const editorBottomPanelStateSchema = z
  .object({
    visible: z.boolean().default(true),
    sizePercent: z.number().min(10).max(70).default(30),
    activePanelId: z
      .enum([
        'problems',
        'output',
        'preview-events',
        'preview-diagnostics',
        'test-playback',
        'references',
        'shader-compile',
        'package-export',
        'command-history',
      ])
      .default('problems'),
  })
  .strict();

function isCanonicalContentPointer(value: string): boolean {
  if (!value.startsWith('/') || value === '/editor' || value.startsWith('/editor/')) return false;
  return value
    .slice(1)
    .split('/')
    .every((segment) => !segment.includes('~') || /^(?:[^~]|~0|~1)*$/.test(segment));
}

export const editorRecoveryJsonPointerSchema = z
  .string()
  .refine(isCanonicalContentPointer, 'Recovery paths must be canonical content JSON pointers.');

const jsonSerializableValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSerializableValueSchema),
    z.record(z.string(), jsonSerializableValueSchema),
  ]),
);

export const editorRecoveryPatchSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      path: editorRecoveryJsonPointerSchema,
      value: jsonSerializableValueSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('replace'),
      path: editorRecoveryJsonPointerSchema,
      value: jsonSerializableValueSchema,
    })
    .strict(),
  z.object({ op: z.literal('remove'), path: editorRecoveryJsonPointerSchema }).strict(),
]);

export const editorPendingRawInputSchema = z
  .object({
    value: z.string(),
    diagnosticCode: z.string().min(1).optional(),
  })
  .strict();

export const editorRecoverySaveUnitSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    patches: z.array(editorRecoveryPatchSchema),
    affectedPaths: z.array(editorRecoveryJsonPointerSchema),
    pendingRawInputByPath: z.record(editorRecoveryJsonPointerSchema, editorPendingRawInputSchema),
    atomicTransactionGroupIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const editorRecoveryStateSchema = z
  .object({
    sequence: z.number().int().nonnegative().default(0),
    saveUnitsById: z.record(z.string().min(1), editorRecoverySaveUnitSchema).default({}),
  })
  .strict();

export const lastSuccessfulPlatformExportIdentitySchema = z
  .object({
    applicationId: z.string().min(1),
    saveNamespace: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })
  .strict();

const editorProjectStateV1Schema = z
  .object({
    schema: z.literal(EDITOR_PROJECT_STATE_SCHEMA),
    schemaVersion: z.literal(1),
    workbench: editorWorkbenchStateSchema.optional(),
    explorer: editorExplorerStateSchema.optional(),
    chapters: editorChaptersStateSchema.optional(),
    tags: editorTagsStateSchema.optional(),
    recordMetadata: editorRecordMetadataStateSchema.optional(),
    bottomPanel: editorBottomPanelStateSchema.optional(),
    tabStatesById: z.record(z.string(), editorTabStateSchema).optional(),
    draftsByKey: z.record(z.string(), editorDraftStateSchema).optional(),
  })
  .passthrough();

export const editorProjectStateSchema = z
  .object({
    schema: z.literal(EDITOR_PROJECT_STATE_SCHEMA),
    schemaVersion: z.literal(EDITOR_PROJECT_STATE_SCHEMA_VERSION),
    contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    recovery: editorRecoveryStateSchema.default({ sequence: 0, saveUnitsById: {} }),
    lastSuccessfulPlatformExportIdentity: lastSuccessfulPlatformExportIdentitySchema.optional(),
    workbench: editorWorkbenchStateSchema.optional(),
    explorer: editorExplorerStateSchema.default(emptyEditorExplorerState()),
    chapters: editorChaptersStateSchema.default(emptyEditorChaptersState()),
    tags: editorTagsStateSchema.default(emptyEditorTagsState()),
    recordMetadata: editorRecordMetadataStateSchema.default({}),
    bottomPanel: editorBottomPanelStateSchema.default(emptyEditorBottomPanelState()),
    tabStatesById: z.record(z.string(), editorTabStateSchema).default({}),
    draftsByKey: z.record(z.string(), editorDraftStateSchema).default({}),
  })
  .strict();

export type EditorExplorerState = z.infer<typeof editorExplorerStateSchema>;
export type EditorChapterRecord = z.infer<typeof editorChapterRecordSchema>;
export type EditorChaptersState = z.infer<typeof editorChaptersStateSchema>;
export type EditorTagRecord = z.infer<typeof editorTagRecordSchema>;
export type EditorTagsState = z.infer<typeof editorTagsStateSchema>;
export type EditorRecordMetadata = z.infer<typeof editorRecordMetadataSchema>;
export type EditorBottomPanelState = z.infer<typeof editorBottomPanelStateSchema>;
export type EditorRecoveryPatch = z.infer<typeof editorRecoveryPatchSchema>;
export type EditorRecoverySaveUnit = z.infer<typeof editorRecoverySaveUnitSchema>;
export type EditorRecoveryState = z.infer<typeof editorRecoveryStateSchema>;
export type EditorPendingRawInput = z.infer<typeof editorPendingRawInputSchema>;
export type EditorProjectState = z.infer<typeof editorProjectStateSchema>;
export type SerializedWorkbenchState = z.infer<typeof editorWorkbenchStateSchema>;
export type SerializedEditorTabState = z.infer<typeof editorTabStateSchema>;
export type SerializedEditorDraftState = z.infer<typeof editorDraftStateSchema>;

export interface ParsedEditorProjectState {
  state: EditorProjectState;
  diagnostics: ProjectValidationDiagnostic[];
}

export function emptyEditorExplorerState(): EditorExplorerState {
  return {
    expandedNodeIds: [],
    hiddenCollectionKeys: [],
    followActiveTab: true,
    organizeByChapter: true,
    groupUnassignedItems: true,
    hideEmptyCategories: false,
    showInfoOnHover: true,
    searchQuery: '',
    filterTags: [],
    showTagFilter: false,
    exactMatch: false,
  };
}

export function emptyEditorChaptersState(): EditorChaptersState {
  return { records: {}, assignments: {} };
}

export function emptyEditorTagsState(): EditorTagsState {
  return { records: {} };
}

export function emptyEditorBottomPanelState(): EditorBottomPanelState {
  return { visible: true, activePanelId: 'problems', sizePercent: 30 };
}

export function emptyEditorProjectState(
  contentFingerprint = EMPTY_CONTENT_FINGERPRINT,
): EditorProjectState {
  return {
    schema: EDITOR_PROJECT_STATE_SCHEMA,
    schemaVersion: EDITOR_PROJECT_STATE_SCHEMA_VERSION,
    contentFingerprint,
    recovery: { sequence: 0, saveUnitsById: {} },
    explorer: emptyEditorExplorerState(),
    chapters: emptyEditorChaptersState(),
    tags: emptyEditorTagsState(),
    recordMetadata: {},
    bottomPanel: emptyEditorBottomPanelState(),
    tabStatesById: {},
    draftsByKey: {},
  };
}

export function migrateEditorProjectStateV1ToV2(
  value: unknown,
  contentFingerprint = EMPTY_CONTENT_FINGERPRINT,
): EditorProjectState {
  const parsed = editorProjectStateV1Schema.safeParse(value);
  if (!parsed.success) return emptyEditorProjectState(contentFingerprint);
  const source = parsed.data;
  return editorProjectStateSchema.parse({
    ...emptyEditorProjectState(contentFingerprint),
    ...(source.workbench ? { workbench: source.workbench } : {}),
    ...(source.explorer ? { explorer: source.explorer } : {}),
    ...(source.chapters ? { chapters: source.chapters } : {}),
    ...(source.tags ? { tags: source.tags } : {}),
    ...(source.recordMetadata ? { recordMetadata: source.recordMetadata } : {}),
    ...(source.bottomPanel ? { bottomPanel: source.bottomPanel } : {}),
    ...(source.tabStatesById ? { tabStatesById: source.tabStatesById } : {}),
    ...(source.draftsByKey ? { draftsByKey: source.draftsByKey } : {}),
  });
}

function recoveryDiagnostic(saveUnitId: string, message: string): ProjectValidationDiagnostic {
  const escaped = saveUnitId.replaceAll('~', '~0').replaceAll('/', '~1');
  const path = `/editor/recovery/saveUnitsById/${escaped}`;
  return createProjectValidationDiagnostic({
    code: 'editor.recovery.entry.invalid',
    severity: 'warning',
    category: 'Project recovery',
    path,
    message,
    boundaries: ['authoring'],
    ownerPaths: [path],
  });
}

export function parseEditorProjectStateWithDiagnostics(
  value: unknown,
  contentFingerprint = EMPTY_CONTENT_FINGERPRINT,
): ParsedEditorProjectState {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 1
  ) {
    return { state: migrateEditorProjectStateV1ToV2(value, contentFingerprint), diagnostics: [] };
  }

  const candidate =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? ({ ...(value as Record<string, unknown>), contentFingerprint } as Record<string, unknown>)
      : value;
  const recoveryValue =
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).recovery
      : undefined;
  const rawEntries =
    typeof recoveryValue === 'object' && recoveryValue !== null && !Array.isArray(recoveryValue)
      ? (recoveryValue as Record<string, unknown>).saveUnitsById
      : undefined;
  const baseCandidate =
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? {
          ...(candidate as Record<string, unknown>),
          recovery: {
            sequence:
              typeof recoveryValue === 'object' &&
              recoveryValue !== null &&
              !Array.isArray(recoveryValue) &&
              Number.isInteger((recoveryValue as Record<string, unknown>).sequence)
                ? (recoveryValue as Record<string, unknown>).sequence
                : 0,
            saveUnitsById: {},
          },
        }
      : candidate;
  const parsedBase = editorProjectStateSchema.safeParse(baseCandidate);
  if (!parsedBase.success)
    return { state: emptyEditorProjectState(contentFingerprint), diagnostics: [] };

  const diagnostics: ProjectValidationDiagnostic[] = [];
  const saveUnitsById: Record<string, EditorRecoverySaveUnit> = {};
  if (typeof rawEntries === 'object' && rawEntries !== null && !Array.isArray(rawEntries)) {
    for (const [saveUnitId, entry] of Object.entries(rawEntries)) {
      const parsed = editorRecoverySaveUnitSchema.safeParse(entry);
      if (parsed.success) saveUnitsById[saveUnitId] = parsed.data;
      else diagnostics.push(recoveryDiagnostic(saveUnitId, 'Ignored invalid recovery metadata.'));
    }
  }
  return {
    state: {
      ...parsedBase.data,
      contentFingerprint,
      recovery: { ...parsedBase.data.recovery, saveUnitsById },
    },
    diagnostics,
  };
}

export function parseEditorProjectState(
  value: unknown,
  contentFingerprint = EMPTY_CONTENT_FINGERPRINT,
): EditorProjectState {
  return parseEditorProjectStateWithDiagnostics(value, contentFingerprint).state;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function stripEditorProjectState<T>(project: T): T {
  if (typeof project !== 'object' || project === null || Array.isArray(project))
    return cloneJson(project);
  const cloned = cloneJson(project) as Record<string, unknown>;
  delete cloned.editor;
  return cloned as T;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
  );
}

export function canonicalProjectContentJson(project: unknown): string {
  return JSON.stringify(canonicalizeJson(stripEditorProjectState(project)));
}
