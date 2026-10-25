import { lowerDialogueAndInteractionPrograms } from './authoring-compiler-dialogue-interaction-lowering';
import { lowerSceneAndRoomPrograms } from './authoring-compiler-scene-room-lowering';
import { lowerSharedAuthoringProject } from './authoring-compiler-shared-lowering';
import { lowerManagedLuaLocalization } from './authoring-lua-localization-lowering';
import { withPackageMessageIds } from './authoring-message-lowering';
import { compileFlowPredictionIndex } from './flow-prediction-index-compiler';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  compiledProjectWireSchema,
  computeCompiledProjectSaveContract,
  type CompiledDiagnostic,
  type CompiledProjectWire,
} from './project-schema/compiled-project';

export const compilerStageNames = [
  'normalize',
  'semantic-validation',
  'link',
  'lower',
  'collect-resources',
  'assemble',
  'validate-wire',
  'serialize',
] as const;

export type CompilerStageName = (typeof compilerStageNames)[number];
export type CompilerStageStatus = 'completed' | 'failed' | 'skipped';

export interface CompilerStageReport {
  name: CompilerStageName;
  status: CompilerStageStatus;
}

export interface CompileSuccess<Project> {
  canonicalJson: string;
  diagnostics: readonly CompiledDiagnostic[];
  ok: true;
  project: Project;
  stages: readonly CompilerStageReport[];
}

export interface CompileFailure {
  diagnostics: readonly CompiledDiagnostic[];
  ok: false;
  stages: readonly CompilerStageReport[];
}

export interface AuthoringPreflightResult {
  diagnostics: readonly CompiledDiagnostic[];
  stages: readonly CompilerStageReport[];
}

export type CompileResult<Project> = CompileSuccess<Project> | CompileFailure;
export type CompileValueResult<Project> =
  | Omit<CompileSuccess<Project>, 'canonicalJson'>
  | CompileFailure;

interface CompilerContext {
  diagnostics: CompiledDiagnostic[];
  normalizedProject?: AuthoringProject;
  stages: CompilerStageReport[];
}

interface LoweringResult {
  diagnostics: CompiledDiagnostic[];
  project?: CompiledProjectWire;
}

interface ResourceReferenceClosure {
  assets: ReadonlySet<string>;
  animations: ReadonlySet<string>;
  layouts: ReadonlySet<string>;
  materials: ReadonlySet<string>;
  scripts: ReadonlySet<string>;
}

function collectResourceReferenceClosure(project: CompiledProjectWire): ResourceReferenceClosure {
  const assets = new Set<string>();
  const animations = new Set<string>();
  const layouts = new Set<string>();
  const materials = new Set<string>();
  const scripts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = Object.fromEntries(Object.entries(value));
    if (typeof record.id === 'string') {
      if (record.kind === 'asset') assets.add(record.id);
      else if (record.kind === 'animation') animations.add(record.id);
      else if (record.kind === 'layout') layouts.add(record.id);
      else if (record.kind === 'material') materials.add(record.id);
      else if (record.kind === 'script') scripts.add(record.id);
    }
    Object.values(record).forEach(visit);
  };
  visit(project);
  return { assets, animations, layouts, materials, scripts };
}

function validateResourceClosure(project: CompiledProjectWire): CompiledDiagnostic[] {
  const closure = collectResourceReferenceClosure(project);
  const availableAssets = new Set(project.resources.assets.map((resource) => resource.id));
  const availableAnimations = new Set(project.resources.animations.map((resource) => resource.id));
  const availableLayouts = new Set(project.resources.layouts.map((resource) => resource.id));
  const availableScripts = new Set(project.resources.scripts.map((resource) => resource.id));
  const diagnostics: CompiledDiagnostic[] = [];
  for (const assetId of [...closure.assets].sort()) {
    if (!availableAssets.has(assetId))
      diagnostics.push(
        makeDiagnostic(
          'COMPILER_RESOURCE_ASSET_MISSING',
          'error',
          '/resources/assets',
          `Referenced asset '${assetId}' is absent from the gameplay resource table.`,
        ),
      );
  }
  for (const animationId of [...closure.animations].sort()) {
    if (!availableAnimations.has(animationId))
      diagnostics.push(
        makeDiagnostic(
          'COMPILER_RESOURCE_ANIMATION_MISSING',
          'error',
          '/resources/animations',
          `Referenced Animation '${animationId}' is absent from the gameplay resource table.`,
        ),
      );
  }
  for (const layoutId of [...closure.layouts].sort()) {
    if (!availableLayouts.has(layoutId))
      diagnostics.push(
        makeDiagnostic(
          'COMPILER_RESOURCE_LAYOUT_MISSING',
          'error',
          '/resources/layouts',
          `Referenced layout '${layoutId}' is absent from the gameplay resource table.`,
        ),
      );
  }
  for (const scriptId of [...closure.scripts].sort()) {
    if (!availableScripts.has(scriptId))
      diagnostics.push(
        makeDiagnostic(
          'COMPILER_RESOURCE_SCRIPT_MISSING',
          'error',
          '/resources/scripts',
          `Referenced script '${scriptId}' is absent from the gameplay resource table.`,
        ),
      );
  }
  // Materials remain typed references resolved by the separate authoritative
  // shader/material manifest. They are intentionally not copied into gameplay.
  void closure.materials;
  return diagnostics;
}

