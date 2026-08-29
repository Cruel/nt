import { describe, expect, it } from 'vite-plus/test';
import {
  analyzeConcreteInteractionResolution,
  analyzeInteractionRules,
  analyzeSubjectOffers,
  ruleRelation,
} from '../../shared/interaction-resolver-analysis';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import {
  defaultInteractionProgram,
  type InteractionRule,
} from '../../shared/project-schema/authoring-interactions';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

const ref = (id: string) => ({
  kind: 'exact' as const,
  subject: {
    kind: 'interactable' as const,
    interactable: { $ref: { registry: 'interactableInstances' as const, id } },
  },
});

function rule(
  id: string,
  selectors: InteractionRule['slots'][number]['selectors'],
  priority = 0,
  guarded = false,
): InteractionRule {
  return {
    id,
    verb: { $ref: { collection: 'verbs' as const, id: 'use' } },
    slots: [{ slotId: 'target', selectors }],
    offer: null,
    guard: guarded
      ? { kind: 'lua-predicate' as const, source: 'return can_use()' }
      : { kind: 'always' as const },
    priority,
    program: defaultInteractionProgram(),
  };
}

function project() {
  const project = createAuthoringProject();
  project.verbs.use = { id: 'use', label: 'Use', data: defaultVerbData('Use') };
  for (const id of ['key', 'coin', 'box'])
    project.interactables[id] = { id, label: id, data: defaultInteractableData(id) };
  return project;
}

