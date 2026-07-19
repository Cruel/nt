import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { parseCharacterData } from './project-schema/authoring-characters';
import {
  compiledProjectWireV1Schema,
  serializeCompiledProjectWireV1,
  type CompiledDiagnostic,
  type CompiledProjectWireV1,
} from './project-schema/compiled-project';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseMapData } from './project-schema/authoring-maps';
import {
  authoringProjectSchema,
  type AuthoringProject,
  type AuthoringRecordBase,
} from './project-schema/authoring-project';
import { projectSettingsFromProject } from './project-schema/authoring-project-settings';
import { buildReferenceIndex } from './project-schema/authoring-references';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseTestData } from './project-schema/authoring-tests';
import { validateAuthoringProject } from './project-schema/authoring-validation';
import { parseVerbData } from './project-schema/authoring-verbs';
import { lowerSharedAuthoringProject } from './authoring-compiler-shared-lowering';
import { lowerSceneAndRoomPrograms } from './authoring-compiler-scene-room-lowering';
import { lowerDialogueAndInteractionPrograms } from './authoring-compiler-dialogue-interaction-lowering';

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

export const compilerNestedNamespaces = [
  'character-pose',
  'character-expression',
  'room-overlay',
  'room-cast',
  'room-prop',
  'room-placement',
  'room-exit',
  'scene-step',
  'scene-branch',
  'scene-choice-option',
  'dialogue-block',
  'dialogue-segment',
  'dialogue-edge',
  'interaction-rule',
  'interaction-instruction',
  'map-location',
  'map-connection',
  'test-step',
  'test-assertion',
] as const;

export type CompilerNestedNamespace = (typeof compilerNestedNamespaces)[number];

export interface NestedAuthoringSymbol {
  id: string;
  ownerId: string;
  sourcePath: string;
}

export interface AuthoringSymbolTables {
  collections: ReadonlyMap<AuthoringCollectionKey, ReadonlyMap<string, AuthoringRecordBase>>;
  nested: ReadonlyMap<CompilerNestedNamespace, ReadonlyMap<string, NestedAuthoringSymbol>>;
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

export type CompileResult<Project> = CompileSuccess<Project> | CompileFailure;

interface CompilerContext {
  diagnostics: CompiledDiagnostic[];
  normalizedProject?: AuthoringProject;
  stages: CompilerStageReport[];
  symbols?: AuthoringSymbolTables;
}

interface LoweringResult {
  diagnostics: CompiledDiagnostic[];
  project?: CompiledProjectWireV1;
}

interface ResourceReferenceClosure {
  assets: ReadonlySet<string>;
  layouts: ReadonlySet<string>;
  materials: ReadonlySet<string>;
  scripts: ReadonlySet<string>;
}

function collectResourceReferenceClosure(project: CompiledProjectWireV1): ResourceReferenceClosure {
  const assets = new Set<string>();
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
      else if (record.kind === 'layout') layouts.add(record.id);
      else if (record.kind === 'material') materials.add(record.id);
      else if (record.kind === 'script') scripts.add(record.id);
    }
    Object.values(record).forEach(visit);
  };
  visit(project);
  return { assets, layouts, materials, scripts };
}

function validateResourceClosure(project: CompiledProjectWireV1): CompiledDiagnostic[] {
  const closure = collectResourceReferenceClosure(project);
  const availableAssets = new Set(project.resources.assets.map((resource) => resource.id));
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
    // Script assets and compiled Script resources intentionally share the wire
    // `kind: script` token. An ID present in the asset table is therefore an
    // asset dependency, not a missing composition Script resource.
    if (!availableScripts.has(scriptId) && !availableAssets.has(scriptId))
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

function normalizeAuthoringProject(value: unknown, context: CompilerContext): void {
  const parsed = authoringProjectSchema.safeParse(value);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      const pointer = `/${issue.path.map(String).map(escapeJsonPointerSegment).join('/')}`;
      context.diagnostics.push(
        makeDiagnostic(
          `AUTHORING_SCHEMA_${normalizeDiagnosticCode(issue.code)}`,
          'error',
          pointer,
          issue.message,
        ),
      );
    });
    addStage(context, 'normalize', 'failed');
    return;
  }

  // Zod parsing publishes a detached V2 value. Settings then receive their
  // explicit project-identity defaults without flattening extends edges or
  // authored property assignments.
  context.normalizedProject = { ...parsed.data, settings: projectSettingsFromProject(parsed.data) };
  addStage(context, 'normalize', 'completed');
}