const authoringSourcePath = 'authoring-project';

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeDiagnosticCode(value: string): string {
  return (
    value
      .replaceAll(/[^a-zA-Z0-9]+/g, '_')
      .replaceAll(/^_+|_+$/g, '')
      .toUpperCase() || 'UNKNOWN'
  );
}

function makeDiagnostic(
  code: string,
  severity: CompiledDiagnostic['severity'],
  jsonPointer: string,
  message: string,
  sourcePath = authoringSourcePath,
): CompiledDiagnostic {
  return {
    code,
    severity,
    sourcePath,
    jsonPointer,
    message,
    sortKey: { code, sourcePath, jsonPointer },
  };
}

function sortAndDedupeDiagnostics(
  diagnostics: readonly CompiledDiagnostic[],
): CompiledDiagnostic[] {
  const compareStrings = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const sorted = [...diagnostics].sort((left, right) => {
    const source = compareStrings(left.sortKey.sourcePath, right.sortKey.sourcePath);
    if (source !== 0) return source;
    const pointer = compareStrings(left.sortKey.jsonPointer, right.sortKey.jsonPointer);
    if (pointer !== 0) return pointer;
    const code = compareStrings(left.sortKey.code, right.sortKey.code);
    if (code !== 0) return code;
    const severity = compareStrings(left.severity, right.severity);
    if (severity !== 0) return severity;
    return compareStrings(left.message, right.message);
  });

  const deduplicated: CompiledDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of sorted) {
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.sourcePath,
      diagnostic.jsonPointer,
      diagnostic.message,
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(diagnostic);
  }
  return deduplicated;
}

function addStage(
  context: CompilerContext,
  name: CompilerStageName,
  status: CompilerStageStatus,
): void {
  context.stages.push({ name, status });
}

function addSkippedStages(context: CompilerContext, names: readonly CompilerStageName[]): void {
  names.forEach((name) => addStage(context, name, 'skipped'));
}

