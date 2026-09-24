import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { readEngineShaderSource } from '../../main/services/project-source-file-service';
import { materialPresets } from '../../shared/project-schema/authoring-material-presets';

describe('built-in Material shader sources', () => {
  it('loads preset shader text from the canonical engine source files', async () => {
    const referenced = new Set<string>();
    for (const preset of Object.values(materialPresets)) {
      referenced.add(preset.vertexSource);
      referenced.add(preset.fragmentSource);
      referenced.add(preset.varyingDefinition);
    }

    for (const sourceIdentity of referenced) {
      const source = await readEngineShaderSource(sourceIdentity);
      const filename = sourceIdentity.slice('engine:/'.length);
      const engineSource = await readFile(
        path.resolve('..', 'engine', 'shaders', 'bgfx', filename),
        'utf8',
      );
      expect(source, sourceIdentity).toBe(engineSource);
    }
  });

  it('rejects non-engine and nested source identities', async () => {
    await expect(readEngineShaderSource('project:/shaders/example.sc')).resolves.toBeNull();
    await expect(readEngineShaderSource('engine:/nested/example.sc')).resolves.toBeNull();
  });
});
