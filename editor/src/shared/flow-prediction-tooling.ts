import type { FlowPredictionIndex } from './project-schema/compiled-project';

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

function edgesFor(slice: Slice): FlowPredictionToolingEdge[] {
  const edges: FlowPredictionToolingEdge[] = [];
  const alternative = slice.condition !== undefined;

  if (slice.control.kind === 'sequential') {
    if (slice.control.successor !== null) {
      edges.push({
        kind: alternative ? 'alternative' : 'deterministic',
        target: slice.control.successor,
        reason: alternative ? 'condition-true' : 'successor',
      });
    }
  } else if (slice.control.kind === 'branch') {
    edges.push(
      ...slice.control.branches.map((branch) => ({
        kind: 'alternative' as const,
        target: branch.target,
        reason: 'branch' as const,
      })),
      { kind: 'alternative', target: slice.control.fallback, reason: 'branch' },
    );
  } else {
    edges.push(
      ...slice.control.options.map((option) => ({
        kind: 'alternative' as const,
        target: option.target,
        reason: 'choice' as const,
      })),
    );
  }

  if (slice.conditionFalseSuccessor !== null) {
    edges.push({
      kind: 'alternative',
      target: slice.conditionFalseSuccessor,
      reason: 'condition-false',
    });
  }
  return edges;
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
      derived: true as const,
    })),
    slices: index.slices.map((slice, sliceIndex) => ({
      index: sliceIndex,
      point: slice.point,
      provenance: [slice.point],
      frontier: slice.frontier,
      opaque: programIsOpaque(slice.program),
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