function validateSemantics(context: CompilerContext): void {
  const project = context.normalizedProject;
  if (!project) {
    addStage(context, 'semantic-validation', 'skipped');
    return;
  }

  validateAuthoringProject(project).forEach((diagnostic) => {
    const category = normalizeDiagnosticCode(diagnostic.category ?? 'Project validation');
    context.diagnostics.push(
      makeDiagnostic(
        `AUTHORING_${category}_${diagnostic.severity.toUpperCase()}`,
        diagnostic.severity,
        diagnostic.path,
        diagnostic.message,
      ),
    );
  });
  addStage(context, 'semantic-validation', hasErrors(context.diagnostics) ? 'failed' : 'completed');
}

function nestedSymbolKey(ownerId: string, id: string): string {
  return `${ownerId}\u0000${id}`;
}

function addNestedSymbol(
  nested: Map<CompilerNestedNamespace, Map<string, NestedAuthoringSymbol>>,
  namespace: CompilerNestedNamespace,
  ownerId: string,
  id: string,
  sourcePath: string,
): void {
  let table = nested.get(namespace);
  if (!table) {
    table = new Map<string, NestedAuthoringSymbol>();
    nested.set(namespace, table);
  }
  table.set(nestedSymbolKey(ownerId, id), { id, ownerId, sourcePath });
}

