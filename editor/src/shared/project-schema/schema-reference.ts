import { z } from 'zod';
import { authoringProjectSchema } from './authoring-project';
import { authoringLocalizationSchema, namedMessageKeySchema } from './authoring-localization';
import { authoringRecordSchemas } from './authoring-records';
import { layoutAssetRefSchema, layoutPersistableValueSchema } from './authoring-layouts';
import { interactableLocationSchema } from './authoring-interactables';
import { entityIdSchema, jsonValueSchema, layoutContractIdSchema } from './authoring-common';
import {
  archetypeRefSchema,
  assetRefSchema,
  characterRefSchema,
  conditionSchema,
  dialogueRefSchema,
  flowTargetSchema,
  gameplayCommandSchema,
  gameplayConfigurationSourceSchema,
  gameplayIdentityOperandSchema,
  interactableInstanceRefSchema,
  interactableMatcherSchema,
  interactableOperandSchema,
  interactableRefSchema,
  inventoryOperandSchema,
  inventoryOwnerOperandSchema,
  inventoryOwnerSchema,
  inventoryReferenceSchema,
  layoutRefSchema,
  locationOperandSchema,
  locationSubjectOperandSchema,
  materialRefSchema,
  roomOperandSchema,
  roomRefSchema,
  runtimeScalarSchema,
  sceneRefSchema,
  scriptRefSchema,
  textContentSchema,
  textSourceSchema,
  traitRefSchema,
  variableRefSchema,
  verbRefSchema,
} from './authoring-flow';
import {
  materialApplicationParameterOverrideSchema,
  materialApplicationParameterSourceSchema,
  materialApplicationSchema,
  materialApplicationSpecializationSchema,
  materialApplicationTextureOverrideSchema,
} from './authoring-material-applications';
import {
  luaExplicitDependenciesSchema,
  luaExplicitDependencyTargetSchema,
} from './authoring-lua-analysis';
import { shaderUniformValueSchema } from './authoring-shaders';
import { cursorNamedIdSchema, cursorTargetSchema } from './authoring-cursor-vocabulary';
import {
  editorChaptersStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from './editor-project-state';
import { PROJECT_WORKSPACE_SCHEMA_VERSION } from '../project-workspace/project-workspace-contracts';
import { workspaceManifestSchema } from '../project-workspace/workspace-manifest-schema';
import {
  normalizeSchemaReference,
  renderSchemaDefinitions,
  renderSchemaNotation,
  schemaDocumentationEntries,
  type SchemaReferenceModel,
  type SchemaReferenceNode,
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

const sharedReferenceSchemaSources = {
  EntityId: entityIdSchema,
  LayoutContractId: layoutContractIdSchema,
  JsonValue: jsonValueSchema,
  NamedMessageKey: namedMessageKeySchema,
  CursorId: cursorNamedIdSchema,
  CursorTarget: cursorTargetSchema,
  AssetRef: assetRefSchema,
  ArchetypeRef: archetypeRefSchema,
  MaterialRef: materialRefSchema,
  CharacterRef: characterRefSchema,
  DialogueRef: dialogueRefSchema,
  LayoutRef: layoutRefSchema,
  VariableRef: variableRefSchema,
  RoomRef: roomRefSchema,
  SceneRef: sceneRefSchema,
  ScriptRef: scriptRefSchema,
  InteractableRef: interactableRefSchema,
  VerbRef: verbRefSchema,
  TraitRef: traitRefSchema,
  InteractableInstanceRef: interactableInstanceRefSchema,
  InventoryOwner: inventoryOwnerSchema,
  InventoryRef: inventoryReferenceSchema,
  RuntimeScalar: runtimeScalarSchema,
  TextSource: textSourceSchema,
  TextContent: textContentSchema,
  GameplayIdentityOperand: gameplayIdentityOperandSchema,
  InteractableOperand: interactableOperandSchema,
  LocationSubjectOperand: locationSubjectOperandSchema,
  RoomOperand: roomOperandSchema,
  InventoryOwnerOperand: inventoryOwnerOperandSchema,
  InventoryOperand: inventoryOperandSchema,
  LocationOperand: locationOperandSchema,
  InteractableMatcher: interactableMatcherSchema,
  Condition: conditionSchema,
  FlowTarget: flowTargetSchema,
  GameplayConfigurationSource: gameplayConfigurationSourceSchema,
  GameplayCommand: gameplayCommandSchema,
  InteractableLocation: interactableLocationSchema,
  LayoutPersistableValue: layoutPersistableValueSchema,
  LuaDependencyTarget: luaExplicitDependencyTargetSchema,
  LuaExplicitDependencies: luaExplicitDependenciesSchema,
  ShaderUniformValue: shaderUniformValueSchema,
  MaterialParameterSource: materialApplicationParameterSourceSchema,
  MaterialParameterOverride: materialApplicationParameterOverrideSchema,
  MaterialTextureOverride: materialApplicationTextureOverrideSchema,
  MaterialApplication: materialApplicationSchema,
  MaterialApplicationSpecialization: materialApplicationSpecializationSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

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

let schemaReferenceDocumentsCache: readonly NovelTeaSchemaReferenceDocument[] | undefined;
let sharedReferenceDefinitionsCache: Readonly<Record<string, SchemaReferenceNode>> | undefined;
let compactReferenceFilesCache: Readonly<Record<string, string>> | undefined;

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
        `${JSON.stringify(canonicalizeJson(schemaReferenceJson(schema, 'ref')), null, 2)}\n`,
      ]),
    ),
  );
}

