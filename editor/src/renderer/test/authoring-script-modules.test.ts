import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultScriptModuleData,
  scriptModuleLifecycleMetadata,
  validateScriptModuleData,
} from '../../shared/project-schema/authoring-script-modules';

describe('authoring script modules', () => {
  it('reports literal imports and On Game Ready participation for inline tooling', () => {
    const data = defaultScriptModuleData();
    data.source = {
      kind: 'inline-lua',
      source: `local shared = import('shared')\nreturn { on_ready = function() end }`,
    };
    expect(scriptModuleLifecycleMetadata(data)).toEqual({
      onGameReady: 'declared',
      literalImports: ['shared'],
    });
  });

  it('validates statically knowable missing imports and literal import cycles', () => {
    const project = createAuthoringProject();
    project.scripts.a = {
      id: 'a',
      label: 'A',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `import('b')\nreturn {}` },
      },
    };
    project.scripts.b = {
      id: 'b',
      label: 'B',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `import('a')\nreturn {}` },
      },
    };
    project.scripts.missing = {
      id: 'missing',
      label: 'Missing',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `import('does-not-exist')\nreturn {}` },
      },
    };

    expect(validateScriptModuleData(project, 'a', project.scripts.a)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Script Module literal imports contain a cycle.' }),
      ]),
    );
    expect(validateScriptModuleData(project, 'missing', project.scripts.missing)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Script Module imports missing Script Module 'does-not-exist'.",
        }),
      ]),
    );
  });

  it('accepts contained project-file modules and rejects obsolete asset-backed shapes', () => {
    const project = createAuthoringProject();
    const projectFile = {
      kind: 'script-module' as const,
      source: { kind: 'project-file' as const, path: 'scripts/boot.lua' },
    };
    expect(
      validateScriptModuleData(project, 'boot', {
        id: 'boot',
        label: 'Boot',
        data: projectFile,
      }),
    ).toEqual([]);

    const obsolete = {
      kind: 'script-module',
      source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'legacy' } } },
    };
    expect(
      validateScriptModuleData(project, 'boot', {
        id: 'boot',
        label: 'Boot',
        data: obsolete,
      }),
    ).not.toEqual([]);
  });
});
