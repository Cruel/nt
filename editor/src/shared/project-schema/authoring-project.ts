import { z } from 'zod';
import {
  AUTHORING_PROJECT_SCHEMA,
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { entityIdSchema, type EntityId } from './authoring-common';
import { projectIdentitySchema } from './authoring-project-identity';
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
import { defaultExportProfile } from './authoring-export';
import { projectExportSettingsSchema } from './authoring-project-export';
import { inventoryDefinitionSchema } from './authoring-inventories';
import { DEFAULT_PROJECT_INVENTORY } from './authoring-inventories';
import { interactableInstanceDataSchema } from './authoring-interactables';
import { scriptRefSchema } from './authoring-flow';
import { interactionProgramSchema } from './authoring-interaction-programs';
import { prefetchHintSchema } from './authoring-prefetch-hints';

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

export const authoringProjectSchema = z
  .object({
    schema: z.literal(AUTHORING_PROJECT_SCHEMA),
    project: projectIdentitySchema,
    settings: typedProjectSettingsSchema,
    export: projectExportSettingsSchema,
    bootstrapModule: scriptRefSchema,
    undefinedInteractionProgram: interactionProgramSchema.nullable().default(null),
    entrypoint: projectEntrypointSchema.nullable().default(null),
    prefetchHints: z.record(entityIdSchema, prefetchHintSchema).default({}),
    traits: z.record(entityIdSchema, traitDefinitionSchema).default({}),
    inventories: z
      .tuple([inventoryDefinitionSchema])
      .refine(
        ([inventory]) =>
          inventory.id === DEFAULT_PROJECT_INVENTORY.id &&
          inventory.label === DEFAULT_PROJECT_INVENTORY.label,
        { message: 'Project Inventory must use the canonical inventory/Inventory identity.' },
      ),
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

function cloneAuthoringValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneAuthoringValue(entry)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>).map(([key, entry]) => [
      key,
      cloneAuthoringValue(entry),
    ]),
  ) as T;
}

/**
 * Clone the JSON-shaped authoring model without relying on the platform structured-clone
 * algorithm. Resident Project generations may expose structurally shared record views that are
 * intentionally not structured-cloneable; mutation callers still need an ordinary mutable value.
 */
export function cloneAuthoringProject(project: AuthoringProject): AuthoringProject {
  return cloneAuthoringValue(project);
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
      assetMemoryPolicies: [],
    },
    bootstrapModule: { $ref: { collection: 'scripts', id: 'bootstrap' } },
    undefinedInteractionProgram: null,
    entrypoint: null,
    prefetchHints: {},
    traits: {},
    inventories: [{ ...DEFAULT_PROJECT_INVENTORY }],
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