export function createNovelTeaSchemaReferenceDocuments(): readonly NovelTeaSchemaReferenceDocument[] {
  schemaReferenceDocumentsCache ??= Object.freeze(
    Object.entries(schemaSources).map(([relativePath, schema]) => ({
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
    })),
  );
  return schemaReferenceDocumentsCache;
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

function sharedReferenceDefinitions(): Readonly<Record<string, SchemaReferenceNode>> {
  if (sharedReferenceDefinitionsCache) return sharedReferenceDefinitionsCache;
  const models = Object.entries(sharedReferenceSchemaSources).map(([name, schema]) =>
    normalizeSchemaReference(schema, name),
  );
  const entries = new Map<string, SchemaReferenceNode>(
    models.map((model) => [model.name, model.root]),
  );
  for (const model of models)
    for (const [name, node] of Object.entries(model.definitions))
      if (!entries.has(name)) entries.set(name, node);
  sharedReferenceDefinitionsCache = Object.freeze(
    Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))),
  );
  return sharedReferenceDefinitionsCache;
}

function appendDocumentationSections(
  lines: string[],
  entries: ReturnType<typeof schemaDocumentationEntries>,
): void {
  for (const { path, documentation } of entries) {
    lines.push(`## ${path}`, '');
    if (documentation.description) lines.push(documentation.description, '');
    for (const [label, notes] of [
      ['Note', documentation.notes],
      ['Constraint', documentation.constraints],
      ['Lifecycle', documentation.lifecycle],
    ] as const)
      for (const note of notes ?? []) lines.push(`- ${label}: ${note}`);
    if (documentation.status) lines.push(`- Status: ${documentation.status}`);
    if (documentation.related?.length) lines.push(`- Related: ${documentation.related.join(', ')}`);
    lines.push('');
    for (const example of documentation.examples ?? []) {
      lines.push(`### ${example.title}`, '');
      if (example.source) lines.push(`Source: ${example.source}`, '');
      lines.push('```json', JSON.stringify(canonicalizeJson(example.value), null, 2), '```', '');
    }
  }
}

export function createNovelTeaCompactReferenceFiles(): Readonly<Record<string, string>> {
  if (compactReferenceFilesCache) return compactReferenceFilesCache;
  const documents = createNovelTeaSchemaReferenceDocuments();
  const sharedDefinitions = sharedReferenceDefinitions();
  const sharedDefinitionNames = new Set(Object.keys(sharedDefinitions));
  const files: Record<string, string> = {
    'index.md': [
      '# Project reference',
      '',
      'Generated from the canonical Project schemas. Read the relevant domain below before consulting raw JSON Schema.',
      '',
      'Notation is structural documentation, not TypeScript or serialized JSON. `?` permits omission; `= value` supplies a default. Exact examples are JSON. All fields are required unless marked `?`. Numbers are finite JSON numbers. Objects reject unspecified keys unless an index signature (`[key: ...]`) is shown.',
      '',
      'Examples are schema-checked fragments; referenced IDs still require matching Project declarations. Run `noveltea validate` for cross-record and contextual constraints that structural schemas cannot express.',
      '',
      '- [Shared authoring types](common.md) — reusable IDs, references, conditions, commands, and other vocabulary used by multiple domains',
      ...documents.map((document) => `- [${document.title}](${document.id}.md)`),
      '',
    ].join('\n'),
    'common.md': [
      '# Shared authoring types',
      '',
      'Generated; do not edit. These named structures are used by multiple domain references and are defined once here to keep those files compact.',
      '',
      '```text',
      renderSchemaDefinitions(sharedDefinitions),
      '```',
      '',
    ].join('\n'),
  };
  for (const document of documents) {
    const root = document.id.includes('/') ? '../' : '';
    const lines = [
      `# ${document.title}`,
      '',
      `Generated; do not edit. See [notation](${root}index.md) and [shared types](${root}common.md). Raw fallback: [JSON Schema](${root}../schemas/${document.rawSchemaPath}).`,
      '',
    ];
    appendDocumentationSections(
      lines,
      schemaDocumentationEntries(document.model, { omitDefinitions: sharedDefinitionNames }),
    );
    lines.push(
      '## Shape and constraints',
      '',
      '```text',
      renderSchemaNotation(document.model, { omitDefinitions: sharedDefinitionNames }),
      '```',
      '',
    );
    files[`${document.id}.md`] = lines.join('\n');
  }
  compactReferenceFilesCache = Object.freeze(files);
  return compactReferenceFilesCache;
}
