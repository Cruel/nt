/** Select source surfaces from already-admitted native Project data. No TS parsing,
 * default expansion, validation or semantic authority is allowed here. */
import type {
  AuthoringDependencyContributionKey,
  AuthoringDependencyNodeKey,
} from './authoring-dependency-contracts';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { buildJsonPointer, escapeJsonPointerSegment } from './json-pointer';
import type { parseLayoutData } from './project-schema/authoring-layouts';
import type { parseScriptModuleData } from './project-schema/authoring-script-modules';
import {
  collectRegisteredAuthoringLuaSources,
  isRegisteredLuaExplicitFallbackOwner,
  type AuthoringLuaExecutionSurface,
  type RegisteredAuthoringLuaSource,
} from './project-schema/authoring-lua-source-registry';
import { authoringAssetPath as assetPath } from './layout-source-resolution';
import { inlineLayoutSourceUrl } from './project-schema/layout-source-url';

export type AuthoringLuaSourceDescriptor = {
  executionSurface: AuthoringLuaExecutionSurface;
  contributionKey: AuthoringDependencyContributionKey;
  semanticOwner: AuthoringDependencyNodeKey;
  sourcePath: string;
  sourceKind: 'lua' | 'rml' | 'rcss';
  sourceUrl: string;
  inlineText?: string;
  sourceAssetId?: string;
  focusedAdmission: boolean;
  focusedFacet?: 'preview-visual' | 'preview-ui';
  supportsExplicitFallback: boolean;
  explicitDependenciesPath?: string;
  explicitDependencies?: readonly unknown[];
  layoutId?: string;
  dependencyScriptPaths?: readonly string[];
  dependencyTemplateIds?: readonly string[];
};

