import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { materialPresets } from '../../shared/project-schema/authoring-material-presets';
import {
  builtInMaterialShaderSource,
  builtInMaterialShaderSources,
} from '../../shared/project-schema/authoring-material-preset-sources';

describe('built-in Material shader source catalog', () => {
  it('matches the engine shader sources used by Material Presets', async () => {
    const referenced = new Set<string>();
    for (const preset of Object.values(materialPresets)) {
      referenced.add(preset.vertexSource);
      referenced.add(preset.fragmentSource);
      referenced.add(preset.varyingDefinition);
    }

    for (const sourceIdentity of referenced) {
      const source = builtInMaterialShaderSource(sourceIdentity);
      expect(source, sourceIdentity).not.toBeNull();
      const filename = sourceIdentity.replace(/^engine:\//u, '');
      const engineSource = await readFile(
        path.resolve('..', 'engine', 'shaders', 'bgfx', filename),
        'utf8',
      );
      expect(source, sourceIdentity).toBe(engineSource);
    }
  });

  it('does not expose unrelated engine files through the built-in source catalog', () => {
    expect(builtInMaterialShaderSource('engine:/not-a-material-source.sc')).toBeNull();
    expect(
      Object.keys(builtInMaterialShaderSources).every((identity) =>
        identity.startsWith('engine:/'),
      ),
    ).toBe(true);
  });
});
