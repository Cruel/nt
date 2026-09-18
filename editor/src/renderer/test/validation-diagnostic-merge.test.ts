import { describe, expect, it } from 'vite-plus/test';
import { mergeEditorValidationDiagnostics } from '../diagnostics/validation-diagnostic-merge';

describe('mergeEditorValidationDiagnostics', () => {
  it('preserves rich editor diagnostics when the CLI/cache projection reports the same issue', () => {
    const rich = {
      code: 'authoring.interactable.missing_property_value',
      severity: 'error' as const,
      path: '/interactableInstances/key/properties/condition',
      message: "Property 'condition' requires a value.",
      category: 'Interactable property',
      ownerPaths: ['/rooms/start/interactableInstances/key'],
      navigation: {
        kind: 'interactable-instance-property' as const,
        instanceId: 'key',
        propertyId: 'condition',
      },
    };
    const projected = {
      code: rich.code,
      severity: rich.severity,
      path: rich.path,
      message: rich.message,
    };
    const supplemental = {
      code: 'localization.font_coverage.missing_glyph',
      severity: 'warning' as const,
      path: '/localization',
      message: 'Missing glyph.',
    };

    const result = mergeEditorValidationDiagnostics([rich], [projected, supplemental]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(rich);
    expect(result[0]).toMatchObject({
      ownerPaths: rich.ownerPaths,
      navigation: rich.navigation,
    });
    expect(result[1]).toEqual(supplemental);
  });
});