export const recordKey = (
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringDependencyNodeKey => ({
  kind: 'record',
  collection,
  id,
});
const recordContributionKey = (collection: AuthoringCollectionKey, id: string) =>
  `record:${JSON.stringify(['record', collection, id])}`;

const schemaParsers = {
  rooms: true,
  scenes: true,
  dialogues: true,
  verbs: true,
  interactions: true,
  maps: true,
  tests: true,
} as const;

function sourceDescriptorFromScript(
  project: AuthoringProject,
  scriptId: string,
  owner: AuthoringDependencyNodeKey,
  contributionKey: string,
  sourcePath: string,
  ownerBasePath: readonly string[],
  registered: RegisteredAuthoringLuaSource,
): AuthoringLuaSourceDescriptor | null {
  const parsed = project.scripts[scriptId]?.data as
    | NonNullable<ReturnType<typeof parseScriptModuleData>>
    | undefined;
  if (!parsed) return null;
  return {
    executionSurface: registered.surface,
    contributionKey,
    semanticOwner: owner,
    sourcePath,
    sourceKind: 'lua',
    sourceUrl:
      parsed.source.kind === 'inline-lua'
        ? 'authoring:inline-lua'
        : `project:/${parsed.source.path}`,
    inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
    focusedAdmission: registered.focusedAdmission,
    focusedFacet: registered.focusedFacet,
    supportsExplicitFallback: registered.supportsExplicitFallback,
    explicitDependenciesPath: registered.explicitDependenciesPath
      ? buildJsonPointer([...ownerBasePath, ...registered.explicitDependenciesPath])
      : undefined,
    explicitDependencies: registered.explicitDependencies,
  };
}

export function collectAuthoringLuaSources(
  project: AuthoringProject,
  contributionKeys?: ReadonlySet<AuthoringDependencyContributionKey>,
): readonly AuthoringLuaSourceDescriptor[] {
  const output: AuthoringLuaSourceDescriptor[] = [];
  const appendScript = (id: string) => {
    const record = project.scripts[id];
    if (!record) return;
    const contributionKey = recordContributionKey('scripts', id);
    const parsed = record.data as NonNullable<ReturnType<typeof parseScriptModuleData>>;
    if (!parsed) return;
    const base = `/scripts/${escapeJsonPointerSegment(id)}/data/source`;
    output.push({
      executionSurface: 'script-record',
      contributionKey,
      semanticOwner: recordKey('scripts', id),
      sourcePath: parsed.source.kind === 'inline-lua' ? `${base}/source` : `${base}/path`,
      sourceKind: 'lua',
      sourceUrl:
        parsed.source.kind === 'inline-lua'
          ? 'authoring:inline-lua'
          : `project:/${parsed.source.path}`,
      inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
      focusedAdmission: false,
      supportsExplicitFallback: false,
    });
  };
  const appendLayout = (id: string) => {
    const record = project.layouts[id];
    if (!record) return;
    const contributionKey = recordContributionKey('layouts', id);
    const parsed = record.data as NonNullable<ReturnType<typeof parseLayoutData>>;
    if (!parsed) return;
    const owner = recordKey('layouts', id);
    for (const [name, sourceKind] of [
      ['lua', 'lua'],
      ['rml', 'rml'],
      ['rcss', 'rcss'],
    ] as const) {
      const source = parsed[name];
      const base = `/layouts/${escapeJsonPointerSegment(id)}/data/${name}`;
      const sourceAssetId = source.sourceMode === 'asset' ? source.sourceAsset?.$ref.id : undefined;
      const sourceAssetPath = sourceAssetId ? assetPath(project, sourceAssetId) : null;
      output.push({
        executionSurface: name === 'lua' ? 'layout-dedicated-lua' : 'layout-rml',
        contributionKey,
        semanticOwner: owner,
        sourcePath:
          source.sourceMode === 'inline' ? `${base}/sourceText` : `${base}/sourceAsset/$ref`,
        sourceKind,
        sourceUrl:
          source.sourceMode === 'inline'
            ? sourceKind === 'rml'
              ? inlineLayoutSourceUrl(id)
              : sourceKind === 'rcss'
                ? 'authoring:inline-rcss'
                : 'authoring:inline-lua'
            : sourceAssetPath
              ? `project:/${sourceAssetPath}`
              : sourceKind === 'rml'
                ? 'project:/__missing_layout.rml'
                : sourceKind === 'rcss'
                  ? 'project:/__missing_layout.rcss'
                  : 'project:/__missing_layout.lua',
        inlineText: source.sourceMode === 'inline' ? source.sourceText : undefined,
        sourceAssetId,
        focusedAdmission: name === 'rml' || (name === 'lua' && parsed.script.enabled),
        focusedFacet: 'preview-ui',
        supportsExplicitFallback:
          name === 'rml' && isRegisteredLuaExplicitFallbackOwner(['layouts', id, 'data', 'script']),
        explicitDependenciesPath:
          name === 'rml'
            ? `/layouts/${escapeJsonPointerSegment(id)}/data/script/additionalDependencies`
            : undefined,
        explicitDependencies:
          name === 'rml' ? parsed.script.additionalDependencies?.targets : undefined,
        layoutId: id,
        dependencyScriptPaths: parsed.dependencies.scripts,
        dependencyTemplateIds: (parsed.dependencies.templates ?? []).map((ref) => ref.$ref.id),
      });
    }
  };
  const appendRegistered = (collection: keyof typeof schemaParsers, id: string) => {
    const record = project[collection][id];
    if (!record) return;
    const contributionKey = recordContributionKey(collection, id);
    const parsed = record.data as unknown;
    if (!parsed) return;
    const baseSegments = [collection, id, 'data'];
    const owner = recordKey(collection, id);
    for (const registered of collectRegisteredAuthoringLuaSources(collection, parsed)) {
      const absoluteSourcePath = buildJsonPointer([...baseSegments, ...registered.sourcePath]);
      if (registered.scriptRecordId) {
        const descriptor = sourceDescriptorFromScript(
          project,
          registered.scriptRecordId,
          owner,
          contributionKey,
          absoluteSourcePath,
          baseSegments,
          registered,
        );
        if (descriptor) output.push(descriptor);
        continue;
      }
      output.push({
        executionSurface: registered.surface,
        contributionKey,
        semanticOwner: owner,
        sourcePath: absoluteSourcePath,
        sourceKind: 'lua',
        sourceUrl: 'authoring:inline-lua',
        inlineText: registered.sourceText,
        focusedAdmission: registered.focusedAdmission,
        focusedFacet: registered.focusedFacet,
        supportsExplicitFallback: registered.supportsExplicitFallback,
        explicitDependenciesPath: registered.explicitDependenciesPath
          ? buildJsonPointer([...baseSegments, ...registered.explicitDependenciesPath])
          : undefined,
        explicitDependencies: registered.explicitDependencies,
      });
    }
  };

  if (contributionKeys) {
    const selected: Array<readonly [AuthoringCollectionKey, string]> = [];
    const collectionKeys = new Set<string>(authoringCollectionKeys);
    for (const key of contributionKeys) {
      if (!key.startsWith('record:')) continue;
      try {
        const parsed = JSON.parse(key.slice('record:'.length)) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed[0] !== 'record' ||
          typeof parsed[1] !== 'string' ||
          !collectionKeys.has(parsed[1]) ||
          typeof parsed[2] !== 'string'
        )
          continue;
        selected.push([parsed[1] as AuthoringCollectionKey, parsed[2]]);
      } catch {
        continue;
      }
    }
    selected.sort(
      ([leftCollection, leftId], [rightCollection, rightId]) =>
        leftCollection.localeCompare(rightCollection) || leftId.localeCompare(rightId),
    );
    for (const [collection, id] of selected) {
      if (collection === 'scripts') appendScript(id);
      else if (collection === 'layouts') appendLayout(id);
      else if (collection in schemaParsers)
        appendRegistered(collection as keyof typeof schemaParsers, id);
    }
  } else {
    for (const id of Object.keys(project.scripts).sort()) appendScript(id);
    for (const id of Object.keys(project.layouts).sort()) appendLayout(id);
    for (const collection of Object.keys(schemaParsers) as (keyof typeof schemaParsers)[])
      for (const id of Object.keys(project[collection]).sort()) appendRegistered(collection, id);
  }
  return Object.freeze(
    output.sort(
      (a, b) =>
        a.contributionKey.localeCompare(b.contributionKey) ||
        a.sourcePath.localeCompare(b.sourcePath),
    ),
  );
}

export function classifyAuthoringLuaSourceOwner(
  project: AuthoringProject,
  sourcePath: string,
): AuthoringLuaSourceDescriptor | null {
  return (
    collectAuthoringLuaSources(project).find((source) => source.sourcePath === sourcePath) ?? null
  );
}
