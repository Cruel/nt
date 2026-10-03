import { z } from 'zod';
import { interactionProgramSchema } from '../project-schema/authoring-interaction-programs';
import { authoringProjectSchema } from '../project-schema/authoring-project';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from './project-workspace-contracts';

export const workspaceManifestSchema = z
  .object({
    schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
    schemaVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
    project: authoringProjectSchema.shape.project,
    settings: authoringProjectSchema.shape.settings,
    export: authoringProjectSchema.shape.export,
    bootstrapModule: authoringProjectSchema.shape.bootstrapModule,
    undefinedInteractionProgram: interactionProgramSchema.nullable(),
    entrypoint: authoringProjectSchema.shape.entrypoint,
    inventories: authoringProjectSchema.shape.inventories,
    interactableInstances: authoringProjectSchema.shape.interactableInstances,
  })
  .strict();
