import { z } from 'zod';
import { authoringCollectionKeys } from './authoring-collections';
import { parseJsonPointer } from '../json-pointer';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const AUTHORING_SOURCE_ANALYZER_VERSION = 'lua-rml-v1' as const;
export const LUA_REFERENCE_ANALYSIS_LIMITS = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxSnapshotBytes: 64 * 1024 * 1024,
  maxSnapshotLiteralOccurrences: 1_048_576,
  maxTemplateDepth: 32,
  maxTemplatesPerLayout: 1024,
  maxEmbeddedListenerDepth: 8,
  maxLiteralOccurrencesPerSemanticOwner: 65_536,
} as const;

export const luaExplicitDependencyTargetSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('record'),
    collection: z.enum(authoringCollectionKeys),
    id: z.string().min(1),
  }),
  strict({ kind: z.literal('property-definition'), propertyId: z.string().min(1) }),
  strict({
    kind: z.literal('property-value'),
    owner: strict({
      kind: z.enum([
        'room',
        'scene',
        'dialogue',
        'character',
        'interactable',
        'verb',
        'interaction',
        'map',
      ]),
      id: z.string().min(1),
    }),
    propertyId: z.string().min(1),
  }),
  strict({
    kind: z.literal('room-placement'),
    roomId: z.string().min(1),
    placementId: z.string().min(1),
  }),
  strict({ kind: z.literal('room-exit'), roomId: z.string().min(1), exitId: z.string().min(1) }),
]);
export const luaExplicitDependenciesSchema = strict({
  targets: z.array(luaExplicitDependencyTargetSchema).default([]),
});
export type LuaExplicitDependencyTarget = z.infer<typeof luaExplicitDependencyTargetSchema>;
export type LuaExplicitDependencies = z.infer<typeof luaExplicitDependenciesSchema>;
export const emptyLuaExplicitDependencies = (): LuaExplicitDependencies => ({ targets: [] });
export const defaultedLuaExplicitDependenciesSchema = luaExplicitDependenciesSchema
  .optional()
  .overwrite((value) => value ?? { targets: [] });

export type EmbeddedLuaSourceKind =
  | 'lua-field'
  | 'rml-event-attribute'
  | 'rml-inline-script'
  | 'rml-script-src'
  | 'rml-template'
  | 'lua-listener-string'
  | 'lua-load-string';
export interface EmbeddedLuaSourceRegion<TOwner = unknown> {
  semanticOwner: TOwner;
  sourceKind: EmbeddedLuaSourceKind;
  sourcePath: string;
  sourceAssetId?: string;
  containerContentHash: `sha256:${string}`;
  regionOrdinal: number;
  parentRegionOrdinal?: number;
  containerLine: number;
  containerColumn: number;
  decodedSource: string;
}
export interface AuthoringLiteralOccurrence {
  sourcePath: string;
  sourceAssetId?: string;
  sourceContentHash: `sha256:${string}`;
  regionOrdinal: number;
  regionStartUtf16: number;
  regionEndUtf16: number;
  line: number;
  column: number;
  rawLiteral: string;
  decodedValue: string;
  literalKind: 'single-quoted' | 'double-quoted' | 'long-bracket';
  sourceKind: EmbeddedLuaSourceKind;
}
export interface LuaReferenceOccurrence<TTarget = unknown> extends AuthoringLiteralOccurrence {
  confidence: 'lexical' | 'api-context';
  candidateTargets: readonly TTarget[];
}
export interface OwnerNeutralEmbeddedLuaSourceRegion extends Omit<
  EmbeddedLuaSourceRegion,
  'semanticOwner' | 'sourcePath' | 'sourceAssetId'
> {
  sourceUrl: string;
}
export interface OwnerNeutralLiteralOccurrence extends Omit<
  AuthoringLiteralOccurrence,
  'sourcePath' | 'sourceAssetId'
