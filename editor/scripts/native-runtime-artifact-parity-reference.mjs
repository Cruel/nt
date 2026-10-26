// Independent TypeScript runtime-artifact oracle. Only native-admitted Project
// JSON is accepted on stdin; this script does not consult the runtime cache.
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const { project, referencedAssetIds, profile = project.export.runtime, nativeArtifact } =
  JSON.parse(readFileSync(0, 'utf8'));
const server = await createServer({
  configFile: false,
  root: new URL('../', import.meta.url).pathname,
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { prepareRuntimeArtifact, logicalRuntimeArtifactPaths } = await server.ssrLoadModule(
    '/src/shared/runtime-artifact-preparation.ts',
  );
  const { preparedRuntimeArtifactSchema } = await server.ssrLoadModule(
    '/src/shared/project-schema/prepared-runtime-artifact.ts',
  );
  const { authoringCollectionKeys } = await server.ssrLoadModule(
    '/src/shared/project-schema/authoring-collections.ts',
  );
  const { emptyEditorProjectState } = await server.ssrLoadModule(
    '/src/shared/project-schema/editor-project-state.ts',
  );
  const { canonicalProjectContentJson } = await server.ssrLoadModule(
    '/src/shared/project-schema/editor-project-state.ts',
  );
  for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
  if (!project.editor) project.editor = emptyEditorProjectState();
  const prepared = await prepareRuntimeArtifact({
    project,
    projectRoot: null,
    profile,
    intent: 'runtime-package-preflight',
    paths: logicalRuntimeArtifactPaths,
    admittedAuthoringDiagnostics: [],
    admittedRuntimeAssetReferences: referencedAssetIds,
  });
  const artifact = prepared.status === 'prepared' ? prepared.artifact : undefined;
  process.stdout.write(JSON.stringify({
    status: prepared.status,
    canonicalContent: canonicalProjectContentJson({ ...project, tests: {} }),
    diagnostics: prepared.status === 'cancelled' ? prepared.diagnostics : prepared.assessment.diagnostics,
    ...(artifact ? { artifact, schemaValid: preparedRuntimeArtifactSchema.safeParse(artifact).success } : {}),
    ...(nativeArtifact
      ? { nativeSchemaValid: preparedRuntimeArtifactSchema.safeParse(nativeArtifact).success }
      : {}),
  }) + '\n');
} finally {
  await server.close();
}
