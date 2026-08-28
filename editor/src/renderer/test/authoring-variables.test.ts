import { describe, expect, it } from 'vite-plus/test';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultVariableData,
  isVariableValueCompatible,
  parseEnumValuesText,
  parseVariableValueText,
  variableRef,
} from '../../shared/project-schema/authoring-variables';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';

describe('authoring variables schema', () => {
  it('provides typed defaults and compatibility checks', () => {
    expect(defaultVariableData('boolean')).toMatchObject({
      kind: 'variable',
      type: 'boolean',
      nullable: false,
      value: false,
    });
    expect(defaultVariableData('integer')).toMatchObject({
      kind: 'variable',
      type: 'integer',
      value: 0,
    });
    expect(defaultVariableData('enum')).toMatchObject({
      kind: 'variable',
      type: 'enum',
      value: 'default',
      enumValues: ['default'],
    });
    expect(isVariableValueCompatible('integer', 1)).toBe(true);
    expect(isVariableValueCompatible('integer', 1.5)).toBe(false);
    expect(isVariableValueCompatible('enum', 'open', ['open', 'closed'])).toBe(true);
    expect(isVariableValueCompatible('enum', 'missing', ['open', 'closed'])).toBe(false);
    expect(isVariableValueCompatible('string', null, undefined, true)).toBe(true);
    expect(isVariableValueCompatible('string', null, undefined, false)).toBe(false);
  });

  it('parses editor value text by type, including nullable values', () => {
    expect(parseVariableValueText('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseVariableValueText('integer', '42')).toEqual({ ok: true, value: 42 });
    expect(parseVariableValueText('number', '3.5')).toEqual({ ok: true, value: 3.5 });
    expect(parseVariableValueText('string', 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(parseVariableValueText('string', 'null', undefined, true)).toEqual({
      ok: true,
      value: null,
    });
    expect(parseEnumValuesText('idle, active\ncomplete')).toEqual(['idle', 'active', 'complete']);
    expect(parseVariableValueText('enum', 'active', ['idle', 'active'])).toEqual({
      ok: true,
      value: 'active',
    });
    expect(parseVariableValueText('enum', 'missing', ['idle', 'active']).ok).toBe(false);
  });

  it('validates variable data in authoring projects', () => {
    const project = createAuthoringProject();
    project.variables.score = {
      id: 'score',
      label: 'Score',
      data: { kind: 'variable', type: 'integer', scope: 'global', nullable: false, value: 1.5 },
    };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/variables/score/data/value',
          category: 'Variables',
        }),
      ]),
    );
  });

  it('indexes concise variable references', () => {
    const project = createAuthoringProject();
    project.variables['has-key'] = {
      id: 'has-key',
      label: 'Has Key',
      data: defaultVariableData('boolean'),
    };
    project.scenes.intro = {
      id: 'intro',
      label: 'Intro',
      data: { condition: variableRef('has-key') } as never,
    };

    expect(
      findUsages(buildReferenceIndex(project), { collection: 'variables', id: 'has-key' }),
    ).toEqual([
      expect.objectContaining({ kind: 'variable-ref', path: '/scenes/intro/data/condition/$var' }),
    ]);
  });
});
