import { z } from 'zod';
import {
  AUTHORING_PROJECT_SCHEMA,
  AUTHORING_PROJECT_SCHEMA_VERSION,
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { entityIdSchema, type EntityId } from './authoring-common';
import { defaultAuthoringLocalization, authoringLocalizationSchema } from './authoring-localization';
import { propertyDefinitionSchema, type PropertyAssignments } from './authoring-properties';
import { authoringCollectionSchemas } from './authoring-records';
import { typedProjectSettingsSchema } from './authoring-project-settings';
import { editorProjectStateSchema, emptyEditorProjectState } from './editor-project-state';

export { entityIdPattern, entityIdSchema, isValidEntityId } from './authoring-common';
export type { EntityId } from './authoring-common';

export const referenceTargetSchema = z.object({
  collection: z.custom<AuthoringCollectionKey>((value) => isAuthoringCollectionKey(value), {
    message: 'Reference collection must be a known authoring collection.',
  }),
  id: entityIdSchema,
}).strict();

export const projectEntrypointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room'), id: entityIdSchema }).strict(),
  z.object({ kind: z.literal('scene'), id: entityIdSchema }).strict(),
  z.object({ kind: z.literal('dialogue'), id: entityIdSchema }).strict(),
]);

export const projectStartupHookSchema = z.object({
  source: z.string(),
}).strict();

const projectIdentitySchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  version: z.string().default('0.1.0'),
  author: z.string().default(''),
  description: z.string().default(''),
}).strict();

export const authoringProjectSchema = z.object({
  schema: z.literal(AUTHORING_PROJECT_SCHEMA),
  schemaVersion: z.literal(AUTHORING_PROJECT_SCHEMA_VERSION),
  project: projectIdentitySchema,
  settings: typedProjectSettingsSchema,
  startupHook: projectStartupHookSchema.nullable().default(null),
  entrypoint: projectEntrypointSchema.nullable().default(null),
  properties: z.record(entityIdSchema, propertyDefinitionSchema).default({}),
  localization: authoringLocalizationSchema.default(defaultAuthoringLocalization()),
  editor: editorProjectStateSchema.default(emptyEditorProjectState),
  ...authoringCollectionSchemas,
}).strict();

export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;
export type ProjectEntrypoint = z.infer<typeof projectEntrypointSchema>;
export type ProjectStartupHook = z.infer<typeof projectStartupHookSchema>;
export type AuthoringProject = z.infer<typeof authoringProjectSchema>;

// Common read-only view used by collection-agnostic editor infrastructure. The
// authoritative collection types remain the collection-specific schema types.
export interface AuthoringRecordBase {
  id: EntityId;
  label: string;
  description?: string;
  data: unknown;
  extends?: EntityId | null;
  properties?: PropertyAssignments;
}

export interface CreateAuthoringProjectOptions {
  id?: string;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
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
    settings: {
      app: {
        displayName: options.name ?? 'New Project',
        localized: {},
        applicationId: `org.noveltea.${options.id ?? 'new-project'}`,
        saveNamespace: `org.noveltea.${options.id ?? 'new-project'}`,
        versionName: options.version ?? '0.1.0',
        icon: null,
        launchImage: null,
        desktop: {},
        web: {},
        android: {},
      },
    },
    startupHook: null,
    entrypoint: null,
    properties: {},
    localization: defaultAuthoringLocalization(),
    editor: emptyEditorProjectState(),
    ...collections,
  });
}
