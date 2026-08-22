import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authoringProjectSchema } from '../shared/project-schema/authoring-project';
import { authoringLocalizationSchema } from '../shared/project-schema/authoring-localization';
import { entityIdSchema } from '../shared/project-schema/authoring-common';
import { propertyDefinitionSchema } from '../shared/project-schema/authoring-properties';
import { authoringRecordSchemas } from '../shared/project-schema/authoring-records';
import {
  layoutAssetRefSchema,
  systemLayoutRoleValues,
  type SystemLayoutRole,
} from '../shared/project-schema/authoring-layouts';
import { assetRefSchema } from '../shared/project-schema/authoring-flow';
import {
  editorChaptersStateSchema,
  editorRecordMetadataStateSchema,
  editorTagsStateSchema,
} from '../shared/project-schema/editor-project-state';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../shared/project-workspace/project-workspace-contracts';
import { NOVELTEA_CLI_VERSION } from './contracts';
import {
  loadAgentKitProvenance,
  loadAgentKitSourceFiles,
  loadAgentKitSystemLayoutSourceFiles,
} from './agent-kit/source';

export const NOVELTEA_AGENT_KIT_SCHEMA = 'noveltea.agent-kit.manifest' as const;
export const NOVELTEA_AGENT_KIT_SCHEMA_VERSION = 2 as const;
export const NOVELTEA_AGENT_KIT_VERSION = 1 as const;

const provenanceSourceIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const provenanceSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repository'),
      repository: z.string().min(1),
      revision: z.string().min(1),
      version: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('web'),
      url: z.string().min(1),
      version: z.string().min(1).optional(),
    })
    .strict(),
]);
const provenanceDocumentSchema = z
  .object({
    reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    strategy: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            source: provenanceSourceIdSchema,
            areas: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const agentKitProvenanceSchema = z
  .object({
    sources: z.record(provenanceSourceIdSchema, provenanceSourceSchema),
    documents: z.record(z.string().min(1), provenanceDocumentSchema),
  })
  .strict();

export type NovelTeaAgentKitProvenance = z.infer<typeof agentKitProvenanceSchema>;

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

const systemLayoutReferenceByRole: Readonly<
  Record<
    SystemLayoutRole,
    {
      readonly document: string | null;
      readonly supportingFiles: readonly string[];
    }
  >
> = {
  title: {
    document: 'ui/title/default-title.rml',
    supportingFiles: ['ui/title/default-title.rcss'],
  },
  'game-hud': {
    document: 'ui/runtime/runtime_game.rml',
    supportingFiles: ['ui/runtime/runtime_game.rcss'],
  },
  'pause-menu': {
    document: 'ui/menu/pause-menu.rml',
    supportingFiles: ['ui/menu/pause-menu.rcss'],
  },
  'save-menu': {
    document: 'ui/menu/save-menu.rml',
    supportingFiles: ['ui/menu/system-menu.rcss'],
  },
  'load-menu': {
    document: 'ui/menu/load-menu.rml',
    supportingFiles: ['ui/menu/system-menu.rcss'],
  },
  'settings-menu': {
    document: 'ui/menu/settings-menu.rml',
    supportingFiles: ['ui/menu/system-menu.rcss'],
  },
  'text-log': {
    document: 'ui/menu/text-log.rml',
    supportingFiles: ['ui/menu/system-menu.rcss'],
  },
  modal: {
    document: 'ui/menu/modal.rml',
    supportingFiles: ['ui/menu/system-menu.rcss'],
  },
  'debug-overlay': { document: null, supportingFiles: [] },
};

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

function jsonText(value: unknown): string {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

function schemaText(schema: z.ZodType): string {
  return jsonText(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
}

function systemLayoutManifestText(
  systemLayoutSourceFiles: Readonly<Record<string, string>>,
): string {
  for (const role of systemLayoutRoleValues) {
    const reference = systemLayoutReferenceByRole[role];
    for (const relativePath of [reference.document, ...reference.supportingFiles]) {
      if (relativePath !== null && !Object.hasOwn(systemLayoutSourceFiles, relativePath))
        throw new Error(
          `Built-in system Layout reference for '${role}' requires missing source '${relativePath}'.`,
        );
    }
  }

  const baselineLayers = [
    {
      id: 'rmlui-html4',
      path: 'ui/baseline/rmlui-html4.rcss',
      authoringUrl: 'system|/ui/baseline/rmlui-html4.rcss',
    },
    {
      id: 'noveltea',
      path: 'ui/baseline/noveltea.rcss',
      authoringUrl: 'system|/ui/baseline/noveltea.rcss',
    },
  ] as const;
  for (const layer of baselineLayers) {
    if (!Object.hasOwn(systemLayoutSourceFiles, layer.path))
      throw new Error(`Universal RCSS baseline requires missing source '${layer.path}'.`);
  }

  return jsonText({
    schema: 'noveltea.agent-kit.system-layouts',
    schemaVersion: 2,
    baselines: {
      implicit: true,
      appliesTo: [
        'built-in-system-layouts',
        'project-layouts',
        'fragments',
        'focused-previews',
        'runtime-ui-utility-documents',
      ],
      cascade: [...baselineLayers, { id: 'template-rcss' }, { id: 'document-rcss' }],
    },
    roles: Object.fromEntries(
      systemLayoutRoleValues.map((role) => {
        const reference = systemLayoutReferenceByRole[role];
        return [
          role,
          {
            builtinFallback: reference.document !== null,
            document: reference.document,
            authoringUrl: reference.document === null ? null : `system|/${reference.document}`,
            supportingFiles: reference.supportingFiles,
          },
        ];
      }),
    ),
  });
}

export interface NovelTeaAgentKitPayload {
  readonly manifestText: string;
  readonly files: Readonly<Record<string, string>>;
}

function normalizeAgentKitProvenance(
  value: unknown,
  sourceFiles: Readonly<Record<string, string>>,
): NovelTeaAgentKitProvenance {
  const provenance = agentKitProvenanceSchema.parse(value);
  const sourcePaths = Object.keys(sourceFiles).sort(compareCodePoints);
  const documentPaths = Object.keys(provenance.documents).sort(compareCodePoints);
  if (
    sourcePaths.length !== documentPaths.length ||
    sourcePaths.some((sourcePath, index) => sourcePath !== documentPaths[index])
  )
    throw new Error(
      'Agent-kit provenance must declare exactly one entry for every hand-authored agent-kit source file.',
    );

  for (const [documentPath, document] of Object.entries(provenance.documents)) {
    for (const reference of document.sources) {
      if (!Object.hasOwn(provenance.sources, reference.source))
        throw new Error(
          `Agent-kit provenance for '${documentPath}' references unknown source '${reference.source}'.`,
        );
    }
  }

  return canonicalizeJson(provenance) as NovelTeaAgentKitProvenance;
}

export function createNovelTeaAgentKitPayload(
  sourceFiles: Readonly<Record<string, string>> = loadAgentKitSourceFiles(),
  provenanceSource: unknown = loadAgentKitProvenance(),
  systemLayoutSourceFiles: Readonly<Record<string, string>> = loadAgentKitSystemLayoutSourceFiles(),
): NovelTeaAgentKitPayload {
  const files: Record<string, string> = { ...sourceFiles };
  for (const [relativePath, schema] of Object.entries(schemaSources))
    files[`schemas/${relativePath}`] = schemaText(schema);
  for (const [relativePath, text] of Object.entries(systemLayoutSourceFiles))
    files[`system-layouts/${relativePath}`] = text;
  files['system-layouts/manifest.json'] = systemLayoutManifestText(systemLayoutSourceFiles);

  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => compareCodePoints(left, right)),
  );
  const hashes = Object.fromEntries(
    Object.entries(sortedFiles).map(([relativePath, text]) => [
      relativePath,
      `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    ]),
  );
  const manifest = {
    schema: NOVELTEA_AGENT_KIT_SCHEMA,
    schemaVersion: NOVELTEA_AGENT_KIT_SCHEMA_VERSION,
    agentKitVersion: NOVELTEA_AGENT_KIT_VERSION,
    cliVersion: NOVELTEA_CLI_VERSION,
    projectWorkspaceVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    files: hashes,
    provenance: normalizeAgentKitProvenance(provenanceSource, sourceFiles),
  };
  return {
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    files: Object.freeze(sortedFiles),
  };
}
