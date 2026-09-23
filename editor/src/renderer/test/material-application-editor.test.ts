import { describe, expect, it } from 'vite-plus/test';
import { materialApplicationParameterOverrideCompatible } from '@/components/materials/MaterialApplicationEditor';
import type { EffectiveInteractableProperty } from '../../shared/project-schema/authoring-interactable-properties';

function property(
  id: string,
  type: 'boolean' | 'integer' | 'number',
): EffectiveInteractableProperty {
  return {
    id,
    contract: { id, type, nullable: false },
    source: 'definition',
    traitIds: [],
  };
}

describe('MaterialApplicationEditor parameter compatibility', () => {
  const properties = [
    property('heat', 'number'),
    property('count', 'integer'),
    property('lit', 'boolean'),
  ];

  it('accepts compatible Property bindings and keeps incompatible ones dormant', () => {
    expect(
      materialApplicationParameterOverrideCompatible(
        'float',
        { type: 'float', source: { kind: 'property', property: 'heat' } },
        properties,
      ),
    ).toBe(true);
    expect(
      materialApplicationParameterOverrideCompatible(
        'vec2',
        { type: 'vec2', source: { kind: 'property', property: 'heat' } },
        properties,
      ),
    ).toBe(false);
    expect(
      materialApplicationParameterOverrideCompatible(
        'bool',
        { type: 'bool', source: { kind: 'property', property: 'missing' } },
        properties,
      ),
    ).toBe(false);
  });

  it('permits standard facets only for float inputs', () => {
    expect(
      materialApplicationParameterOverrideCompatible(
        'float',
        { type: 'float', source: { kind: 'standard-facet', facet: 'paint-width' } },
        properties,
      ),
    ).toBe(true);
    expect(
      materialApplicationParameterOverrideCompatible(
        'vec4',
        { type: 'vec4', source: { kind: 'standard-facet', facet: 'paint-width' } },
        properties,
      ),
    ).toBe(false);
  });
});
