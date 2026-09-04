import type { FlowPredictionIndex } from './project-schema/compiled-project';
import { staticPredictionTruth } from './flow-prediction-static';

type Slice = FlowPredictionIndex['slices'][number];
type Dependency = FlowPredictionIndex['dependencyGroups'][number][number];
export type FlowPredictionToolingPoint = Slice['point'];

export type FlowPredictionToolingEdgeKind = 'deterministic' | 'alternative';

export interface FlowPredictionToolingEdge {
  kind: FlowPredictionToolingEdgeKind;
  target: number;
  reason: 'successor' | 'condition-true' | 'condition-false' | 'branch' | 'choice';
}

export interface FlowPredictionToolingSlice {
  index: number;
  point: FlowPredictionToolingPoint;
  provenance: FlowPredictionToolingPoint[];
  frontier: Slice['frontier'];
  opaque: boolean;
  derived: true;
  edges: FlowPredictionToolingEdge[];
  dependencyGroups: Array<{ index: number; dependencies: Dependency[] }>;
  dependencies: Dependency[];
}

export interface FlowPredictionToolingSupplementalHint {
  id: string;
  target: NonNullable<FlowPredictionIndex['supplementalHints']>[number]['target'];
  attachment:
    | { kind: 'point'; slice: number; point: FlowPredictionToolingPoint | null }
    | { kind: 'room'; roomId: string; scope: 'entry-path' | 'resident' };
  potentialExpansion: {
    slices: number[];
    dependencies: Dependency[];
  };
  derived: true;
}

export interface FlowPredictionToolingProjection {
  derived: true;
  readOnly: true;
  slices: FlowPredictionToolingSlice[];
  supplementalHints: FlowPredictionToolingSupplementalHint[];
}

function programIsOpaque(program: Slice['program']): boolean {
  return program.some((command) => {
    if (command.kind === 'opaque') return true;
    if (command.kind !== 'if') return false;
    return programIsOpaque(command.thenCommands) || programIsOpaque(command.elseCommands);
  });
}

function conditionMayReachOpacity(condition: Slice['condition']): boolean {
  if (!condition) return false;
  if (condition.kind === 'lua-predicate') return true;
  if (condition.kind === 'not') return conditionMayReachOpacity(condition.condition);
  if (condition.kind === 'all') {
    for (const child of condition.conditions) {
      if (conditionMayReachOpacity(child)) return true;
      if (staticPredictionTruth(child) === 'false') return false;
    }
  }
  if (condition.kind === 'any') {
    for (const child of condition.conditions) {
      if (conditionMayReachOpacity(child)) return true;
      if (staticPredictionTruth(child) === 'true') return false;
    }
  }
  return false;
}

function controlIsOpaque(control: Slice['control']): boolean {
  if (control.kind === 'branch') {
    for (const branch of control.branches) {
      if (conditionMayReachOpacity(branch.condition)) return true;
      if (staticPredictionTruth(branch.condition) === 'true') return false;
    }
  }
  if (control.kind === 'choice')
    return control.options.some((option) => conditionMayReachOpacity(option.condition));
  return false;
}

function edgesFor(slice: Slice): FlowPredictionToolingEdge[] {
  const edges: FlowPredictionToolingEdge[] = [];
  const conditionTruth = slice.condition ? staticPredictionTruth(slice.condition) : 'true';
  const alternative = conditionTruth === 'unknown';

  if (slice.control.kind === 'sequential') {
    if (slice.control.successor !== null && conditionTruth !== 'false') {
      edges.push({
        kind: alternative ? 'alternative' : 'deterministic',
        target: slice.control.successor,
        reason: alternative ? 'condition-true' : 'successor',
      });
    }
  } else if (slice.control.kind === 'branch') {
    let fallthrough = true;
    for (const branch of slice.control.branches) {
      const truth = staticPredictionTruth(branch.condition);
      if (truth === 'false') continue;
      edges.push({
        kind:
          !alternative && truth === 'true' && edges.length === 0 ? 'deterministic' : 'alternative',
        target: branch.target,
        reason: 'branch',
      });
      if (truth === 'true') {
        fallthrough = false;
        break;
      }
    }
    if (fallthrough)
      edges.push({
        kind: !alternative && edges.length === 0 ? 'deterministic' : 'alternative',
        target: slice.control.fallback,
        reason: 'branch',
      });
  } else {
    edges.push(
      ...slice.control.options
        .filter(
          (option) => !option.condition || staticPredictionTruth(option.condition) !== 'false',
        )
        .map((option) => ({
          kind: 'alternative' as const,
          target: option.target,
          reason: 'choice' as const,
        })),
    );
  }

  if (slice.conditionFalseSuccessor !== null && conditionTruth !== 'true') {
    edges.push({
      kind: conditionTruth === 'false' ? 'deterministic' : 'alternative',
      target: slice.conditionFalseSuccessor,
      reason: 'condition-false',
    });
  }
  return edges;
}

