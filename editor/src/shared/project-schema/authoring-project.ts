import { z } from 'zod';
import {
  AUTHORING_PROJECT_SCHEMA,
  AUTHORING_PROJECT_SCHEMA_VERSION,
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { editorProjectStateSchema, emptyEditorProjectState } from './editor-project-state';

export const entityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const entityIdSchema = z.string().regex(
  entityIdPattern,
  'ID must be lowercase kebab-case, start with a letter, and contain only letters, numbers, and hyphens.',
);

export const referenceTargetSchema = z.object({
  collection: z.custom<AuthoringCollectionKey>((value) => isAuthoringCollectionKey(value), {
    message: 'Reference collection must be a known authoring collection.',
  }),
  id: entityIdSchema,
});

export const authoringRecordBaseSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Record label is required.'),
  description: z.string().optional(),
  parent: referenceTargetSchema.nullable().optional(),
  inherits: referenceTargetSchema.nullable().optional(),
  tags: z.array(z.string()).default([]),
  color: z.string().nullable().optional(),
  sortKey: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const authoringCollectionSchema = z.record(z.string(), authoringRecordBaseSchema);

const collectionShape = Object.fromEntries(
  authoringCollectionKeys.map((key) => [key, authoringCollectionSchema]),
) as Record<AuthoringCollectionKey, typeof authoringCollectionSchema>;

export const authoringProjectSchema = z.object({
  schema: z.literal(AUTHORING_PROJECT_SCHEMA),
  schemaVersion: z.literal(AUTHORING_PROJECT_SCHEMA_VERSION),
  project: z.object({
    id: entityIdSchema,
    name: z.string().min(1, 'Project name is required.'),
    version: z.string().default('0.1.0'),
    author: z.string().default(''),
    description: z.string().default(''),
  }),
  settings: z.record(z.string(), z.unknown()).default({}),
  entrypoint: referenceTargetSchema.nullable().default(null),
  editor: editorProjectStateSchema.default(emptyEditorProjectState),
  ...collectionShape,
});

export type EntityId = z.infer<typeof entityIdSchema>;
export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;
export type AuthoringRecordBase = z.infer<typeof authoringRecordBaseSchema>;
export type AuthoringProject = z.infer<typeof authoringProjectSchema>;
export type AuthoringCollection = Record<EntityId, AuthoringRecordBase>;

export interface CreateAuthoringProjectOptions {
  id?: string;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
}

export function isValidEntityId(value: string): boolean {
  return entityIdPattern.test(value);
}

export function isAuthoringProject(value: unknown): value is AuthoringProject {
  return authoringProjectSchema.safeParse(value).success;
}

export function parseAuthoringProject(value: unknown): AuthoringProject {
  return authoringProjectSchema.parse(value);
}

export function createAuthoringProject(options: CreateAuthoringProjectOptions = {}): AuthoringProject {
  const collections = Object.fromEntries(authoringCollectionKeys.map((key) => [key, {}]));
  return authoringProjectSchema.parse({
    schema: AUTHORING_PROJECT_SCHEMA,
    schemaVersion: AUTHORING_PROJECT_SCHEMA_VERSION,
    project: {
      id: options.id ?? 'new-project',
      name: options.name ?? 'New Project',
      version: options.version ?? '0.1.0',
      author: options.author ?? '',
      description: options.description ?? '',
    },
    settings: {},
    entrypoint: null,
    editor: emptyEditorProjectState(),
    ...collections,
  });
}
