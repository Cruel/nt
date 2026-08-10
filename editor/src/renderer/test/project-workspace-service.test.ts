import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  compareProjectWorkspaceUnicodeCodePoints,
  createProjectWorkspaceSnapshot,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

function filesFor(project = createAuthoringProject({ id: 'headless', name: 'Headless' })) {
  return Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([file, text]) => [
      `/projects/headless/${file}`,
      text,
    ]),
  );
}

describe('ProjectWorkspaceService', () => {
  it('uses Unicode code-point ordering for deterministic snapshot maps', () => {
    expect(['ä', 'z', 'Z'].sort(compareProjectWorkspaceUnicodeCodePoints)).toEqual(['Z', 'z', 'ä']);
    expect(['\u{10000}', '\u{e000}'].sort(compareProjectWorkspaceUnicodeCodePoints)).toEqual([
      '\u{e000}',
      '\u{10000}',
    ]);
  });

  it('keeps declared workspace field order while sorting record dictionaries', () => {
    const files = projectWorkspaceFiles(createAuthoringProject(), createAuthoringProject().editor);
    expect(files['project.json']).toMatch(
      /^\{\n  "schema":.*\n  "schemaVersion":.*\n  "project":.*\n  "settings":.*\n  "startupHook":.*\n  "entrypoint":/s,
    );
  });

  it('canonically projects every schema dictionary without disturbing fixed field order', () => {
    const first = createAuthoringProject();
    const second = createAuthoringProject();
    const entries = ['z', '\u{e000}', '\u{10000}'] as const;
    const definition = (id: string) => ({
      id,
      label: id,
      type: 'string' as const,
      nullable: false,
      ownerKinds: ['room'] as 'room'[],
      persistence: 'Save' as const,
    });
    first.properties = Object.fromEntries(entries.map((id) => [id, definition(id)]));
    second.properties = Object.fromEntries(
      [...entries].reverse().map((id) => [id, definition(id)]),
    );
    first.localization.catalogs = Object.fromEntries(entries.map((id) => [id, { z: id, a: id }]));
    second.localization.catalogs = Object.fromEntries(
      [...entries].reverse().map((id) => [id, { a: id, z: id }]),
    );
    first.layouts.main = {
      id: 'main',
      label: 'Main',
      data: {
        ...defaultLayoutData('Main'),
        sampleState: Object.fromEntries(entries.map((id) => [id, id])),
      },
    };
    second.layouts.main = {
      id: 'main',
      label: 'Main',
      data: {
        ...defaultLayoutData('Main'),
        sampleState: Object.fromEntries([...entries].reverse().map((id) => [id, id])),
      },
    };
    first.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      properties: Object.fromEntries(entries.map((id) => [id, id])),
      data: {
        ...defaultRoomData('Foyer'),
        lifecycle: {
          ...defaultRoomData('Foyer').lifecycle,
          canEnter: {
            value: true,
            operator: 'equal',
            variable: { $ref: { collection: 'variables', id: 'flag' } },
            kind: 'variable-comparison',
          },
        },
      },
    };
    second.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      properties: Object.fromEntries([...entries].reverse().map((id) => [id, id])),
      data: {
        ...defaultRoomData('Foyer'),
        lifecycle: {
          ...defaultRoomData('Foyer').lifecycle,
          canEnter: {
            kind: 'variable-comparison',
            variable: { $ref: { collection: 'variables', id: 'flag' } },
            operator: 'equal',
            value: true,
          },
        },
      },
    };
    first.editor.recordMetadata = Object.fromEntries(entries.map((id) => [id, {}]));
    second.editor.recordMetadata = Object.fromEntries([...entries].reverse().map((id) => [id, {}]));

    const firstFiles = projectWorkspaceFiles(first, first.editor);
    const secondFiles = projectWorkspaceFiles(second, second.editor);
    expect(firstFiles).toEqual(secondFiles);
    expect(firstFiles['properties.json']).toMatch(/"z"[\s\S]*"\uE000"[\s\S]*"𐀀"/);
    expect(firstFiles['records/rooms/foyer.json']).toMatch(
      /^\{\n  "id": "foyer",\n  "label": "Foyer",\n  "properties":/,
    );
    expect(firstFiles['records/rooms/foyer.json']).toMatch(
      /"canEnter": \{\n        "kind": "variable-comparison",\n        "variable": \{\n          "\$ref": \{\n            "collection": "variables",\n            "id": "flag"\n          \}\n        \},\n        "operator": "equal",\n        "value": true/s,
    );
    expect(firstFiles['records/layouts/main/layout.json']).toMatch(
      /"sampleState": \{\n      "z"[\s\S]*"\uE000"[\s\S]*"𐀀"/,
    );
    expect(firstFiles['project.json']).toMatch(
      /^\{\n  "schema":.*\n  "schemaVersion":.*\n  "project":.*\n  "settings":/s,
    );
  });

  it('loads the current segmented workspace without Electron', async () => {
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(filesFor()),
    ).open('/projects/headless');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.manifestPath).toBe('/projects/headless/project.json');
    expect(opened.snapshot.canonicalSourceFiles).toContain('project.json');
    expect(opened.snapshot.canonicalSourceFiles).toContain('editor.json');
    expect(opened.snapshot.saveUnitFileOwnership['project:settings']?.files).toEqual([
      'project.json',
    ]);
    expect(opened.snapshot.saveUnitFileOwnership['workflow:play-recorder']?.paths).toEqual([
      '/tests',
    ]);
  });

  it('rejects metadata keys that would mutate dictionary prototypes', async () => {
    const files = filesFor();
    files['/projects/headless/editor.json'] = `${JSON.stringify({
      chapters: { records: {} },
      tags: { records: {} },
      recordMetadata: JSON.parse(
        '{"__proto__":{"ghost":{"tags":["outer"]}},"rooms":{"__proto__":{"tags":["inner"]}}}',
      ),
    })}\n`;

    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(files),
    ).open('/projects/headless');
    expect(opened.ok).toBe(false);
  });

  it('rejects retired monolithic files and unsupported workspace versions', async () => {
    const project = createAuthoringProject();
    const monolithic = new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem({
        '/projects/old/game.json': `${JSON.stringify(project)}\n`,
      }),
    );
    expect((await monolithic.open('/projects/old')).ok).toBe(false);
    const files = filesFor();
    files['/projects/headless/project.json'] = JSON.stringify({
      schema: 'noveltea.project.workspace',
      schemaVersion: 2,
    });
    expect(
      (
        await new ProjectWorkspaceService(new InMemoryProjectWorkspaceFileSystem(files)).open(
          '/projects/headless',
        )
      ).ok,
    ).toBe(false);
  });

  it('projects records and file-backed layout/script source deterministically', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return true\n' } },
    };
    const files = { ...projectWorkspaceFiles(project, project.editor) };
    expect(files['records/rooms/foyer.json']).toContain('"foyer"');
    expect(files['scripts/bootstrap.lua']).toBe('return true\n');
    expect(files['records/scripts/bootstrap.json']).toContain('"file"');
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(
        Object.fromEntries(Object.entries(files).map(([file, text]) => [`/project/${file}`, text])),
      ),
    ).open('/project');
    expect(opened.ok).toBe(true);
    if (opened.ok)
      expect(opened.snapshot.project.scripts.bootstrap?.data).toEqual({
        kind: 'script-module',
        source: { kind: 'inline-lua', source: 'return true\n' },
      });
  });

  it('indexes file-backed Script Module and Layout source through Project Search', async () => {
    const project = createAuthoringProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `local marker = 'script-search-marker'\n` },
      },
    };
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = '<rml><body>layout-search-marker</body></rml>';
    layout.rcss.sourceText = '.hud { content: "rcss-search-marker"; }';
    layout.lua.sourceText = `local marker = 'layout-lua-search-marker'`;
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const projected = projectWorkspaceFiles(project, project.editor);
    const service = new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(
        Object.fromEntries(
          Object.entries(projected).map(([file, text]) => [`/project/${file}`, text]),
        ),
      ),
    );
    const opened = await service.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const documents = service.buildSearchIndex(opened.snapshot).documents;
    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'source:project:/scripts/bootstrap.lua',
          sourcePath: 'project:/scripts/bootstrap.lua',
          fields: expect.arrayContaining([
            expect.objectContaining({ value: expect.stringContaining('script-search-marker') }),
          ]),
        }),
        expect.objectContaining({
          id: 'source:project:/records/layouts/hud/layout.rml',
          sourcePath: 'project:/records/layouts/hud/layout.rml',
        }),
        expect.objectContaining({
          id: 'source:project:/records/layouts/hud/layout.rcss',
          sourcePath: 'project:/records/layouts/hud/layout.rcss',
        }),
        expect.objectContaining({
          id: 'source:project:/records/layouts/hud/layout.lua',
          sourcePath: 'project:/records/layouts/hud/layout.lua',
        }),
      ]),
    );
  });

  it('publishes the compiler input from an assembled workspace snapshot', async () => {
    const service = new ProjectWorkspaceService(new InMemoryProjectWorkspaceFileSystem(filesFor()));
    const opened = await service.open('/projects/headless');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(service.publishCompiledArtifact(opened.snapshot)).toMatchObject({
      diagnostics: expect.any(Array),
    });
  });

  it('preserves an explicit Script Module source path outside the internal schema', async () => {
    const project = createAuthoringProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return true\n' } },
    };
    const files = { ...projectWorkspaceFiles(project, project.editor) };
    files['records/scripts/bootstrap.json'] = files['records/scripts/bootstrap.json']!.replace(
      'scripts/bootstrap.lua',
      'scripts/custom/bootstrap-entry.lua',
    );
    delete files['scripts/bootstrap.lua'];
    files['scripts/custom/bootstrap-entry.lua'] = 'return true\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(files).map(([file, text]) => [`/project/${file}`, text])),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.scriptSourcePaths).toEqual({
      bootstrap: 'scripts/custom/bootstrap-entry.lua',
    });
    expect(opened.snapshot.externalSourceDescriptors).toContainEqual(
      expect.objectContaining({ sourceUrl: 'project:/scripts/custom/bootstrap-entry.lua' }),
    );
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      opened.snapshot.project,
      opened.editorState,
    );
    const reloaded = await workspace.open('/project');
    expect(reloaded.ok && reloaded.snapshot.scriptSourcePaths.bootstrap).toBe(
      'scripts/custom/bootstrap-entry.lua',
    );
  });

  it('does not replace asset-backed source identities with workspace companion paths', () => {
    const project = createAuthoringProject();
    project.assets.script = {
      id: 'script',
      label: 'Script',
      data: {
        kind: 'script',
        source: { type: 'project-file', path: 'assets/lua/shared.lua' },
        aliases: [],
        extension: '.lua',
        imageMetadata: null,
      },
    } as never;
    project.assets.rml = {
      id: 'rml',
      label: 'RML',
      data: {
        kind: 'text',
        source: { type: 'project-file', path: 'assets/ui/shared.rml' },
        aliases: [],
        extension: '.rml',
        imageMetadata: null,
      },
    } as never;
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'script' } } },
      },
    } as never;
    const layout = defaultLayoutData('HUD');
    layout.rml = {
      sourceMode: 'asset',
      sourceText: '',
      sourceAsset: { $ref: { collection: 'assets', id: 'rml' } },
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout } as never;

    const snapshot = createProjectWorkspaceSnapshot(project, {
      bootstrap: 'scripts/custom/bootstrap.lua',
    });
    expect(snapshot.externalSourceDescriptors).toContainEqual(
      expect.objectContaining({
        semanticOwner: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
        sourceAssetId: 'script',
        sourceUrl: 'project:/assets/lua/shared.lua',
      }),
    );
    expect(snapshot.externalSourceDescriptors).toContainEqual(
      expect.objectContaining({
        semanticOwner: { kind: 'record', collection: 'layouts', id: 'hud' },
        sourceAssetId: 'rml',
        sourceUrl: 'project:/assets/ui/shared.rml',
      }),
    );
  });

  it('retains a custom Script Module path through an ID rename', async () => {
    const project = createAuthoringProject();
    project.scripts.before = {
      id: 'before',
      label: 'Before',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return true\n' } },
    };
    const files = { ...projectWorkspaceFiles(project, project.editor) };
    files['records/scripts/before.json'] = files['records/scripts/before.json']!.replace(
      'scripts/before.lua',
      'scripts/custom.lua',
    );
    delete files['scripts/before.lua'];
    files['scripts/custom.lua'] = 'return true\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(files).map(([file, text]) => [`/project/${file}`, text])),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const renamed = structuredClone(opened.snapshot.project);
    renamed.scripts.after = { ...renamed.scripts.before!, id: 'after', label: 'After' };
    delete renamed.scripts.before;
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      renamed,
      opened.editorState,
      { after: 'scripts/custom.lua' },
    );
    expect(await fileSystem.readText('/project/records/scripts/after.json')).toContain(
      'scripts/custom.lua',
    );
    expect(await fileSystem.readText('/project/scripts/custom.lua')).toBe('return true\n');
  });

  it('rejects a stale aggregate revision after content, editor, asset, or source changes', async () => {
    const project = createAuthoringProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return true\n' } },
    };
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    const originals = projectWorkspaceFiles(project, project.editor);
    for (const [file, replacement] of [
      ['project.json', `${originals['project.json']} `],
      ['editor.json', `${originals['editor.json']} `],
      ['assets/logo.bin', 'changed asset bytes'],
      ['scripts/bootstrap.lua', 'return false\n'],
    ] as const) {
      const files = new InMemoryProjectWorkspaceFileSystem(
        Object.fromEntries(
          Object.entries({ ...originals, 'assets/logo.bin': 'asset bytes' }).map(([path, text]) => [
            `/project/${path}`,
            text,
          ]),
        ),
      );
      const workspace = new ProjectWorkspaceService(files);
      const opened = await workspace.open('/project');
      expect(opened.ok).toBe(true);
      if (!opened.ok) continue;
      await files.writeTextAtomic(`/project/${file}`, replacement);
      await expect(
        workspace.write(
          '/project',
          opened.snapshot.workspaceRevision,
          opened.snapshot.project,
          opened.editorState,
        ),
      ).rejects.toThrow('Project content changed outside the editor.');
    }
  });
});
