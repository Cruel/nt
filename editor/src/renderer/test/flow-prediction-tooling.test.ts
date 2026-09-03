import { describe, expect, it } from 'vite-plus/test';
import type { FlowPredictionIndex } from '../../shared/project-schema/compiled-project';
import { projectFlowPredictionIndexForTooling } from '../../shared/flow-prediction-tooling';

describe('Flow prediction tooling projection', () => {
  it('exposes derived dependencies, alternatives, and opacity without evaluating Conditions', () => {
    const index: FlowPredictionIndex = {
      dependencyGroups: [[{ kind: 'asset', asset: { kind: 'asset', id: 'intro' } }]],
      slices: [
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'opening' } },
          dependencyGroups: [0],
          condition: { kind: 'always' },
          conditionFalseSuccessor: 2,
          control: { kind: 'sequential', successor: 1 },
          frontier: 'normal',
          program: [{ kind: 'opaque' }],
        },
        {
          point: { kind: 'scene-terminal', scene: { kind: 'scene', id: 'opening' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: null },
          frontier: 'decision',
          program: [],
        },
        {
          point: { kind: 'scene-terminal', scene: { kind: 'scene', id: 'fallback' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: null },
          frontier: 'normal',
          program: [],
        },
      ],
    };

    const projection = projectFlowPredictionIndexForTooling(index)!;
    expect(projection).toMatchObject({ derived: true, readOnly: true });
    expect(projection.slices[0]).toMatchObject({ opaque: true, derived: true });
    expect(projection.slices[0].provenance).toEqual([index.slices[0].point]);
    expect(projection.slices[0].dependencyGroups).toEqual([
      { index: 0, dependencies: index.dependencyGroups[0] },
    ]);
    expect(projection.slices[0].dependencies).toEqual(index.dependencyGroups[0]);
    expect(projection.slices[0].edges).toEqual([
      { kind: 'alternative', target: 1, reason: 'condition-true' },
      { kind: 'alternative', target: 2, reason: 'condition-false' },
    ]);
  });
});