> {
  sourceUrl: string;
}
export interface OwnerNeutralSourceDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sourceUrl: string;
  regionOrdinal?: number;
  line?: number;
  column?: number;
}
export interface AuthoringSourceContentArtifact {
  analyzerVersion: string;
  sourceContentFingerprint: `sha256:${string}`;
  regions: readonly OwnerNeutralEmbeddedLuaSourceRegion[];
  literalOccurrences: readonly OwnerNeutralLiteralOccurrence[];
  diagnostics: readonly OwnerNeutralSourceDiagnostic[];
  complete: boolean;
}
export interface AuthoringSourceAnalysisArtifact<TDiagnostic = unknown> {
  semanticOwnerKey: string;
  analyzerVersion: string;
  sourceContentFingerprints: readonly `sha256:${string}`[];
  ownerProjectionFingerprint: `sha256:${string}`;
  sourceAssetIds: readonly string[];
  regions: readonly EmbeddedLuaSourceRegion[];
  literalOccurrences: readonly AuthoringLiteralOccurrence[];
  diagnostics: readonly TDiagnostic[];
  complete: boolean;
}
export type LuaSourceSnapshotEntry<TDiagnostic = unknown> =
  | {
      status: 'ready';
      assetId: string;
      projectRelativePath: string;
      contentHash: `sha256:${string}`;
      text: string;
      hadUtf8Bom: boolean;
    }
  | {
      status: 'unavailable';
      assetId: string;
      expectedContentHash: string | null;
      diagnostic: TDiagnostic;
    };
export interface LuaSourceSnapshot<TDiagnostic = unknown> {
  entriesByAssetId: ReadonlyMap<string, LuaSourceSnapshotEntry<TDiagnostic>>;
}
export type LuaAnalysisInput<TDiagnostic = unknown> =
  | { mode: 'disabled' }
  | { mode: 'enabled'; sources: LuaSourceSnapshot<TDiagnostic> };
export interface VersionedLuaSourceSnapshot<TDiagnostic = unknown> {
  projectInstanceId: string;
  projectRevision: number;
  sources: LuaSourceSnapshot<TDiagnostic>;
}
export interface FocusedLuaReadAdmission {
  recordTargets: readonly LuaExplicitDependencyTarget[];
  variableIds: readonly string[];
  propertyValues: readonly { ownerKind: string; ownerId: string; propertyId: string }[];
  interactableLocationIds: readonly string[];
}
export interface RoomCompositionDraftAdmission {
  characterIds: readonly string[];
  interactableIds: readonly string[];
}

export const AUTHORING_LUA_EXECUTION_SURFACES = [
  'project-startup-hook',
  'script-record-inline',
  'script-record-asset',
  'layout-dedicated-inline',
  'layout-dedicated-asset',
  'layout-rml-event-attribute',
  'layout-rml-inline-script',
  'layout-rml-external-script',
  'layout-rml-template',
  'shared-lua-predicate',
  'shared-lua-expression',
  'shared-run-lua-effect',
  'scene-run-lua-step',
  'dialogue-run-lua-segment',
  'verb-condition-or-text',
  'interaction-condition-or-effect',
  'test-condition-or-step',
] as const;

export function isSupportedLuaExplicitFallbackOwner(path: string): boolean {
  const segments = parseJsonPointer(path);
  if (segments.length < 3) return false;
  if (segments[0] === 'layouts') return segments[2] === 'data' && segments[3] === 'script';
  if (segments[0] !== 'rooms' || segments[2] !== 'data') return false;
  if (segments[3] === 'compose') return true;
  if (segments[3] === 'description' && segments[4] === 'source') return true;
  if (
    segments[3] === 'placements' &&
    segments[5] === 'presentation' &&
    segments[6] === 'label' &&
    segments[7] === 'source'
  )
    return true;
  return (
    ['overlays', 'cast', 'props', 'environments', 'exits'].includes(segments[3] ?? '') &&
    segments[5] === 'condition'
  );
}

export function validateLuaExplicitFallbackOwner(
  path: string,
  dependencies: LuaExplicitDependencies | undefined,
): { severity: 'warning'; path: string; message: string }[] {
  if (
    !dependencies ||
    dependencies.targets.length === 0 ||
    isSupportedLuaExplicitFallbackOwner(path)
  ) {
    return [];
  }
  return [
    {
      severity: 'warning',
      path: `${path}/additionalDependencies`,
      message:
        'Additional Lua dependencies are preserved but are not consumed for this authoring location yet.',
    },
  ];
}
