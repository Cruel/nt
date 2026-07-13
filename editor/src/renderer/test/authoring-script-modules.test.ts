import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultScriptModuleData, validateScriptModuleData } from '../../shared/project-schema/authoring-script-modules';

describe('authoring script modules', () => {
  it('requires asset-backed modules to reference script assets', () => {
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/image.png' },
        aliases: [],
      },
    };
    const script = defaultScriptModuleData();
    script.source = { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'image' } } };

    expect(validateScriptModuleData(project, 'boot', {
      id: 'boot',
      label: 'Boot',
      data: script,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Script Module asset source must reference a script asset.' }),
    ]));
  });
});