function hasErrors(diagnostics: readonly CompiledDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/** Lowers every specialized family into the complete, unpublished wire draft. */
function lowerAuthoringProject(project: AuthoringProject): LoweringResult {
  const managedLua = lowerManagedLuaLocalization(project);
  const loweringProject = managedLua.project;
  return withPackageMessageIds(loweringProject, () => {
    const shared = lowerSharedAuthoringProject(loweringProject);
    const diagnostics = managedLua.diagnostics.map((diagnostic) =>
      makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
    );
    diagnostics.push(
      ...shared.diagnostics.map((diagnostic) =>
        makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
      ),
    );
    if (shared.draft) {
      const programs = lowerSceneAndRoomPrograms(loweringProject, shared.draft);
      diagnostics.push(
        ...programs.diagnostics.map((diagnostic) =>
          makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
        ),
      );
      if (programs.draft) {
        const remainingPrograms = lowerDialogueAndInteractionPrograms(
          loweringProject,
          programs.draft,
        );
        diagnostics.push(
          ...remainingPrograms.diagnostics.map((diagnostic) =>
            makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
          ),
        );
        if (remainingPrograms.draft) return { diagnostics, project: remainingPrograms.draft };
      }
    }
    return { diagnostics };
  });
}

function finish(context: CompilerContext): CompileFailure {
  return {
    ok: false,
    diagnostics: sortAndDedupeDiagnostics(context.diagnostics),
    stages: context.stages,
  };
}

/** Lightweight validation-only compiler preflight for an already admitted Project. */
export function preflightAdmittedAuthoringProject(
  project: AuthoringProject,
): AuthoringPreflightResult {
  const context: CompilerContext = {
    diagnostics: [],
    normalizedProject: project,
    stages: [{ name: 'normalize', status: 'skipped' }],
  };
  // Native admission owns Project semantics and reference integrity.
  addStage(context, 'semantic-validation', 'skipped');
  addStage(context, 'link', 'skipped');
  if (!hasErrors(context.diagnostics) && !project.entrypoint)
    context.diagnostics.push(
      makeDiagnostic(
        'COMPILER_ENTRYPOINT_REQUIRED',
        'error',
        '/entrypoint',
        'A Room, Scene, or Dialogue entrypoint is required for compiled gameplay.',
      ),
    );
  addSkippedStages(context, [
    'lower',
    'collect-resources',
    'assemble',
    'validate-wire',
    'serialize',
  ]);
  return {
    diagnostics: sortAndDedupeDiagnostics(context.diagnostics),
    stages: context.stages,
  };
}

/** Validated compiler output for consumers that finalize the value before serializing it. */
export function compileAuthoringProjectValue(
  project: AuthoringProject,
): CompileValueResult<CompiledProjectWire> {
  const context: CompilerContext = { diagnostics: [], stages: [] };

  // Native admission already established the current schema and semantic generation.
  // The runtime projection is only allowed to lower this admitted value, not re-admit it.
  context.normalizedProject = project as AuthoringProject;
  addStage(context, 'normalize', 'skipped');

  if (!context.normalizedProject) {
    addSkippedStages(context, [
      'semantic-validation',
      'link',
      'lower',
      'collect-resources',
      'assemble',
      'validate-wire',
      'serialize',
    ]);
    return finish(context);
  }

  addStage(context, 'semantic-validation', 'skipped');
  if (hasErrors(context.diagnostics)) {
    addSkippedStages(context, [
      'link',
      'lower',
      'collect-resources',
      'assemble',
      'validate-wire',
      'serialize',
    ]);
    return finish(context);
  }

  addStage(context, 'link', 'skipped');

  const lowered = lowerAuthoringProject(context.normalizedProject);
  context.diagnostics.push(...lowered.diagnostics);
  addStage(context, 'lower', hasErrors(lowered.diagnostics) ? 'failed' : 'completed');
  if (!lowered.project || hasErrors(context.diagnostics)) {
    addSkippedStages(context, ['collect-resources', 'assemble', 'validate-wire', 'serialize']);
    return finish(context);
  }

  const resourceDiagnostics = validateResourceClosure(lowered.project);
  context.diagnostics.push(...resourceDiagnostics);
  addStage(context, 'collect-resources', hasErrors(resourceDiagnostics) ? 'failed' : 'completed');
  if (hasErrors(context.diagnostics)) {
    addSkippedStages(context, ['assemble', 'validate-wire', 'serialize']);
    return finish(context);
  }
  const flowPrediction = compileFlowPredictionIndex(
    lowered.project,
    context.normalizedProject.prefetchHints,
  );
  if (flowPrediction) lowered.project.flowPrediction = flowPrediction;
  // Lowerers sort definition/resource tables by stable ID and preserve every
  // semantically ordered authored array. Assembly binds the complete value to the
  // compiler-produced persistent Save Contract before publication.
  lowered.project.saveContract = computeCompiledProjectSaveContract(lowered.project);
  addStage(context, 'assemble', 'completed');
  const validated = compiledProjectWireSchema.safeParse(lowered.project);
  if (!validated.success) {
    validated.error.issues.forEach((issue) =>
      context.diagnostics.push(
        makeDiagnostic(
          `COMPILED_WIRE_${normalizeDiagnosticCode(issue.code)}`,
          'error',
          `/${issue.path.map(String).map(escapeJsonPointerSegment).join('/')}`,
          issue.message,
          'compiled-project',
        ),
      ),
    );
    addStage(context, 'validate-wire', 'failed');
    addSkippedStages(context, ['serialize']);
    return finish(context);
  }
  addStage(context, 'validate-wire', 'completed');
  const diagnostics = sortAndDedupeDiagnostics(context.diagnostics);
  if (hasErrors(diagnostics)) {
    addStage(context, 'serialize', 'skipped');
    return { ok: false, diagnostics, stages: context.stages };
  }
  return {
    ok: true,
    project: validated.data,
    diagnostics,
    stages: context.stages,
  };
}
