import { z } from 'zod';
import { authoringProjectSchema } from './authoring-project';
import { authoringLocalizationSchema } from './authoring-localization';
import { authoringRecordSchemas } from './authoring-records';
import { layoutAssetRefSchema } from './authoring-layouts';
import {
  editorChaptersStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from './editor-project-state';
import { PROJECT_WORKSPACE_SCHEMA_VERSION } from '../project-workspace/project-workspace-contracts';
import { workspaceManifestSchema } from '../project-workspace/workspace-manifest-schema';
import {
  normalizeSchemaReference,
  renderSchemaNotation,
  schemaDocumentationEntries,
  type SchemaReferenceModel,
} from './schema-reference-model';
import { schemaReferenceJson } from './schema-reference-json';

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
const persistedLayoutLuaSourceSchema = z.discriminatedUnion('sourceMode', [
  z.object({ sourceMode: z.literal('file') }).strict(),
  z.object({ sourceMode: z.literal('none') }).strict(),
]);
const persistedLayoutRecordSchema = authoringRecordSchemas.layouts.extend({
  data: authoringRecordSchemas.layouts.shape.data.extend({
    rml: persistedLayoutSourceSchema,
    rcss: persistedLayoutSourceSchema,
    lua: persistedLayoutLuaSourceSchema,
  }),
});

export const schemaSources = {
  'project.schema.json': workspaceManifestSchema,
  'traits.schema.json': authoringProjectSchema.shape.traits,
  'localization.schema.json': authoringLocalizationSchema,
  'editor.schema.json': trackedEditorSchema,
  'records/assets.schema.json': authoringRecordSchemas.assets,
  'records/variables.schema.json': authoringRecordSchemas.variables,
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
  'records/scripts.schema.json': authoringRecordSchemas.scripts,
  'records/tests.schema.json': authoringRecordSchemas.tests,
} as const;

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalizeJson(nested)]),
  );
}

export interface NovelTeaSchemaReferenceDocument {
  readonly id: string;
  readonly title: string;
  readonly rawSchemaPath: string;
  readonly model: SchemaReferenceModel;
}

export interface NovelTeaWebsiteSchemaReference {
  readonly schema: 'noveltea.website.schema-reference';
  readonly channel: 'dev';
  readonly unreleased: true;
  readonly projectWorkspaceVersion: number;
  readonly documents: readonly NovelTeaSchemaReferenceDocument[];
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
        `${JSON.stringify(canonicalizeJson(schemaReferenceJson(schema)), null, 2)}\n`,
      ]),
    ),
  );
}

export function createNovelTeaSchemaReferenceDocuments(): readonly NovelTeaSchemaReferenceDocument[] {
  return Object.entries(schemaSources).map(([relativePath, schema]) => ({
    id: relativePath.replace(/\.schema\.json$/, ''),
    title: schemaTitle(relativePath),
    rawSchemaPath: relativePath,
    model: normalizeSchemaReference(
      schema,
      schemaTitle(relativePath)
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(''),
    ),
  }));
}

export function createNovelTeaWebsiteSchemaReference(): NovelTeaWebsiteSchemaReference {
  return {
    schema: 'noveltea.website.schema-reference',
    channel: 'dev',
    unreleased: true,
    projectWorkspaceVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    documents: createNovelTeaSchemaReferenceDocuments(),
  };
}

export function createNovelTeaCompactReferenceFiles(): Readonly<Record<string, string>> {
  const documents = createNovelTeaSchemaReferenceDocuments();
  const files: Record<string, string> = {
    'index.md': [
      '# Project reference',
      '',
      'Generated from the canonical Project schemas. Read the relevant domain below before consulting raw JSON Schema.',
      '',
      'Notation is structural documentation, not TypeScript or serialized JSON. `?` permits omission; `= value` supplies a default. Exact examples are JSON. All fields are required unless marked `?`. Numbers are finite JSON numbers. Object key policy is explicit. Named types are local to each document.',
      '',
      'Examples are schema-checked fragments; referenced IDs still require matching Project declarations. Run `noveltea validate` for cross-record and contextual constraints that structural schemas cannot express.',
      '',
      ...documents.map((document) => `- [${document.title}](${document.id}.md)`),
      '',
    ].join('\n'),
  };
  for (const document of documents) {
    const root = document.id.includes('/') ? '../' : '';
    const lines = [
      `# ${document.title}`,
      '',
      `Generated; do not edit. See [notation](${root}index.md). Raw fallback: [JSON Schema](${root}../schemas/${document.rawSchemaPath}).`,
      '',
      '```text',
      renderSchemaNotation(document.model),
      '```',
      '',
    ];
    for (const { path, documentation } of schemaDocumentationEntries(document.model)) {
      lines.push(`## ${path}`, '');
      if (documentation.description) lines.push(documentation.description, '');
      for (const [label, notes] of [
        ['Note', documentation.notes],
        ['Constraint', documentation.constraints],
        ['Lifecycle', documentation.lifecycle],
      ] as const)
        for (const note of notes ?? []) lines.push(`- ${label}: ${note}`);
      if (documentation.status) lines.push(`- Status: ${documentation.status}`);
      if (documentation.related?.length)
        lines.push(`- Related: ${documentation.related.join(', ')}`);
      lines.push('');
      for (const example of documentation.examples ?? []) {
        lines.push(`### ${example.title}`, '');
        if (example.source) lines.push(`Source: ${example.source}`, '');
        lines.push('```json', JSON.stringify(canonicalizeJson(example.value), null, 2), '```', '');
      }
    }
    files[`${document.id}.md`] = lines.join('\n');
  }
  return Object.freeze(files);
}