function potentialExpansionForHint(
  index: FlowPredictionIndex,
  hint: NonNullable<FlowPredictionIndex['supplementalHints']>[number],
  activeHintIds: Set<string> = new Set(),
): { slices: number[]; dependencies: Dependency[] } {
  if (activeHintIds.has(hint.id)) return { slices: [], dependencies: [] };
  const nextActiveHintIds = new Set(activeHintIds);
  nextActiveHintIds.add(hint.id);
  const { target } = hint;
  if (target.kind === 'asset') {
    return { slices: [], dependencies: [{ kind: 'asset', asset: target.asset }] };
  }
  if (target.kind === 'layout') {
    return { slices: [], dependencies: [{ kind: 'layout', layout: target.layout }] };
  }

  const dependencies: Dependency[] = [];
  const dependencyKeys = new Set<string>();
  const slices = [...(hint.potentialExpansionSlices ?? [])];
  const sliceSet = new Set(slices);
  const addDependency = (dependency: Dependency) => {
    const key = JSON.stringify(dependency);
    if (dependencyKeys.has(key)) return;
    dependencyKeys.add(key);
    dependencies.push(dependency);
  };
  for (const sliceIndex of slices) {
    const slice = index.slices[sliceIndex];
    if (!slice) continue;
    for (const groupIndex of slice.dependencyGroups) {
      for (const dependency of index.dependencyGroups[groupIndex] ?? []) {
        addDependency(dependency);
      }
    }
  }

  for (const nested of index.supplementalHints ?? []) {
    if (nextActiveHintIds.has(nested.id)) continue;
    let active = false;
    if (nested.attachment.kind === 'point') {
      active = sliceSet.has(nested.attachment.slice);
    } else if (nested.attachment.scope === 'entry-path') {
      const roomId = nested.attachment.room.id;
      active = slices.some((sliceIndex) => {
        const point = index.slices[sliceIndex]?.point;
        return (
          point?.kind === 'room-lifecycle' &&
          point.room.id === roomId &&
          (point.stage === 'before-enter' ||
            point.stage === 'presentation' ||
            point.stage === 'after-enter')
        );
      });
    }
    if (!active) continue;
    const nestedExpansion = potentialExpansionForHint(index, nested, nextActiveHintIds);
    for (const nestedSlice of nestedExpansion.slices) {
      if (sliceSet.has(nestedSlice)) continue;
      sliceSet.add(nestedSlice);
      slices.push(nestedSlice);
    }
    for (const dependency of nestedExpansion.dependencies) addDependency(dependency);
  }
  return { slices, dependencies };
}

export function projectFlowPredictionIndexForTooling(
  index: FlowPredictionIndex | null | undefined,
): FlowPredictionToolingProjection | null {
  if (!index) return null;
  return {
    derived: true,
    readOnly: true,
    supplementalHints: (index.supplementalHints ?? []).map((hint) => ({
      id: hint.id,
      target: hint.target,
      attachment:
        hint.attachment.kind === 'point'
          ? {
              kind: 'point' as const,
              slice: hint.attachment.slice,
              point: index.slices[hint.attachment.slice]?.point ?? null,
            }
          : {
              kind: 'room' as const,
              roomId: hint.attachment.room.id,
              scope: hint.attachment.scope,
            },
      potentialExpansion: potentialExpansionForHint(index, hint),
      derived: true as const,
    })),
    slices: index.slices.map((slice, sliceIndex) => ({
      index: sliceIndex,
      point: slice.point,
      provenance: [slice.point],
      frontier: slice.frontier,
      opaque:
        programIsOpaque(slice.program) ||
        conditionMayReachOpacity(slice.condition) ||
        controlIsOpaque(slice.control),
      derived: true,
      edges: edgesFor(slice),
      dependencyGroups: slice.dependencyGroups.map((groupIndex) => ({
        index: groupIndex,
        dependencies: index.dependencyGroups[groupIndex] ?? [],
      })),
      dependencies: slice.dependencyGroups.flatMap(
        (groupIndex) => index.dependencyGroups[groupIndex] ?? [],
      ),
    })),
  };
}
