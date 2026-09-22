import { describe, expect, it } from 'vite-plus/test';
import {
  materialContractPresetIds,
  materialContractRegistry,
  materialContractRoleIds,
} from '../../shared/project-schema/material-contract-registry.generated';
import {
  materialPreset,
  materialPresetIdValues,
  materialPresets,
} from '../../shared/project-schema/authoring-material-presets';

describe('Material contract registry projection', () => {
  it('defines the five current roles and six stable V1 preset identities', () => {
    expect(materialContractRoleIds).toEqual([
      'engine-2d',
      'active-text',
      'rmlui-decorator',
      'postprocess',
      'hotspot-overlay',
    ]);
    expect(materialContractPresetIds).toEqual([
      'engine-2d',
      'active-text',
      'rmlui-decorator',
      'postprocess-tint',
      'hotspot-overlay-alpha',
      'hotspot-overlay-custom',
    ]);
    expect(materialPresetIdValues).toEqual(materialContractPresetIds);

    for (const preset of materialContractRegistry.presets) {
      expect(preset.contractIdentity).toBe(`noveltea.material-preset:${preset.id}:1`);
      expect(preset.contractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(materialPreset(preset.id)?.interfaceContract).toBe(preset.contractIdentity);
      expect(materialPreset(preset.id)?.interfaceFingerprint).toBe(preset.contractFingerprint);
    }
  });

  it('projects the canonical renderer-owned Engine2D draw texture contract without changing the current authoring preset shape', () => {
    const role = materialContractRegistry.roles.find((candidate) => candidate.id === 'engine-2d');
    expect(role?.reservedInterface.samplers).toContainEqual({
      name: 's_texColor',
      semantic: 'engine.draw_texture',
      physicalType: 'texture2d',
      stage: 0,
      sourceOwnership: 'renderer',
      addressPolicy: ['clamp', 'repeat'],
      filterPolicy: ['inherit', 'nearest', 'linear'],
      observation: 'rgba-color',
    });

    expect(materialPresets['engine-2d'].uniforms).toEqual({
      u_useTexture: { type: 'float', default: 1, label: 'Use Texture' },
    });
    expect(materialPresets['engine-2d'].samplers).toEqual({ s_texColor: {} });
  });

  it('describes strict hotspot sampler capability differences in the generated contract', () => {
    const alpha = materialContractRegistry.presets.find(
      (candidate) => candidate.id === 'hotspot-overlay-alpha',
    );
    const custom = materialContractRegistry.presets.find(
      (candidate) => candidate.id === 'hotspot-overlay-custom',
    );

    expect(alpha?.capabilities.samplers).toEqual({
      s_hotspotImage: 'required',
      s_hotspotMask: 'disabled',
    });
    expect(custom?.capabilities.samplers).toEqual({
      s_hotspotImage: 'required',
      s_hotspotMask: 'required',
    });
  });
});