export function buildAuthoringSymbolTables(project: AuthoringProject): AuthoringSymbolTables {
  const collections = new Map<AuthoringCollectionKey, ReadonlyMap<string, AuthoringRecordBase>>();
  for (const collection of authoringCollectionKeys) {
    const records = new Map<string, AuthoringRecordBase>();
    for (const [id, record] of Object.entries(project[collection])) records.set(id, record);
    collections.set(collection, records);
  }

  const nested = new Map<CompilerNestedNamespace, Map<string, NestedAuthoringSymbol>>();
  Object.entries(project.characters).forEach(([ownerId, record]) => {
    const data = parseCharacterData(record.data);
    data?.poses.forEach((pose, index) =>
      addNestedSymbol(
        nested,
        'character-pose',
        ownerId,
        pose.id,
        `/characters/${escapeJsonPointerSegment(ownerId)}/data/poses/${index}`,
      ),
    );
    data?.expressions.forEach((expression, index) =>
      addNestedSymbol(
        nested,
        'character-expression',
        ownerId,
        expression.id,
        `/characters/${escapeJsonPointerSegment(ownerId)}/data/expressions/${index}`,
      ),
    );
  });
  Object.entries(project.rooms).forEach(([ownerId, record]) => {
    const data = parseRoomData(record.data);
    data?.overlays.forEach((overlay, index) =>
      addNestedSymbol(
        nested,
        'room-overlay',
        ownerId,
        overlay.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/overlays/${index}`,
      ),
    );
    data?.cast.forEach((entry, index) =>
      addNestedSymbol(
        nested,
        'room-cast',
        ownerId,
        entry.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/cast/${index}`,
      ),
    );
    data?.props.forEach((entry, index) =>
      addNestedSymbol(
        nested,
        'room-prop',
        ownerId,
        entry.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/props/${index}`,
      ),
    );
    data?.placements.forEach((placement, index) =>
      addNestedSymbol(
        nested,
        'room-placement',
        ownerId,
        placement.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/placements/${index}`,
      ),
    );
    data?.exits.forEach((exit, index) =>
      addNestedSymbol(
        nested,
        'room-exit',
        ownerId,
        exit.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/exits/${index}`,
      ),
    );
  });
  Object.entries(project.scenes).forEach(([ownerId, record]) => {
    const data = parseSceneData(record.data);
    data?.steps.forEach((step, index) => {
      const stepPath = `/scenes/${escapeJsonPointerSegment(ownerId)}/data/steps/${index}`;
      addNestedSymbol(nested, 'scene-step', ownerId, step.id, stepPath);
      if (step.type === 'conditional-branch')
        step.branches.forEach((branch, branchIndex) =>
          addNestedSymbol(
            nested,
            'scene-branch',
            ownerId,
            branch.id,
            `${stepPath}/branches/${branchIndex}`,
          ),
        );
      if (step.type === 'choice')
        step.options.forEach((option, optionIndex) =>
          addNestedSymbol(
            nested,
            'scene-choice-option',
            ownerId,
            option.id,
            `${stepPath}/options/${optionIndex}`,
          ),
        );
    });
  });
  Object.entries(project.dialogues).forEach(([ownerId, record]) => {
    const data = parseDialogueData(record.data);
    data?.blocks.forEach((block, blockIndex) => {
      const blockPath = `/dialogues/${escapeJsonPointerSegment(ownerId)}/data/blocks/${blockIndex}`;
      addNestedSymbol(nested, 'dialogue-block', ownerId, block.id, blockPath);
      if (block.type === 'sequence')
        block.segments.forEach((segment, segmentIndex) =>
          addNestedSymbol(
            nested,
            'dialogue-segment',
            ownerId,
            segment.id,
            `${blockPath}/segments/${segmentIndex}`,
          ),
        );
    });
    data?.edges.forEach((edge, index) =>
      addNestedSymbol(
        nested,
        'dialogue-edge',
        ownerId,
        edge.id,
        `/dialogues/${escapeJsonPointerSegment(ownerId)}/data/edges/${index}`,
      ),
    );
  });
  Object.entries(project.verbs).forEach(([ownerId, record]) => {
    const data = parseVerbData(record.data);
    data?.defaultProgram.instructions.forEach((instruction, index) =>
      addNestedSymbol(
        nested,
        'interaction-instruction',
        `verb:${ownerId}`,
        instruction.id,
        `/verbs/${escapeJsonPointerSegment(ownerId)}/data/defaultProgram/instructions/${index}`,
      ),
    );
  });
  Object.entries(project.interactions).forEach(([ownerId, record]) => {
    const data = parseInteractionData(record.data);
    data?.rules.forEach((rule, ruleIndex) => {
      addNestedSymbol(
        nested,
        'interaction-rule',
        ownerId,
        rule.id,
        `/interactions/${escapeJsonPointerSegment(ownerId)}/data/rules/${ruleIndex}`,
      );
      rule.program.instructions.forEach((instruction, instructionIndex) =>
        addNestedSymbol(
          nested,
          'interaction-instruction',
          `interaction:${ownerId}:${rule.id}`,
          instruction.id,
          `/interactions/${escapeJsonPointerSegment(ownerId)}/data/rules/${ruleIndex}/program/instructions/${instructionIndex}`,
        ),
      );
    });
  });
  Object.entries(project.maps).forEach(([ownerId, record]) => {
    const data = parseMapData(record.data);
    data?.locations.forEach((location, index) =>
      addNestedSymbol(
        nested,
        'map-location',
        ownerId,
        location.id,
        `/maps/${escapeJsonPointerSegment(ownerId)}/data/locations/${index}`,
      ),
    );
    data?.connections.forEach((connection, index) =>
      addNestedSymbol(
        nested,
        'map-connection',
        ownerId,
        connection.id,
        `/maps/${escapeJsonPointerSegment(ownerId)}/data/connections/${index}`,
      ),
    );
  });
  Object.entries(project.tests).forEach(([ownerId, record]) => {
    const data = parseTestData(record.data);
    data?.steps.forEach((step, stepIndex) => {
      const stepPath = `/tests/${escapeJsonPointerSegment(ownerId)}/data/steps/${stepIndex}`;
      addNestedSymbol(nested, 'test-step', ownerId, step.id, stepPath);
      step.assertions.forEach((assertion, assertionIndex) =>
        addNestedSymbol(
          nested,
          'test-assertion',
          ownerId,
          assertion.id,
          `${stepPath}/assertions/${assertionIndex}`,
        ),
      );
    });
  });
  return { collections, nested };
}

export function resolveAuthoringSymbol(
  symbols: AuthoringSymbolTables,
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringRecordBase | undefined {
  return symbols.collections.get(collection)?.get(id);
}

export function resolveNestedAuthoringSymbol(
  symbols: AuthoringSymbolTables,
  namespace: CompilerNestedNamespace,
  ownerId: string,
  id: string,
): NestedAuthoringSymbol | undefined {
  return symbols.nested.get(namespace)?.get(nestedSymbolKey(ownerId, id));
}

function linkAuthoringProject(context: CompilerContext): void {
  if (!context.normalizedProject || hasErrors(context.diagnostics)) {
    addStage(context, 'link', 'skipped');
    return;
  }
  const symbols = buildAuthoringSymbolTables(context.normalizedProject);
  for (const usage of buildReferenceIndex(context.normalizedProject).usages) {
    if (resolveAuthoringSymbol(symbols, usage.target.collection, usage.target.id)) continue;
    context.diagnostics.push(
      makeDiagnostic(
        'AUTHORING_LINK_MISSING_TARGET',
        'error',
        usage.path,
        `Reference target '${usage.target.collection}/${usage.target.id}' does not exist.`,
      ),
    );
  }
  context.symbols = symbols;
  addStage(context, 'link', hasErrors(context.diagnostics) ? 'failed' : 'completed');
}

/** Lowers every specialized family into the complete, unpublished wire draft. */
function lowerAuthoringProject(
  project: AuthoringProject,
  _symbols: AuthoringSymbolTables,
): LoweringResult {
  const shared = lowerSharedAuthoringProject(project);
  const diagnostics = shared.diagnostics.map((diagnostic) =>
    makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
  );
  if (shared.draft) {
    const programs = lowerSceneAndRoomPrograms(project, shared.draft);
    diagnostics.push(
      ...programs.diagnostics.map((diagnostic) =>
        makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
      ),
    );
    if (programs.draft) {
      const remainingPrograms = lowerDialogueAndInteractionPrograms(project, programs.draft);
      diagnostics.push(
        ...remainingPrograms.diagnostics.map((diagnostic) =>
          makeDiagnostic(diagnostic.code, 'error', diagnostic.path, diagnostic.message),
        ),
      );
      if (remainingPrograms.draft) return { diagnostics, project: remainingPrograms.draft };
    }
  }
  return { diagnostics };
}

function finish(context: CompilerContext): CompileFailure {
  return {
    ok: false,
    diagnostics: sortAndDedupeDiagnostics(context.diagnostics),
    stages: context.stages,
  };
}

/**
 * The one public authoring-to-gameplay compiler boundary. It is pure: input is
 * parsed into a normalized copy and no project/editor state is mutated.
 */
export function compileAuthoringProject(project: unknown): CompileResult<CompiledProjectWireV1> {
  const context: CompilerContext = { diagnostics: [], stages: [] };
  normalizeAuthoringProject(project, context);
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

  validateSemantics(context);
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

  linkAuthoringProject(context);
  if (!context.symbols) {
    addSkippedStages(context, [
      'lower',
      'collect-resources',
      'assemble',
      'validate-wire',
      'serialize',
    ]);
    return finish(context);
  }

  const lowered = lowerAuthoringProject(context.normalizedProject, context.symbols);
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
  // Lowerers sort definition/resource tables by stable ID and preserve every
  // semantically ordered authored array. Assembly publishes that complete value.
  addStage(context, 'assemble', 'completed');
  const validated = compiledProjectWireV1Schema.safeParse(lowered.project);
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
  addStage(context, 'serialize', 'completed');
  return {
    ok: true,
    project: validated.data,
    canonicalJson: serializeCompiledProjectWireV1(validated.data),
    diagnostics,
    stages: context.stages,
  };
}
