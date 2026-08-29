import type { AuthoringCollectionKey } from './authoring-collections';

export const AUTHORING_LUA_EXECUTION_SURFACES = Object.freeze([
  'script-record',
  'layout-rml',
  'layout-dedicated-lua',
  'shared-lua-predicate',
  'shared-lua-expression',
  'shared-run-lua-effect',
  'scene-run-lua-step',
  'dialogue-run-lua-segment',
  'test-init-script',
  'test-check-script',
] as const);

export type AuthoringLuaExecutionSurface = (typeof AUTHORING_LUA_EXECUTION_SURFACES)[number];

export type RegisteredAuthoringLuaSource = {
  surface: AuthoringLuaExecutionSurface;
  sourcePath: readonly string[];
  sourceText?: string;
  scriptRecordId?: string;
  explicitDependenciesPath?: readonly string[];
  explicitDependencies?: readonly unknown[];
  fallbackOwnerPath?: readonly string[];
  supportsExplicitFallback: boolean;
  focusedAdmission: boolean;
  focusedFacet?: 'preview-visual' | 'preview-ui';
};

type JsonObject = Record<string, unknown>;
type SourcePathPatternSegment = string | { kind: 'array-index' };

const ARRAY_INDEX: SourcePathPatternSegment = Object.freeze({ kind: 'array-index' });

const LUA_EXPLICIT_FALLBACK_OWNER_PATTERNS = Object.freeze([
  Object.freeze({ collection: 'layouts', relativePath: Object.freeze(['script']) }),
  Object.freeze({
    collection: 'rooms',
    relativePath: Object.freeze(['description', 'source']),
  }),
  Object.freeze({
    collection: 'rooms',
    relativePath: Object.freeze(['placements', ARRAY_INDEX, 'presentation', 'label', 'source']),
  }),
  ...(['overlays', 'cast', 'props', 'environments', 'exits'] as const).map((family) =>
    Object.freeze({
      collection: 'rooms' as const,
      relativePath: Object.freeze([family, ARRAY_INDEX, 'condition']),
    }),
  ),
]);

function isArrayIndexSegment(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === value;
}

function pathMatchesPattern(
  path: readonly string[],
  pattern: readonly SourcePathPatternSegment[],
): boolean {
  return (
    path.length === pattern.length &&
    pattern.every((segment, index) =>
      typeof segment === 'string' ? path[index] === segment : isArrayIndexSegment(path[index]),
    )
  );
}

