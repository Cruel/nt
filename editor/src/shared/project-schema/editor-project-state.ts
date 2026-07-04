import { z } from 'zod';

export const EDITOR_PROJECT_STATE_SCHEMA = 'noveltea.editor.project-state' as const;
export const EDITOR_PROJECT_STATE_SCHEMA_VERSION = 1 as const;

const workbenchResourceKindSchema = z.enum(['record', 'preview', 'tool', 'project', 'raw']);

export const editorWorkbenchResourceSchema = z.object({
  kind: workbenchResourceKindSchema,
  stableId: z.string().min(1),
  collection: z.string().optional(),
  entityId: z.string().optional(),
  testId: z.string().optional(),
  explorerNodeId: z.string().optional(),
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
  activationHistory: z.array(z.string()).optional(),
});

type EditorWorkbenchLayoutNode = {
  kind: 'group';
  groupId: string;
} | {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: EditorWorkbenchLayoutNode[];
  sizesByChild?: Record<string, number>;
};

export const editorWorkbenchLayoutNodeSchema: z.ZodType<EditorWorkbenchLayoutNode> = z.lazy(() => z.union([
  z.object({ kind: z.literal('group'), groupId: z.string().min(1) }),
  z.object({
    kind: z.literal('split'),
    id: z.string().min(1),
    direction: z.enum(['horizontal', 'vertical']),
    children: z.array(editorWorkbenchLayoutNodeSchema),
    sizesByChild: z.record(z.string(), z.number()).optional(),
  }),
]));

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

export const editorExplorerStateSchema = z.object({
  expandedNodeIds: z.array(z.string()).default([]),
  hiddenCollectionKeys: z.array(z.string()).default([]),
  followActiveTab: z.boolean().default(true),
  organizeByChapter: z.boolean().default(true),
  groupUnassignedItems: z.boolean().default(true),
});

export const editorChapterRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().nullable().optional(),
  sortKey: z.string().nullable().optional(),
});

export const editorChaptersStateSchema = z.object({
  records: z.record(z.string(), editorChapterRecordSchema).default({}),
  assignments: z.record(z.string(), z.array(z.string())).default({}),
});

export const editorTagRecordSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  sortKey: z.string().nullable().optional(),
});

export const editorTagsStateSchema = z.object({
  records: z.record(z.string(), editorTagRecordSchema).default({}),
});

export const editorBottomPanelStateSchema = z.object({
  visible: z.boolean().default(true),
  sizePercent: z.number().min(10).max(70).default(30),
  activePanelId: z.enum([
    'problems',
    'output',
    'preview-events',
    'preview-diagnostics',
    'test-playback',
    'references',
    'shader-compile',
    'package-export',
    'command-history',
  ]).default('problems'),
});

export const editorProjectStateSchema = z.object({
  schema: z.literal(EDITOR_PROJECT_STATE_SCHEMA),
  schemaVersion: z.literal(EDITOR_PROJECT_STATE_SCHEMA_VERSION),
  workbench: editorWorkbenchStateSchema.optional(),
  explorer: editorExplorerStateSchema.default({ expandedNodeIds: [], hiddenCollectionKeys: [], followActiveTab: true, organizeByChapter: true, groupUnassignedItems: true }),
  chapters: editorChaptersStateSchema.default({ records: {}, assignments: {} }),
  tags: editorTagsStateSchema.default({ records: {} }),
  bottomPanel: editorBottomPanelStateSchema.default({ visible: true, activePanelId: 'problems', sizePercent: 30 }),
  tabStatesById: z.record(z.string(), editorTabStateSchema).default({}),
  draftsByKey: z.record(z.string(), editorDraftStateSchema).default({}),
});

export type EditorExplorerState = z.infer<typeof editorExplorerStateSchema>;
export type EditorChapterRecord = z.infer<typeof editorChapterRecordSchema>;
export type EditorChaptersState = z.infer<typeof editorChaptersStateSchema>;
export type EditorTagRecord = z.infer<typeof editorTagRecordSchema>;
export type EditorTagsState = z.infer<typeof editorTagsStateSchema>;
export type EditorBottomPanelState = z.infer<typeof editorBottomPanelStateSchema>;
export type EditorProjectState = z.infer<typeof editorProjectStateSchema>;
export type SerializedWorkbenchState = z.infer<typeof editorWorkbenchStateSchema>;
export type SerializedEditorDraftState = z.infer<typeof editorDraftStateSchema>;

export function emptyEditorExplorerState(): EditorExplorerState {
  return {
    expandedNodeIds: [],
    hiddenCollectionKeys: [],
    followActiveTab: true,
    organizeByChapter: true,
    groupUnassignedItems: true,
  };
}

export function emptyEditorChaptersState(): EditorChaptersState {
  return {
    records: {},
    assignments: {},
  };
}

export function emptyEditorTagsState(): EditorTagsState {
  return {
    records: {},
  };
}

export function emptyEditorBottomPanelState(): EditorBottomPanelState {
  return {
    visible: true,
    activePanelId: 'problems',
    sizePercent: 30,
  };
}

export function emptyEditorProjectState(): EditorProjectState {
  return {
    schema: EDITOR_PROJECT_STATE_SCHEMA,
    schemaVersion: EDITOR_PROJECT_STATE_SCHEMA_VERSION,
    explorer: emptyEditorExplorerState(),
    chapters: emptyEditorChaptersState(),
    tags: emptyEditorTagsState(),
    bottomPanel: emptyEditorBottomPanelState(),
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
