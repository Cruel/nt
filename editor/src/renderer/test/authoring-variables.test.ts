import { describe, expect, it } from 'vitest';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultVariableData,
  isVariableDefaultValueCompatible,
  parseEnumValuesText,
  parseVariableDefaultText,
  variableRef,
} from '../../shared/project-schema/authoring-variables';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';

describe('authoring variables schema', () => {
  it('provides typed defaults and compatibility checks', () => {
    expect(defaultVariableData('boolean')).toMatchObject({ kind: 'variable', type: 'boolean', defaultValue: false });
    expect(defaultVariableData('integer')).toMatchObject({ kind: 'variable', type: 'integer', defaultValue: 0 });
    expect(defaultVariableData('enum')).toMatchObject({ kind: 'variable', type: 'enum', defaultValue: 'default', enumValues: ['default'] });
    expect(isVariableDefaultValueCompatible('integer', 1)).toBe(true);
    expect(isVariableDefaultValueCompatible('integer', 1.5)).toBe(false);
    expect(isVariableDefaultValueCompatible('enum', 'open', ['open', 'closed'])).toBe(true);
    expect(isVariableDefaultValueCompatible('enum', 'missing', ['open', 'closed'])).toBe(false);
  });

  it('parses editor default text by type', () => {
    expect(parseVariableDefaultText('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseVariableDefaultText('integer', '42')).toEqual({ ok: true, value: 42 });
    expect(parseVariableDefaultText('number', '3.5')).toEqual({ ok: true, value: 3.5 });
    expect(parseVariableDefaultText('string', 'hello')).toEqual({ ok: true, value: 'hello' });
    expect(parseEnumValuesText('idle, active\ncomplete')).toEqual(['idle', 'active', 'complete']);
    expect(parseVariableDefaultText('enum', 'active', ['idle', 'active'])).toEqual({ ok: true, value: 'active' });
    expect(parseVariableDefaultText('enum', 'missing', ['idle', 'active']).ok).toBe(false);
  });

  it('validates variable data in authoring projects', () => {
    const project = createAuthoringProject();
    project.variables.score = {
      id: 'score',
      label: 'Score',
            data: { kind: 'variable', type: 'integer', scope: 'global', defaultValue: 1.5 },
    };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/variables/score/data/defaultValue', category: 'Variables' }),
    ]));
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

    expect(findUsages(buildReferenceIndex(project), { collection: 'variables', id: 'has-key' })).toEqual([
      expect.objectContaining({ kind: 'variable-ref', path: '/scenes/intro/data/condition/$var' }),
    ]);
  });
});
