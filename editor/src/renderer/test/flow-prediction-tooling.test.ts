import { describe, expect, it } from 'vite-plus/test';
import type { FlowPredictionIndex } from '../../shared/project-schema/compiled-project';
import { projectFlowPredictionIndexForTooling } from '../../shared/flow-prediction-tooling';

describe('Flow prediction tooling projection', () => {
  it('exposes derived dependencies, deterministic constants, and opacity without evaluating live Conditions', () => {
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
      { kind: 'deterministic', target: 1, reason: 'successor' },
    ]);
  });

  it('shows the effective potential expansion of semantic supplemental hints', () => {
    const index: FlowPredictionIndex = {
      dependencyGroups: [
        [{ kind: 'asset', asset: { kind: 'asset', id: 'near' } }],
        [{ kind: 'layout', layout: { kind: 'layout', id: 'later-ui' } }],
      ],
      slices: [
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'hinted' } },
          dependencyGroups: [0],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: 1 },
          frontier: 'normal',
          program: [],
        },
        {
          point: { kind: 'scene-step', scene: { kind: 'scene', id: 'hinted' }, stepId: 'later' },
          dependencyGroups: [1],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: null },
          frontier: 'strong-wait',
          program: [],
        },
      ],
      supplementalHints: [
        {
          id: 'hint-scene',
          target: { kind: 'scene', scene: { kind: 'scene', id: 'hinted' } },
          potentialExpansionSlices: [0, 1],
          attachment: { kind: 'point', slice: 0 },
        },
      ],
    };

    const projection = projectFlowPredictionIndexForTooling(index)!;
    expect(projection.supplementalHints[0]?.potentialExpansion).toEqual({
      slices: [0, 1],
      dependencies: [index.dependencyGroups[0]![0], index.dependencyGroups[1]![0]],
    });
  });

  it('does not show statically impossible ordered branches or disabled choice options', () => {
    const terminal = (id: string): FlowPredictionIndex['slices'][number] => ({
      point: { kind: 'scene-terminal', scene: { kind: 'scene', id } },
      dependencyGroups: [],
      conditionFalseSuccessor: null,
      control: { kind: 'sequential', successor: null },
      frontier: 'normal',
      program: [],
    });
    const index: FlowPredictionIndex = {
      dependencyGroups: [],
      slices: [
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'branch' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: {
            kind: 'branch',
            branches: [
              { condition: { kind: 'always' }, target: 1 },
              {
                condition: { kind: 'lua-predicate', source: 'unreachable()' },
                target: 2,
              },
            ],
            fallback: 3,
          },
          frontier: 'normal',
          program: [],
        },
        terminal('selected'),
        terminal('unreachable'),
        terminal('fallback'),
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'choice' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: {
            kind: 'choice',
            options: [
              {
                optionId: 'disabled',
                condition: { kind: 'not', condition: { kind: 'always' } },
                programs: [],
                target: 2,
              },
              { optionId: 'possible', programs: [], target: 3 },
            ],
          },
          frontier: 'decision',
          program: [],
        },
      ],
    };

    const projection = projectFlowPredictionIndexForTooling(index)!;
    expect(projection.slices[0]!.edges).toEqual([
      { kind: 'deterministic', target: 1, reason: 'branch' },
    ]);
    expect(projection.slices[0]!.opaque).toBe(false);
    expect(projection.slices[4]!.edges).toEqual([
      { kind: 'alternative', target: 3, reason: 'choice' },
    ]);
  });

  it('keeps inner deterministic branches alternative when the containing slice condition is unknown', () => {
    const index: FlowPredictionIndex = {
      dependencyGroups: [],
      slices: [
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'guarded' } },
          dependencyGroups: [],
          condition: { kind: 'lua-predicate', source: 'may_run_slice()' },
          conditionFalseSuccessor: 2,
          control: {
            kind: 'branch',
            branches: [{ condition: { kind: 'always' }, target: 1 }],
            fallback: 2,
          },
          frontier: 'normal',
          program: [],
        },
        {
          point: { kind: 'scene-terminal', scene: { kind: 'scene', id: 'selected' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: null },
          frontier: 'normal',
          program: [],
        },
        {
          point: { kind: 'scene-terminal', scene: { kind: 'scene', id: 'skipped' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: { kind: 'sequential', successor: null },
          frontier: 'normal',
          program: [],
        },
      ],
    };

    const projection = projectFlowPredictionIndexForTooling(index)!;
    expect(projection.slices[0]!.edges).toEqual([
      { kind: 'alternative', target: 1, reason: 'branch' },
      { kind: 'alternative', target: 2, reason: 'condition-false' },
    ]);
    expect(projection.slices[0]!.opaque).toBe(true);
  });

  it('marks Lua predicates nested in branch and choice Conditions as opaque', () => {
    const index: FlowPredictionIndex = {
      dependencyGroups: [],
      slices: [
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'branch' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: {
            kind: 'branch',
            branches: [
              {
                condition: {
                  kind: 'all',
                  conditions: [
                    { kind: 'always' },
                    { kind: 'not', condition: { kind: 'lua-predicate', source: 'dynamic()' } },
                  ],
                },
                target: 1,
              },
            ],
            fallback: 1,
          },
          frontier: 'normal',
          program: [],
        },
        {
          point: { kind: 'scene-entry', scene: { kind: 'scene', id: 'choice' } },
          dependencyGroups: [],
          conditionFalseSuccessor: null,
          control: {
            kind: 'choice',
            options: [
              {
                optionId: 'dynamic',
                condition: { kind: 'lua-predicate', source: 'enabled()' },
                programs: [],
                target: 0,
              },
            ],
          },
          frontier: 'decision',
          program: [],
        },
      ],
    };

    const projection = projectFlowPredictionIndexForTooling(index)!;
    expect(projection.slices[0]!.opaque).toBe(true);
    expect(projection.slices[1]!.opaque).toBe(true);
  });
});
