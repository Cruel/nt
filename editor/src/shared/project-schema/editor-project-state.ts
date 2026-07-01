import { z } from 'zod';

export const EDITOR_PROJECT_STATE_SCHEMA = 'noveltea.editor.project-state' as const;
export const EDITOR_PROJECT_STATE_SCHEMA_VERSION = 1 as const;

const workbenchResourceKindSchema = z.enum(['record', 'preview', 'tool', 'raw']);

export const editorWorkbenchResourceSchema = z.object({
  kind: workbenchResourceKindSchema,
  stableId: z.string().min(1),
  collection: z.string().optional(),
  entityId: z.string().optional(),
  testId: z.string().optional(),
});

export const editorWorkbenchTabSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  editorType: z.string().min(1),
  resource: editorWorkbenchResourceSchema.optional(),
  pinned: z.boolean().optional(),
  preview: z.boolean().optional(),
});

export const editorWorkbenchGroupSchema = z.object({
  id: z.string().min(1),
  tabIds: z.array(z.string()),
  activeTabId: z.string().nullable(),
});

export const editorWorkbenchLayoutNodeSchema: z.ZodType<{
  kind: 'group';
  groupId: string;
} | {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: Array<{
    kind: 'group';
    groupId: string;
  } | {
    kind: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    children: unknown[];
    sizes?: number[];
  }>;
  sizes?: number[];
}> = z.lazy(() => z.union([
  z.object({ kind: z.literal('group'), groupId: z.string().min(1) }),
  z.object({
    kind: z.literal('split'),
    id: z.string().min(1),
    direction: z.enum(['horizontal', 'vertical']),
    children: z.array(editorWorkbenchLayoutNodeSchema),
    sizes: z.array(z.number()).optional(),
  }),
])) as z.ZodType<{
  kind: 'group';
  groupId: string;
} | {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: Array<{
    kind: 'group';
    groupId: string;
  } | {
    kind: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    children: unknown[];
    sizes?: number[];
  }>;
  sizes?: number[];
}>;

export const editorWorkbenchStateSchema = z.object({
  layout: editorWorkbenchLayoutNodeSchema,
  groupsById: z.record(z.string(), editorWorkbenchGroupSchema),
  tabsById: z.record(z.string(), editorWorkbenchTabSchema),
  activeGroupId: z.string().min(1),
});

export const editorTabStateSchema = z.object({
  schema: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  payload: z.unknown().optional(),
});

export const editorDraftStateSchema = z.object({
  schema: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  tabId: z.string().min(1),
  label: z.string().optional(),
  payload: z.unknown(),
});

export const editorProjectStateSchema = z.object({
  schema: z.literal(EDITOR_PROJECT_STATE_SCHEMA),
  schemaVersion: z.literal(EDITOR_PROJECT_STATE_SCHEMA_VERSION),
  workbench: editorWorkbenchStateSchema.optional(),
  tabStatesById: z.record(z.string(), editorTabStateSchema).default({}),
  draftsByKey: z.record(z.string(), editorDraftStateSchema).default({}),
});

export type EditorProjectState = z.infer<typeof editorProjectStateSchema>;
export type SerializedWorkbenchState = z.infer<typeof editorWorkbenchStateSchema>;
export type SerializedEditorDraftState = z.infer<typeof editorDraftStateSchema>;

export function emptyEditorProjectState(): EditorProjectState {
  return {
    schema: EDITOR_PROJECT_STATE_SCHEMA,
    schemaVersion: EDITOR_PROJECT_STATE_SCHEMA_VERSION,
    tabStatesById: {},
    draftsByKey: {},
  };
}

export function parseEditorProjectState(value: unknown): EditorProjectState {
  const parsed = editorProjectStateSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyEditorProjectState();
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function stripEditorProjectState<T>(project: T): T {
  if (typeof project !== 'object' || project === null || Array.isArray(project)) return cloneJson(project);
  const cloned = cloneJson(project) as Record<string, unknown>;
  delete cloned.editor;
  return cloned as T;
}
