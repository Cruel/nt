import { describe, expect, it } from 'vite-plus/test';
import {
  defaultVariableData,
  isVariableValueCompatible,
  parseEnumValuesText,
  parseVariableValueText,
} from '../../shared/project-schema/authoring-variables';

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
});
