import { z } from 'zod';
import { entityIdSchema } from '../../src/shared/project-schema/authoring-common';
import {
  authoringMessageSchema,
  localeDefinitionSchema,
  localeIdSchema,
  localizationAssetTargetSchema,
  localizationTranslationSchema,
  messageIdSchema,
  orphanedLocalizationMessageSchema,
  sourceMessageTrackingEntrySchema,
} from '../../src/shared/project-schema/authoring-localization';
import { traitDefinitionSchema } from '../../src/shared/project-schema/authoring-properties';
import {
  editorChaptersStateSchema,
  editorProjectStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from '../../src/shared/project-schema/editor-project-state';
import { nativeOperation } from '../../src/shared/project-schema/native-schema-operations';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../../src/shared/project-workspace/project-workspace-contracts';
import { workspaceManifestSchema } from '../../src/shared/project-workspace/workspace-manifest-schema';
const editorLocalStateSchema = editorProjectStateSchema
  .omit({
    schema: true,
    chapters: true,
    tags: true,
    recordMetadata: true,
  })
  .extend({
    schema: z.literal(EDITOR_LOCAL_STATE_SCHEMA),
  })
  .strict();

const traitsWorkspaceSchema = nativeOperation(
  'workspace.trait-key',
  z.record(entityIdSchema, traitDefinitionSchema).superRefine((traits, ctx) => {
    for (const [key, trait] of Object.entries(traits))
      if (trait.id !== key)
        ctx.addIssue({
          code: 'custom',
          path: [key, 'id'],
          message: `Trait id '${trait.id}' must match its map key '${key}'.`,
        });
  }),
);

const trackedEditorOrganizationSchema = z
  .object({
    chapters: editorChaptersStateSchema,
    tags: editorTagsStateSchema,
    recordMetadata: editorRecordMetadataStateSchema,
  })
  .strict();

const localizationPolicyFragmentSchema = z
  .object({
    sourceLocale: localeIdSchema,
    sourceLocaleLock: localeIdSchema.nullable().default(null),
    defaultLocale: localeIdSchema,
    locales: z.record(localeIdSchema, localeDefinitionSchema),
  })
  .strict();

const localizationMessagesFragmentSchema = z
  .object({
    messages: z.record(messageIdSchema, authoringMessageSchema),
    structuredMessageIds: z.record(z.string().min(1), messageIdSchema),
  })
  .strict();

const localizationUsageNotesFragmentSchema = z.record(z.string().min(1), z.string());

const localizationTrackingFragmentSchema = z.record(
  z.string().min(1),
  sourceMessageTrackingEntrySchema,
);

const localizationOrphansFragmentSchema = z.record(
  messageIdSchema,
  orphanedLocalizationMessageSchema,
);

const localizationAssetsLocaleFragmentSchema = z.record(
  z.string().min(1),
  localizationAssetTargetSchema,
);

export const projectWorkspaceSourceSchemas = {
  WorkspaceManifest: workspaceManifestSchema,
  WorkspaceTraitDeclarations: traitsWorkspaceSchema,
  WorkspaceTrackedEditor: trackedEditorOrganizationSchema,
  WorkspaceLocalEditor: editorLocalStateSchema,
  WorkspaceLocalizationPolicy: localizationPolicyFragmentSchema,
  WorkspaceLocalizationMessages: localizationMessagesFragmentSchema,
  WorkspaceLocalizationUsageNotes: localizationUsageNotesFragmentSchema,
  WorkspaceLocalizationTracking: localizationTrackingFragmentSchema,
  WorkspaceLocalizationOrphans: localizationOrphansFragmentSchema,
  WorkspaceLocalizationLocale: localizationTranslationSchema,
  WorkspaceLocalizationAssets: localizationAssetsLocaleFragmentSchema,
} as const;