function supportsExplicitFallbackPath(
  collection: 'rooms' | 'layouts',
  relativePath: readonly string[],
): boolean {
  return LUA_EXPLICIT_FALLBACK_OWNER_PATTERNS.some(
    (pattern) =>
      pattern.collection === collection && pathMatchesPattern(relativePath, pattern.relativePath),
  );
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const sourceText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function explicitTargets(value: unknown): readonly unknown[] | undefined {
  if (!isObject(value) || !isObject(value.additionalDependencies)) return undefined;
  return Array.isArray(value.additionalDependencies.targets)
    ? value.additionalDependencies.targets
    : undefined;
}

function addCondition(
  output: RegisteredAuthoringLuaSource[],
  value: unknown,
  path: readonly string[],
  options: {
    supportsExplicitFallback: boolean;
    focusedAdmission?: boolean;
    focusedFacet?: 'preview-visual' | 'preview-ui';
  },
) {
  if (!isObject(value) || value.kind !== 'lua-predicate') return;
  const source = sourceText(value.source);
  if (source === undefined) return;
  output.push({
    surface: 'shared-lua-predicate',
    sourcePath: [...path, 'source'],
    sourceText: source,
    explicitDependenciesPath: [...path, 'additionalDependencies'],
    explicitDependencies: explicitTargets(value),
    fallbackOwnerPath: path,
    supportsExplicitFallback: options.supportsExplicitFallback,
    focusedAdmission: options.focusedAdmission ?? false,
    focusedFacet: options.focusedFacet,
  });
}

function addTextContent(
  output: RegisteredAuthoringLuaSource[],
  value: unknown,
  path: readonly string[],
  options: {
    supportsExplicitFallback: boolean;
    focusedAdmission?: boolean;
    focusedFacet?: 'preview-visual' | 'preview-ui';
  },
) {
  if (!isObject(value) || !isObject(value.source) || value.source.kind !== 'lua-expression') return;
  const source = sourceText(value.source.source);
  if (source === undefined) return;
  const ownerPath = [...path, 'source'];
  output.push({
    surface: 'shared-lua-expression',
    sourcePath: [...ownerPath, 'source'],
    sourceText: source,
    explicitDependenciesPath: [...ownerPath, 'additionalDependencies'],
    explicitDependencies: explicitTargets(value.source),
    fallbackOwnerPath: ownerPath,
    supportsExplicitFallback: options.supportsExplicitFallback,
    focusedAdmission: options.focusedAdmission ?? false,
    focusedFacet: options.focusedFacet,
  });
}

function addEffect(
  output: RegisteredAuthoringLuaSource[],
  value: unknown,
  path: readonly string[],
) {
  if (!isObject(value) || value.kind !== 'run-lua-effect') return;
  const source = sourceText(value.source);
  if (source === undefined) return;
  output.push({
    surface: 'shared-run-lua-effect',
    sourcePath: [...path, 'source'],
    sourceText: source,
    supportsExplicitFallback: false,
    focusedAdmission: false,
  });
}

function addGameplayCommand(
  output: RegisteredAuthoringLuaSource[],
  value: unknown,
  path: readonly string[],
) {
  if (!isObject(value)) return;
  if (value.kind === 'run-lua') {
    const source = sourceText(value.source);
    if (source !== undefined)
      output.push({
        surface: 'shared-run-lua-effect',
        sourcePath: [...path, 'source'],
        sourceText: source,
        supportsExplicitFallback: false,
        focusedAdmission: false,
      });
    return;
  }
  if (value.kind === 'notify')
    addTextContent(output, value.message, [...path, 'message'], {
      supportsExplicitFallback: false,
    });
  if (value.kind !== 'if') return;
  addCondition(output, value.condition, [...path, 'condition'], {
    supportsExplicitFallback: false,
  });
  asArray(value.then).forEach((command, index) =>
    addGameplayCommand(output, command, [...path, 'then', String(index)]),
  );
  asArray(value.else).forEach((command, index) =>
    addGameplayCommand(output, command, [...path, 'else', String(index)]),
  );
}

function addInteractionProgram(
  output: RegisteredAuthoringLuaSource[],
  value: unknown,
  path: readonly string[],
) {
  if (!isObject(value)) return;
  asArray(value.instructions).forEach((instruction, index) => {
    if (!isObject(instruction)) return;
    const instructionPath = [...path, 'instructions', String(index)];
    addGameplayCommand(output, instruction, instructionPath);
  });
}

function collectRoomSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  const focusedRoomOptions = (fallbackOwnerPath: readonly string[]) => ({
    supportsExplicitFallback: supportsExplicitFallbackPath('rooms', fallbackOwnerPath),
    focusedAdmission: true,
    focusedFacet: 'preview-visual' as const,
  });
  addTextContent(output, data.description, ['description'], {
    ...focusedRoomOptions(['description', 'source']),
  });
  for (const family of ['overlays', 'cast', 'props', 'environments', 'exits'] as const)
    asArray(data[family]).forEach((item, index) => {
      const conditionPath = [family, String(index), 'condition'];
      if (isObject(item))
        addCondition(output, item.condition, conditionPath, {
          ...focusedRoomOptions(conditionPath),
        });
    });
  asArray(data.placements).forEach((placement, index) => {
    if (!isObject(placement) || !isObject(placement.presentation)) return;
    const labelPath = ['placements', String(index), 'presentation', 'label'];
    addTextContent(output, placement.presentation.label, labelPath, {
      ...focusedRoomOptions([...labelPath, 'source']),
    });
  });
  if (isObject(data.lifecycle)) {
    addCondition(output, data.lifecycle.canEnter, ['lifecycle', 'canEnter'], {
      supportsExplicitFallback: false,
    });
    addCondition(output, data.lifecycle.canLeave, ['lifecycle', 'canLeave'], {
      supportsExplicitFallback: false,
    });
  }
  return output;
}

function collectSceneSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  asArray(data.events).forEach((step, index) => {
    if (!isObject(step)) return;
    const base = ['events', String(index)];
    addCondition(output, step.condition, [...base, 'condition'], {
      supportsExplicitFallback: false,
    });
    if (step.type === 'run-lua') {
      const source = sourceText(step.source);
      if (source !== undefined)
        output.push({
          surface: 'scene-run-lua-step',
          sourcePath: [...base, 'source'],
          sourceText: source,
          supportsExplicitFallback: false,
          focusedAdmission: false,
        });
    }
    if (step.type === 'show-text')
      addTextContent(output, step.text, [...base, 'text'], { supportsExplicitFallback: false });
    if (step.type === 'conditional-branch')
      asArray(step.branches).forEach((branch, branchIndex) => {
        if (isObject(branch))
          addCondition(
            output,
            branch.condition,
            [...base, 'branches', String(branchIndex), 'condition'],
            { supportsExplicitFallback: false },
          );
      });
    if (step.type === 'choice') {
      addTextContent(output, step.prompt, [...base, 'prompt'], {
        supportsExplicitFallback: false,
      });
      asArray(step.options).forEach((option, optionIndex) => {
        if (!isObject(option)) return;
        const optionPath = [...base, 'options', String(optionIndex)];
        addTextContent(output, option.label, [...optionPath, 'label'], {
          supportsExplicitFallback: false,
        });
        addCondition(output, option.condition, [...optionPath, 'condition'], {
          supportsExplicitFallback: false,
        });
        asArray(option.effects).forEach((effect, effectIndex) =>
          addEffect(output, effect, [...optionPath, 'effects', String(effectIndex)]),
        );
      });
    }
  });
  return output;
}

function collectDialogueSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  asArray(data.blocks).forEach((block, blockIndex) => {
    if (!isObject(block) || block.type !== 'sequence') return;
    asArray(block.segments).forEach((segment, segmentIndex) => {
      if (!isObject(segment)) return;
      const base = ['blocks', String(blockIndex), 'segments', String(segmentIndex)];
      addCondition(output, segment.condition, [...base, 'condition'], {
        supportsExplicitFallback: false,
      });
      if (segment.type === 'line') {
        addTextContent(output, segment.text, [...base, 'text'], {
          supportsExplicitFallback: false,
        });
        asArray(segment.effects).forEach((effect, effectIndex) =>
          addGameplayCommand(output, effect, [...base, 'effects', String(effectIndex)]),
        );
      }
      if (segment.type === 'run-lua') {
        const source = sourceText(segment.source);
        if (source !== undefined)
          output.push({
            surface: 'dialogue-run-lua-segment',
            sourcePath: [...base, 'source'],
            sourceText: source,
            supportsExplicitFallback: false,
            focusedAdmission: false,
          });
      }
    });
  });
  asArray(data.edges).forEach((edge, edgeIndex) => {
    if (!isObject(edge) || edge.kind !== 'choice') return;
    const base = ['edges', String(edgeIndex)];
    addTextContent(output, edge.label, [...base, 'label'], { supportsExplicitFallback: false });
    addCondition(output, edge.condition, [...base, 'condition'], {
      supportsExplicitFallback: false,
    });
    asArray(edge.effects).forEach((effect, effectIndex) =>
      addGameplayCommand(output, effect, [...base, 'effects', String(effectIndex)]),
    );
  });
  return output;
}

function collectVerbSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  addTextContent(output, data.actionText, ['actionText'], { supportsExplicitFallback: false });
  addCondition(output, data.availability, ['availability'], { supportsExplicitFallback: false });
  addInteractionProgram(output, data.defaultProgram, ['defaultProgram']);
  return output;
}

function collectInteractionSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  asArray(data.rules).forEach((rule, index) => {
    if (!isObject(rule)) return;
    const base = ['rules', String(index)];
    if (isObject(rule.context) && rule.context.kind === 'predicate')
      addCondition(output, rule.context.condition, [...base, 'context', 'condition'], {
        supportsExplicitFallback: false,
      });
    addInteractionProgram(output, rule.program, [...base, 'program']);
  });
  return output;
}

function collectMapSources(data: JsonObject): RegisteredAuthoringLuaSource[] {
  const output: RegisteredAuthoringLuaSource[] = [];
  if (isObject(data.presentation))
    addTextContent(output, data.presentation.title, ['presentation', 'title'], {
      supportsExplicitFallback: false,
    });
  asArray(data.locations).forEach((location, index) => {
    if (!isObject(location)) return;
    const base = ['locations', String(index)];
    addTextContent(output, location.label, [...base, 'label'], {
      supportsExplicitFallback: false,
    });
    addCondition(output, location.visibility, [...base, 'visibility'], {
      supportsExplicitFallback: false,
    });
  });
  asArray(data.connections).forEach((connection, index) => {
    if (!isObject(connection)) return;
    const base = ['connections', String(index)];
    addTextContent(output, connection.label, [...base, 'label'], {
      supportsExplicitFallback: false,
    });
    addCondition(output, connection.visibility, [...base, 'visibility'], {
      supportsExplicitFallback: false,
    });
  });
  return output;
}

export const AUTHORING_LUA_SCHEMA_SOURCE_REGISTRY = Object.freeze({
  rooms: collectRoomSources,
  scenes: collectSceneSources,
  dialogues: collectDialogueSources,
  verbs: collectVerbSources,
  interactions: collectInteractionSources,
  maps: collectMapSources,
} satisfies Partial<
  Record<AuthoringCollectionKey, (data: JsonObject) => RegisteredAuthoringLuaSource[]>
>);

export function collectRegisteredAuthoringLuaSources(
  collection: AuthoringCollectionKey,
  parsedData: unknown,
): readonly RegisteredAuthoringLuaSource[] {
  const collector =
    AUTHORING_LUA_SCHEMA_SOURCE_REGISTRY[
      collection as keyof typeof AUTHORING_LUA_SCHEMA_SOURCE_REGISTRY
    ];
  if (!collector || !isObject(parsedData)) return [];
  return Object.freeze(
    collector(parsedData)
      .map((source) =>
        source.fallbackOwnerPath && (collection === 'rooms' || collection === 'layouts')
          ? {
              ...source,
              supportsExplicitFallback: supportsExplicitFallbackPath(
                collection,
                source.fallbackOwnerPath,
              ),
            }
          : source,
      )
      .sort((left, right) => left.sourcePath.join('/').localeCompare(right.sourcePath.join('/'))),
  );
}

function matchesFallbackOwnerPath(segments: readonly string[]): boolean {
  if (segments.length < 4 || segments[2] !== 'data') return false;
  const collection = segments[0];
  if (collection !== 'rooms' && collection !== 'layouts') return false;
  return supportsExplicitFallbackPath(collection, segments.slice(3));
}

export function isRegisteredLuaExplicitFallbackOwner(segments: readonly string[]): boolean {
  return matchesFallbackOwnerPath(segments);
}
