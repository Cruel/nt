import { describe, expect, it } from 'vite-plus/test';
import {
  materialApplicationParameterOverrideCompatible,
  materialApplicationPreviewOverrides,
} from '@/components/materials/MaterialApplicationEditor';
import type { EffectiveInteractableProperty } from '../../shared/project-schema/authoring-interactable-properties';
import { effectiveMaterialApplication } from '../../shared/project-schema/authoring-material-applications';

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

describe('Material Application specialization', () => {
  it('projects literal, Property, standard-facet, and texture occurrence context into previews', () => {
    const application = {
      material: { $ref: { collection: 'materials' as const, id: 'panel' } },
      parameters: {
        u_literal: { type: 'float' as const, source: { kind: 'literal' as const, value: 0.25 } },
        u_heat: { type: 'float' as const, source: { kind: 'property' as const, property: 'heat' } },
        u_time: {
          type: 'float' as const,
          source: { kind: 'standard-facet' as const, facet: 'occurrence-time' as const },
        },
      },
      textures: {
        s_noise: { source: { $ref: { collection: 'assets' as const, id: 'noise' } } },
      },
    };
    const heat = property('heat', 'number');
    heat.defaultValue = 0.75;

    expect(materialApplicationPreviewOverrides(application, [heat])).toEqual({
      parameters: {
        u_literal: { type: 'float', value: 0.25 },
        u_heat: { type: 'float', value: 0.75 },
        u_time: { type: 'float', standardFacet: 'occurrence-time' },
      },
      textures: { s_noise: { assetId: 'noise' } },
    });
  });

  it('resolves sparse Instance entries over Definition entries and reveals inherited values when reset', () => {
    const inherited = {
      material: { $ref: { collection: 'materials' as const, id: 'base' } },
      parameters: {
        u_amount: { type: 'float' as const, source: { kind: 'literal' as const, value: 0.25 } },
        u_definition: { type: 'float' as const, source: { kind: 'literal' as const, value: 0.5 } },
      },
      textures: {},
    };
    const specialized = effectiveMaterialApplication(inherited, {
      material: { $ref: { collection: 'materials', id: 'special' } },
      parameters: {
        u_amount: { type: 'float', source: { kind: 'literal', value: 0.75 } },
      },
      textures: {},
    });
    expect(specialized?.material.$ref.id).toBe('special');
    expect(specialized?.parameters.u_amount).toEqual({
      type: 'float',
      source: { kind: 'literal', value: 0.75 },
    });
    expect(specialized?.parameters.u_definition).toEqual(inherited.parameters.u_definition);

    const reset = effectiveMaterialApplication(inherited, {
      material: null,
      parameters: {},
      textures: {},
    });
    expect(reset).toEqual(inherited);
  });
});

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