describe('Interaction resolver analysis', () => {
  it('mirrors runtime containment tiers for exact, qualified pattern, family, and any-subject', () => {
    const value = project();
    const exact = rule('exact', [ref('key')]);
    const prefix = rule('prefix', [
      { kind: 'qualified-pattern', family: 'interactable', pattern: 'k*' },
    ]);
    const family = rule('family', [{ kind: 'family', family: 'interactable' }]);
    const any = rule('any', [{ kind: 'any-subject' }]);

    expect(ruleRelation(value, exact, prefix).leftContainedByRight).toBe('yes');
    expect(ruleRelation(value, prefix, family).leftContainedByRight).toBe('yes');
    expect(ruleRelation(value, family, any).leftContainedByRight).toBe('yes');
    expect(ruleRelation(value, any, family).leftContainedByRight).toBe('no');
    expect(
      ruleRelation(
        value,
        rule('trait', [
          { kind: 'trait', trait: { $ref: { collection: 'traits', id: 'openable' } } },
        ]),
        family,
      ).leftContainedByRight,
    ).toBe('no');
  });

  it('finds definite equal-tier conflicts even when selector unions are not textually identical', () => {
    const value = project();
    const left = rule('left', [ref('key'), ref('coin')], 10);
    const right = rule('right', [ref('key'), ref('box')], 10);

    const analyses = analyzeInteractionRules(value, [left, right]);
    expect(analyses[0]!.conflicts).toContainEqual(
      expect.objectContaining({ ruleId: 'right', certainty: 'yes' }),
    );
    expect(analyses[1]!.conflicts).toContainEqual(
      expect.objectContaining({ ruleId: 'left', certainty: 'yes' }),
    );
  });

  it('marks Lua and trait-dependent overlap as uncertainty instead of guessing', () => {
    const value = project();
    value.traits.openable = {
      id: 'openable',
      label: 'Openable',
      description: '',
      ownerKinds: ['interactable'],
      properties: [],
    };
    const traitRule = rule('trait', [
      { kind: 'trait', trait: { $ref: { collection: 'traits', id: 'openable' } } },
    ]);
    const guardedFamily = rule(
      'guarded-family',
      [{ kind: 'family', family: 'interactable' }],
      0,
      true,
    );

    const analyses = analyzeInteractionRules(value, [traitRule, guardedFamily]);
    expect(analyses[0]!.uncertainty).toBe(true);
    expect(analyses[1]!.uncertainty).toBe(true);
    expect(analyses[0]!.overlaps).toContainEqual(
      expect.objectContaining({ ruleId: 'guarded-family', certainty: 'unknown' }),
    );
  });

  it('uses runtime Offer specificity before authored rank and does not fall through a suppressed winner', () => {
    const value = project();
    value.verbs.use.data = {
      ...defaultVerbData('Use'),
      slots: [
        {
          id: 'target',
          label: { source: { kind: 'inline', text: 'target' }, markup: 'plain' },
          prompt: { source: { kind: 'inline', text: 'target' }, markup: 'plain' },
          selectors: [{ kind: 'any-subject' }],
        },
      ],
      bindingOrder: ['target'],
      offers: [
        {
          id: 'family',
          slotId: 'target',
          selectors: [{ kind: 'family', family: 'interactable' }],
          rank: -100,
          primary: false,
        },
        {
          id: 'exact',
          slotId: 'target',
          selectors: [ref('key')],
          condition: {
            kind: 'variable-comparison',
            variable: { $ref: { collection: 'variables', id: 'flag' } },
            operator: 'truthy',
          },
          rank: 50,
          primary: true,
        },
      ],
    };

    const analysis = analyzeSubjectOffers(value, { kind: 'interactable', identity: 'key' }, [
      { id: 'flag', value: false },
    ]).find((entry) => entry.verbId === 'use')!;

    expect(analysis.winner?.sourceId).toBe('verb:exact');
    expect(analysis.winnerStatus).toBe('no');
    expect(analysis.primaryStatus).toBe('none');
    expect(analysis.candidates.find((item) => item.sourceId === 'verb:family')?.shadowedBy).toBe(
      'verb:exact',
    );
  });

  it('explains Guard fallthrough across structural tiers for one concrete command', () => {
    const value = project();
    const exact = rule('exact', [ref('key')], 0, true);
    const family = rule('family', [{ kind: 'family', family: 'interactable' }], 100);
    exact.guard = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'enabled' } },
      operator: 'truthy',
    };
    value.interactions.rules = {
      id: 'rules',
      label: 'Rules',
      data: { kind: 'interaction', rules: [exact, family] },
    };

    const analysis = analyzeConcreteInteractionResolution(
      value,
      'use',
      [{ slotId: 'target', subject: { kind: 'interactable', identity: 'key' } }],
      [{ id: 'enabled', value: false }],
    );

    expect(analysis.winner).toBe('rules:family');
    expect(analysis.candidates).toContainEqual(
      expect.objectContaining({ ruleId: 'exact', tier: 0, guard: 'no', status: 'guard-failed' }),
    );
    expect(analysis.candidates).toContainEqual(
      expect.objectContaining({ ruleId: 'family', tier: 1, status: 'winner' }),
    );
  });

  it('reports equal-priority concrete ambiguity and Lua uncertainty without guessing', () => {
    const value = project();
    const left = rule('left', [{ kind: 'family', family: 'interactable' }], 10);
    const right = rule('right', [{ kind: 'family', family: 'interactable' }], 10);
    value.interactions.rules = {
      id: 'rules',
      label: 'Rules',
      data: { kind: 'interaction', rules: [left, right] },
    };
    const binding = [
      { slotId: 'target', subject: { kind: 'interactable' as const, identity: 'key' } },
    ];
    expect(analyzeConcreteInteractionResolution(value, 'use', binding).ambiguity).toEqual([
      'rules:left',
      'rules:right',
    ]);

    right.guard = { kind: 'lua-predicate', source: 'return maybe()' };
    const uncertain = analyzeConcreteInteractionResolution(value, 'use', binding);
    expect(uncertain.uncertainty).toBe(true);
    expect(uncertain.fallback).toBe('conditional');
    expect(uncertain.winner).toBeNull();
  });

  it('identifies equivalent lower-priority rules as definitely unreachable', () => {
    const value = project();
    const winner = rule('winner', [{ kind: 'family', family: 'interactable' }], 10);
    const shadowed = rule('shadowed', [{ kind: 'family', family: 'interactable' }], 0);

    const analyses = analyzeInteractionRules(value, [winner, shadowed]);
    expect(analyses.find((item) => item.rule.id === 'shadowed')?.unreachable).toBe('yes');
  });
});
