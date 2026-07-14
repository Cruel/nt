import type { AuthoringProject } from './project-schema/authoring-project';
import { compileAuthoringProject, type CompileResult } from './authoring-compiler';
import type { CompiledProjectWireV1 } from './project-schema/compiled-project';

export type CompiledArtifactPublication = Readonly<{
  project: CompiledProjectWireV1;
  gameplayJson: string;
}>;

export type CompiledArtifactPublicationResult = CompileResult<CompiledArtifactPublication>;

/**
 * Shared additive publication boundary for every Phase 10B consumer. It delegates
 * exclusively to compileAuthoringProject and publishes its canonical gameplay bytes.
 */
export function publishCompiledArtifact(
  project: AuthoringProject,
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
