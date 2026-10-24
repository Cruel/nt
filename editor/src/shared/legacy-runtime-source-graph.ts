import { buildAuthoringDependencyGraph } from './authoring-dependency-graph';
import { collectAuthoringSourceRequirements } from './authoring-source-analysis';
import { parseAssetData } from './project-schema/authoring-assets';
import { parseLayoutData } from './project-schema/authoring-layouts';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { isSha256Digest } from './project-text-sources';
import { classifyProjectValidationDiagnostics } from './project-schema/project-diagnostic-projection';
import type { LuaSourceSnapshot } from './project-schema/authoring-lua-analysis';
import type { AuthoringProject } from './project-schema/authoring-project';
import type {
  RuntimeArtifactPathAdapter,
  RuntimeSourceGraphAssessment,
} from './runtime-artifact-preparation';

function localizationOwnsAssetReference(sourcePath: string): boolean {
  return (
    sourcePath.startsWith('/localization/assets/') ||
    (sourcePath.startsWith('/localization/locales/') && sourcePath.includes('/fontStack'))
  );
}

export async function legacyRuntimeSourceGraphAssessment(
  project: AuthoringProject,
  projectRoot: string | null,
  paths: RuntimeArtifactPathAdapter,
  admittedAnalysis?: Pick<
    import('./project-workspace/project-workspace-service').ProjectWorkspaceDependencyAnalysis,
    'graph' | 'externalSourceRevisions'
  > & { readonly project: AuthoringProject },
): Promise<RuntimeSourceGraphAssessment | null> {
  // The graph alone is insufficient evidence: a workspace analysis can be
  // partial when an external source was unavailable. In that case preserve
  // the original conservative fallback, which does not prune packaged Assets.
  const requiredAssets = collectAuthoringSourceRequirements(project);
  const requiredProjectFiles = new Set<string>();
  for (const record of Object.values(project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind === 'project-file') requiredProjectFiles.add(source.path);
  }
  for (const record of Object.values(project.layouts)) {
    const layout = parseLayoutData(record.data);
    for (const file of layout?.dependencies.scripts ?? []) requiredProjectFiles.add(file);
  }
  const graphInputsProven = Boolean(
    admittedAnalysis?.project === project &&
    requiredAssets.every((id) => {
      const source = parseAssetData(project.assets[id]?.data);
      return (
        source?.contentHash &&
        isSha256Digest(source.contentHash) &&
        admittedAnalysis.externalSourceRevisions.get(source.source.path)?.contentHash ===
          source.contentHash
      );
    }) &&
    [...requiredProjectFiles].every((path) => admittedAnalysis.externalSourceRevisions.has(path)),
  );
  if (admittedAnalysis && graphInputsProven) {
    const referenced = new Set<string>();
    for (const edge of admittedAnalysis.graph.edgesById.values())
      if (
        edge.target.kind === 'record' &&
        edge.target.collection === 'assets' &&
        !localizationOwnsAssetReference(edge.sourcePath)
      )
        referenced.add(edge.target.id);
    return {
      referencedAssetIds: referenced,
      diagnostics: classifyProjectValidationDiagnostics(
        admittedAnalysis.graph.diagnostics.map((item) => ({ ...item, category: 'Layouts' })),
        { producer: 'authoring' },
      ),
    };
  }
  const requiredSourceAssetIds = collectAuthoringSourceRequirements(project);
  const assetReadEntries = requiredSourceAssetIds.flatMap((assetId) => {
    const data = parseAssetData(project.assets[assetId]?.data);
    const hash = data?.contentHash;
    return data && hash && isSha256Digest(hash)
      ? [{ assetId, projectRelativePath: data.source.path, expectedContentHash: hash }]
      : [];
  });
  if (assetReadEntries.length !== requiredSourceAssetIds.length) return null;

  const projectFilePaths = new Set<string>();
  for (const record of Object.values(project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind === 'project-file') projectFilePaths.add(source.path);
  }
  for (const record of Object.values(project.layouts)) {
    const layout = parseLayoutData(record.data);
    for (const scriptPath of layout?.dependencies.scripts ?? []) projectFilePaths.add(scriptPath);
  }
  const projectFileReadEntries = [...projectFilePaths].sort().map((projectRelativePath, index) => ({
    assetId: `project-file:${index}`,
    projectRelativePath,
    expectedContentHash: null,
  }));
  const readEntries = [...assetReadEntries, ...projectFileReadEntries];
  if (readEntries.length > 0 && !paths.readProjectTextSources) return null;

  const readResults = paths.readProjectTextSources
    ? await paths.readProjectTextSources(projectRoot, readEntries)
    : [];
  const byReadKey = new Map(readResults.map((entry) => [entry.assetId, entry]));
  if (readEntries.some(({ assetId }) => byReadKey.get(assetId)?.status !== 'ready')) return null;

  const sources: LuaSourceSnapshot = {
    entriesByAssetId: new Map(
      assetReadEntries.map(({ assetId, expectedContentHash, projectRelativePath }) => {
        const entry = byReadKey.get(assetId)!;
        if (entry.status !== 'ready')
          throw new Error('Source-read completeness changed unexpectedly.');
        return [
          assetId,
          {
            status: 'ready' as const,
            assetId,
            projectRelativePath,
            contentHash: entry.contentHash ?? expectedContentHash,
            text: entry.text,
            hadUtf8Bom: false,
          },
        ];
      }),
    ),
    entriesByProjectPath: new Map(
      projectFileReadEntries.map(({ assetId, projectRelativePath }) => {
        const entry = byReadKey.get(assetId)!;
        if (entry.status !== 'ready')
          throw new Error('Source-read completeness changed unexpectedly.');
        return [
          projectRelativePath,
          {
            status: 'ready' as const,
            projectRelativePath,
            contentHash: entry.contentHash,
            text: entry.text,
            hadUtf8Bom: false,
          },
        ];
      }),
    ),
  };
  const graph = await buildAuthoringDependencyGraph(project, { mode: 'enabled', sources });
  const referenced = new Set<string>();
  for (const edge of graph.edgesById.values()) {
    if (
      edge.target.kind === 'record' &&
      edge.target.collection === 'assets' &&
      !localizationOwnsAssetReference(edge.sourcePath)
    )
      referenced.add(edge.target.id);
  }
  return {
    referencedAssetIds: referenced,
    diagnostics: classifyProjectValidationDiagnostics(
      graph.diagnostics.map((diagnostic) => ({ ...diagnostic, category: 'Layouts' })),
      { producer: 'authoring' },
    ),
  };
}
