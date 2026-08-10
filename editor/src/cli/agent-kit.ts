import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { authoringProjectSchema } from '../shared/project-schema/authoring-project';
import { authoringLocalizationSchema } from '../shared/project-schema/authoring-localization';
import { entityIdSchema } from '../shared/project-schema/authoring-common';
import { propertyDefinitionSchema } from '../shared/project-schema/authoring-properties';
import { authoringRecordSchemas } from '../shared/project-schema/authoring-records';
import { layoutAssetRefSchema } from '../shared/project-schema/authoring-layouts';
import { assetRefSchema } from '../shared/project-schema/authoring-flow';
import {
  editorChaptersStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from '../shared/project-schema/editor-project-state';
import { sha256PrefixedUtf8 } from '../shared/sha256';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../shared/project-workspace/project-workspace-service';
import { NOVELTEA_CLI_VERSION } from './contracts';
import { loadAgentKitSourceFiles } from './agent-kit/source';

export const NOVELTEA_AGENT_KIT_SCHEMA = 'noveltea.agent-kit.manifest' as const;
export const NOVELTEA_AGENT_KIT_SCHEMA_VERSION = 1 as const;
export const NOVELTEA_AGENT_KIT_VERSION = 1 as const;

const workspaceManifestSchema = z
  .object({
    schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
    schemaVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
    project: authoringProjectSchema.shape.project,
    settings: authoringProjectSchema.shape.settings,
    startupHook: authoringProjectSchema.shape.startupHook,
    entrypoint: authoringProjectSchema.shape.entrypoint,
  })
  .strict();

const trackedEditorSchema = z
  .object({
    chapters: editorChaptersStateSchema,
    tags: editorTagsStateSchema,
    recordMetadata: editorRecordMetadataStateSchema,
  })
  .strict();

const persistedLayoutSourceSchema = z.discriminatedUnion('sourceMode', [
  z.object({ sourceMode: z.literal('file') }).strict(),
  z.object({ sourceMode: z.literal('asset'), sourceAsset: layoutAssetRefSchema }).strict(),
  z.object({ sourceMode: z.literal('none') }).strict(),
]);
const persistedLayoutRecordSchema = authoringRecordSchemas.layouts.extend({
  data: authoringRecordSchemas.layouts.shape.data.extend({
    rml: persistedLayoutSourceSchema,
    rcss: persistedLayoutSourceSchema,
    lua: persistedLayoutSourceSchema,
  }),
});
const persistedScriptRecordSchema = authoringRecordSchemas.scripts.extend({
  data: authoringRecordSchemas.scripts.shape.data.extend({
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('file'),
          path: z.string().regex(/^scripts\/(?:[^/]+\/)*[^/]+\.lua$/),
        })
        .strict(),
      z.object({ kind: z.literal('asset'), asset: assetRefSchema }).strict(),
    ]),
  }),
});

const schemaSources = {
  'project.schema.json': workspaceManifestSchema,
  'properties.schema.json': z.record(entityIdSchema, propertyDefinitionSchema),
  'localization.schema.json': authoringLocalizationSchema,
  'editor.schema.json': trackedEditorSchema,
  'records/assets.schema.json': authoringRecordSchemas.assets,
  'records/variables.schema.json': authoringRecordSchemas.variables,
  'records/shaders.schema.json': authoringRecordSchemas.shaders,
  'records/materials.schema.json': authoringRecordSchemas.materials,
  'records/layouts.schema.json': persistedLayoutRecordSchema,
  'records/characters.schema.json': authoringRecordSchemas.characters,
  'records/rooms.schema.json': authoringRecordSchemas.rooms,
  'records/interactables.schema.json': authoringRecordSchemas.interactables,
  'records/verbs.schema.json': authoringRecordSchemas.verbs,
  'records/interactions.schema.json': authoringRecordSchemas.interactions,
  'records/dialogues.schema.json': authoringRecordSchemas.dialogues,
  'records/scenes.schema.json': authoringRecordSchemas.scenes,
  'records/maps.schema.json': authoringRecordSchemas.maps,
  'records/scripts.schema.json': persistedScriptRecordSchema,
  'records/tests.schema.json': authoringRecordSchemas.tests,
} as const;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, nested]) => [key, canonicalizeJson(nested)]),
  );
}

function schemaText(schema: z.ZodType): string {
  return `${JSON.stringify(
    canonicalizeJson(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })),
    null,
    2,
  )}\n`;
}

export interface NovelTeaAgentKitPayload {
  readonly manifestText: string;
  readonly files: Readonly<Record<string, string>>;
}

const PERRY_EMBEDDED_AGENT_KIT_ROOT = '$perryfs/dist/agent-kit';

function readPerryEmbeddedAgentKit(): NovelTeaAgentKitPayload | null {
  if (!('perry' in process.versions)) return null;
  const embeddedRoot = PERRY_EMBEDDED_AGENT_KIT_ROOT;
  let manifestText: string;
  try {
    manifestText = readFileSync(`${embeddedRoot}/manifest.json`, 'utf8');
  } catch {
    throw new Error('Embedded NovelTea agent kit is missing from this CLI release.');
  }
  const manifest = JSON.parse(manifestText) as { files?: Record<string, string> };
  if (!manifest.files || typeof manifest.files !== 'object')
    throw new Error('Embedded NovelTea agent-kit manifest is invalid.');
  const files = Object.fromEntries(
    Object.keys(manifest.files)
      .sort(compareCodePoints)
      .map((relativePath) => [
        relativePath,
        readFileSync(`${embeddedRoot}/${relativePath}`, 'utf8'),
      ]),
  );
  return { manifestText, files: Object.freeze(files) };
}

export function createNovelTeaAgentKitPayload(): NovelTeaAgentKitPayload {
  const embedded = readPerryEmbeddedAgentKit();
  if (embedded) return embedded;
  const files: Record<string, string> = { ...loadAgentKitSourceFiles() };
  for (const [relativePath, schema] of Object.entries(schemaSources))
    files[`schemas/${relativePath}`] = schemaText(schema);

  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => compareCodePoints(left, right)),
  );
  const hashes = Object.fromEntries(
    Object.entries(sortedFiles).map(([relativePath, text]) => [
      relativePath,
      sha256PrefixedUtf8(text),
    ]),
  );
  const manifest = {
    schema: NOVELTEA_AGENT_KIT_SCHEMA,
    schemaVersion: NOVELTEA_AGENT_KIT_SCHEMA_VERSION,
    agentKitVersion: NOVELTEA_AGENT_KIT_VERSION,
    cliVersion: NOVELTEA_CLI_VERSION,
    projectWorkspaceVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    files: hashes,
  };
  return {
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    files: Object.freeze(sortedFiles),
  };
}
