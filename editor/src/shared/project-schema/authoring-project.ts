import { z } from 'zod';
import {
  AUTHORING_PROJECT_SCHEMA,
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { entityIdSchema, type EntityId } from './authoring-common';
import {
  defaultAuthoringLocalization,
  authoringLocalizationSchema,
} from './authoring-localization';
import { traitDefinitionSchema } from './authoring-properties';
import { authoringCollectionSchemas } from './authoring-records';
import {
  DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS,
  DEFAULT_PROJECT_DISPLAY_SETTINGS,
  typedProjectSettingsSchema,
} from './authoring-project-settings';
import { editorProjectStateSchema, emptyEditorProjectState } from './editor-project-state';
import { defaultExportProfile, exportProfileSchema } from './authoring-export';
import { platformExportProfileSchema } from './platform-export-contracts';
import { inventoryDefinitionSchema } from './authoring-inventories';
import { interactableInstanceDataSchema } from './authoring-interactables';
import { scriptRefSchema } from './authoring-flow';
import { interactionProgramSchema } from './authoring-interaction-programs';

export { entityIdPattern, entityIdSchema, isValidEntityId } from './authoring-common';
export type { EntityId } from './authoring-common';

export const referenceTargetSchema = z
  .object({
    collection: z.custom<AuthoringCollectionKey>((value) => isAuthoringCollectionKey(value), {
      message: 'Reference collection must be a known project collection.',
    }),
    id: entityIdSchema,
  })
  .strict();

export const projectEntrypointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room'), id: entityIdSchema }).strict(),
  z.object({ kind: z.literal('scene'), id: entityIdSchema }).strict(),
  z.object({ kind: z.literal('dialogue'), id: entityIdSchema }).strict(),
]);

const projectIdentitySchema = z
  .object({
    id: entityIdSchema,
    name: z.string(),
    version: z.string().default('0.1.0'),
    author: z.string().default(''),
    description: z.string().default(''),
  })
  .strict();

const projectExportSettingsSchema = z
  .object({
    runtime: exportProfileSchema,
    profiles: z.array(platformExportProfileSchema).default([]),
  })
  .strict();

export const authoringProjectSchema = z
  .object({
    schema: z.literal(AUTHORING_PROJECT_SCHEMA),
    project: projectIdentitySchema,
    settings: typedProjectSettingsSchema,
    export: projectExportSettingsSchema,
    bootstrapModule: scriptRefSchema,
    undefinedInteractionProgram: interactionProgramSchema.nullable().default(null),
    entrypoint: projectEntrypointSchema.nullable().default(null),
    traits: z.record(entityIdSchema, traitDefinitionSchema).default({}),
    inventories: z.array(inventoryDefinitionSchema),
    interactableInstances: z.record(entityIdSchema, interactableInstanceDataSchema),
    localization: authoringLocalizationSchema.default(defaultAuthoringLocalization()),
    editor: editorProjectStateSchema.default(emptyEditorProjectState),
    ...authoringCollectionSchemas,
  })
  .strict();

export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;
export type ProjectEntrypoint = z.infer<typeof projectEntrypointSchema>;
export type AuthoringProject = z.infer<typeof authoringProjectSchema>;

// Common read-only view used by collection-agnostic editor infrastructure. The
// authoritative collection types remain the collection-specific schema types.
export interface AuthoringRecordBase {
  id: EntityId;
  label: string;
  description?: string;
  data: unknown;
  archetype?: { $ref: { collection: 'archetypes'; id: EntityId } } | null;
  archetypeOverrides?: Record<string, unknown>;
  traits?: EntityId[];
  localProperties?: import('./authoring-properties').OwnerLocalProperty[];
  defaultProperties?: import('./authoring-properties').OwnerDefaultProperty[];
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

export function createAuthoringProject(
  options: CreateAuthoringProjectOptions = {},
): AuthoringProject {
  const collections = Object.fromEntries(authoringCollectionKeys.map((key) => [key, {}]));
  return authoringProjectSchema.parse({
    schema: AUTHORING_PROJECT_SCHEMA,
    project: {
      id: options.id ?? 'new-project',
      name: options.name ?? 'New Project',
      version: options.version ?? '0.1.0',
      author: options.author ?? '',
      description: options.description ?? '',
    },
    settings: {
      display: structuredClone(DEFAULT_PROJECT_DISPLAY_SETTINGS),
      accessibility: structuredClone(DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS),
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
    export: {
      runtime: defaultExportProfile({
        project: {
          id: options.id ?? 'new-project',
          name: options.name ?? 'New Project',
          version: options.version ?? '0.1.0',
          author: options.author ?? '',
          description: options.description ?? '',
        },
      }),
      profiles: [],
    },
    bootstrapModule: { $ref: { collection: 'scripts', id: 'bootstrap' } },
    undefinedInteractionProgram: null,
    entrypoint: null,
    traits: {},
    inventories: [],
    interactableInstances: {},
    localization: defaultAuthoringLocalization(),
    editor: emptyEditorProjectState(),
    ...collections,
    scripts: {
      bootstrap: {
        id: 'bootstrap',
        label: 'Bootstrap',
        description: 'Project bootstrap module.',
        data: {
          kind: 'script-module',
          source: { kind: 'inline-lua', source: 'return {}\n' },
        },
      },
    },
  });
}
