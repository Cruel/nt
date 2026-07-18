import { compileAuthoringProject, type CompileResult } from './authoring-compiler';
import type { CompiledProjectWireV1 } from './project-schema/compiled-project';

export type CompiledArtifactPublication = Readonly<{
  project: CompiledProjectWireV1;
  gameplayJson: string;
}>;

export type CompiledArtifactPublicationResult = CompileResult<CompiledArtifactPublication>;

/**
 * Shared production publication boundary. It delegates exclusively to the
 * authoring compiler and publishes the validated compiled value together with
 * its canonical gameplay bytes.
 */
export function publishCompiledArtifact(
  project: unknown,
): CompiledArtifactPublicationResult {
  const compiled = compileAuthoringProject(project);
  if (!compiled.ok) return compiled;
  return {
    ok: true,
    project: {
      project: compiled.project,
      gameplayJson: compiled.canonicalJson,
    },
    canonicalJson: compiled.canonicalJson,
    diagnostics: compiled.diagnostics,
    stages: compiled.stages,
  };
}
