import { z } from 'zod';
import { authoringProjectSchema } from './authoring-project';
import { authoringLocalizationSchema } from './authoring-localization';
import { authoringRecordSchemas } from './authoring-records';
import { layoutAssetRefSchema } from './authoring-layouts';
import { assetRefSchema } from './authoring-flow';
import {
  editorChaptersStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from './editor-project-state';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../project-workspace/project-workspace-contracts';

const workspaceManifestSchema = z
  .object({
    schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
    schemaVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
    project: authoringProjectSchema.shape.project,
    settings: authoringProjectSchema.shape.settings,
    bootstrapModule: authoringProjectSchema.shape.bootstrapModule,
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

export const schemaSources = {
  'project.schema.json': workspaceManifestSchema,
  'traits.schema.json': authoringProjectSchema.shape.traits,
  'localization.schema.json': authoringLocalizationSchema,
  'editor.schema.json': trackedEditorSchema,
  'records/assets.schema.json': authoringRecordSchemas.assets,
  'records/variables.schema.json': authoringRecordSchemas.variables,
  'records/shaders.schema.json': authoringRecordSchemas.shaders,
  'records/materials.schema.json': authoringRecordSchemas.materials,
  'records/layouts.schema.json': persistedLayoutRecordSchema,
  'records/archetypes.schema.json': authoringRecordSchemas.archetypes,
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

function jsonText(value: unknown): string {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

function schemaText(schema: z.ZodType): string {
  return jsonText(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
}

export interface NovelTeaSchemaReferenceField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
  readonly constraints: readonly string[];
  readonly children: readonly NovelTeaSchemaReferenceField[];
}

export interface NovelTeaSchemaReferenceDocument {
  readonly id: string;
  readonly title: string;
  readonly rawSchemaPath: string;
  readonly fields: readonly NovelTeaSchemaReferenceField[];
}

export interface NovelTeaWebsiteSchemaReference {
  readonly schema: 'noveltea.website.schema-reference';
  readonly channel: 'dev';
  readonly unreleased: true;
  readonly projectWorkspaceVersion: number;
  readonly documents: readonly NovelTeaSchemaReferenceDocument[];
}

type JsonSchemaNode = Readonly<Record<string, unknown>>;

function schemaRecord(value: unknown): JsonSchemaNode | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : null;
}

function schemaTypeLabel(node: JsonSchemaNode): string {
  if (
    typeof node.const === 'string' ||
    typeof node.const === 'number' ||
    typeof node.const === 'boolean'
  )
    return JSON.stringify(node.const);
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) return node.type.join(' | ');
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const branches = node[unionKey];
    if (Array.isArray(branches)) {
      const labels = branches
        .map(schemaRecord)
        .filter((branch): branch is JsonSchemaNode => branch !== null)
        .map(schemaTypeLabel);
      if (labels.length > 0) return [...new Set(labels)].join(' | ');
    }
  }
  if ('$ref' in node) return 'referenced value';
  return 'value';
}

function schemaConstraints(node: JsonSchemaNode): string[] {
  const constraints: string[] = [];
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
    ['minLength', 'minimum length'],
    ['maxLength', 'maximum length'],
    ['minItems', 'minimum items'],
    ['maxItems', 'maximum items'],
  ];
  for (const [key, label] of pairs) {
    if (typeof node[key] === 'number') constraints.push(`${label}: ${node[key]}`);
  }
  if (typeof node.pattern === 'string') constraints.push(`pattern: ${node.pattern}`);
  if (typeof node.format === 'string') constraints.push(`format: ${node.format}`);
  return constraints;
}

function schemaFields(node: JsonSchemaNode, depth = 0): NovelTeaSchemaReferenceField[] {
  if (depth >= 4) return [];
  const properties = schemaRecord(node.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  return Object.entries(properties).flatMap(([name, value]) => {
    const property = schemaRecord(value);
    if (!property) return [];
    return [
      {
        name,
        type: schemaTypeLabel(property),
        required: required.has(name),
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
        constraints: schemaConstraints(property),
        children: schemaFields(property, depth + 1),
      },
    ];
  });
}

function schemaTitle(relativePath: string): string {
  const base = relativePath.replace(/^records\//, '').replace(/\.schema\.json$/, '');
  if (base === 'project') return 'Project workspace manifest';
  if (base === 'traits') return 'Traits';
  if (base === 'localization') return 'Localization';
  if (base === 'editor') return 'Tracked editor metadata';
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} record`;
}

export function createNovelTeaRawSchemaFiles(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schemaSources).map(([relativePath, schema]) => [
        relativePath,
        schemaText(schema),
      ]),
    ),
  );
}

export function createNovelTeaWebsiteSchemaReference(): NovelTeaWebsiteSchemaReference {
  const documents = Object.entries(schemaSources)
    .filter(
      ([relativePath]) =>
        relativePath === 'project.schema.json' || relativePath.startsWith('records/'),
    )
    .map(([relativePath, schema]) => {
      const jsonSchema = schemaRecord(
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      );
      if (!jsonSchema)
        throw new Error(`Schema '${relativePath}' did not produce an object schema.`);
      return {
        id: relativePath.replace(/\.schema\.json$/, ''),
        title: schemaTitle(relativePath),
        rawSchemaPath: relativePath,
        fields: schemaFields(jsonSchema),
      } satisfies NovelTeaSchemaReferenceDocument;
    });
  return {
    schema: 'noveltea.website.schema-reference',
    channel: 'dev',
    unreleased: true,
    projectWorkspaceVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    documents,
  };
}
