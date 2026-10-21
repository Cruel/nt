import { describe, expect, it, vi } from 'vite-plus/test';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  ResidentProjectWorkspaceService,
  compareProjectWorkspaceUnicodeCodePoints,
  createProjectWorkspaceSnapshot,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceFile } from '../../shared/project-workspace/project-workspace-service';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { parse as parseYaml } from 'yaml';
import {
  FINAL_WORKSPACE_FIXTURE_ROOT,
  finalWorkspaceV1SourceTreeFixture,
} from './fixtures/workspace-v1-comprehensive';

function filesFor(project = createAuthoringProject({ id: 'headless', name: 'Headless' })) {
  return Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([file, text]) => [
      `/projects/headless/${file}`,
      text,
    ]),
  );
}

describe('ProjectWorkspaceService', () => {
  it('makes the native CLI retired-workspace poison executable while preserving the oracle', () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem({});
    try {
      vi.stubEnv('NOVELTEA_CLI_CERTIFICATION', '1');
      vi.stubEnv('NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE', '1');
      vi.stubEnv('NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE', '1');
      expect(() => new ProjectWorkspaceService(fileSystem)).toThrow(
        'Native CLI certification reached retired TypeScript workspace authority.',
      );
      // The native resident coordinator deliberately inherits shared pure
      // helpers; constructing it is not a legacy Project authoring read.
      expect(() => new ResidentProjectWorkspaceService(fileSystem)).not.toThrow();
      vi.stubEnv('NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE', '0');
      expect(() => new ProjectWorkspaceService(fileSystem)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('quotes ambiguous authored strings in new YAML Variables and after workspace save/reopen', async () => {
    const path = 'records/variables/flag.yaml';
    const codec = projectWorkspaceSourceCodec(path);
    const ambiguous = ['yes', 'NO', 'on', 'off', 'Y', '~', '0123', '.inf', '.NaN'];
    for (const value of ambiguous) {
      const record = {
        id: 'flag',
        label: 'Flag',
        data: {
          kind: 'variable' as const,
          type: 'string' as const,
          nullable: false,
          scope: 'global' as const,
          value,
        },
      };
      const generated = codec.encode(record);
      expect(codec.decode(generated), `new YAML Variable with value ${value}`).toEqual(record);
    }

    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.variables.flag = {
      id: 'flag',
      label: 'Flag',
      data: defaultVariableData('string'),
    };
    project.variables.flag.data.value = 'hello';
    const files = projectWorkspaceFiles(project, project.editor);
    const original =
      '# author note\nid: flag\nlabel: Flag\ndata:\n  type: string\n  value: hello # keep label\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({ ...files, [path]: original })
          .filter(([file]) => file !== 'records/variables/flag.json')
          .map(([file, text]) => [`/project/${file}`, text]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    let opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    for (const value of ambiguous) {
      const next = cloneAuthoringProject(opened.snapshot.project);
      next.variables.flag!.data.value = value;
      await workspace.write(
        '/project',
        opened.snapshot.workspaceRevision,
        next,
        opened.editorState,
        {},
        {
          affectedPaths: ['/variables/flag/data/value'],
        },
      );
      const saved = await fileSystem.readText(`/project/${path}`);
      expect(saved, value).toContain('# author note');
      expect(saved, value).toContain('# keep label');
      expect(saved, value).toMatch(/value: ["'][^\n]+["']/u);
      const reopened = await workspace.open('/project');
      expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
      if (!reopened.ok) return;
      expect(reopened.snapshot.project.variables.flag!.data.value).toBe(value);
      opened = reopened;
    }
  });

  it('preserves comments on existing enum sequence entries when extending or reordering', async () => {
    const codec = projectWorkspaceSourceCodec('records/variables/mode.yaml');
    const initial =
      'id: mode\nlabel: Mode\ndata:\n  type: enum\n  value: first\n  enumValues:\n    - first # existing explanation\n    # preceding note\n    - second # another explanation\n';
    const parsed = codec.decode(initial) as { data: { enumValues: string[] } };
    const next = structuredClone(parsed);
    next.data.enumValues.push('third');
    const appended = codec.encode(next, undefined, initial);
    expect(appended).toContain('- first # existing explanation');
    expect(appended).toContain('- second # another explanation');
    expect(appended).toContain('# preceding note');
    expect(appended).toContain('- third');
    expect(codec.decode(appended)).toEqual(next);
    const reordered = structuredClone(next);
    reordered.data.enumValues = ['third', 'first', 'second'];
    const output = codec.encode(reordered, undefined, appended);
    expect(output).toContain('- first # existing explanation');
    expect(output).toContain('- second # another explanation');
    expect(output).toContain('# preceding note');
    expect(codec.decode(output)).toEqual(reordered);

    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.variables.mode = codec.decode(initial) as typeof project.variables.mode;
    const sources = projectWorkspaceFiles(project, project.editor);
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({ ...sources, 'records/variables/mode.yaml': initial })
          .filter(([file]) => file !== 'records/variables/mode.json')
          .map(([file, text]) => [`/project/${file}`, text]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const updated = cloneAuthoringProject(opened.snapshot.project);
    updated.variables.mode!.data.enumValues!.push('third');
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      updated,
      opened.editorState,
      {},
      { affectedPaths: ['/variables/mode/data/enumValues'] },
    );
    const saved = await fileSystem.readText('/project/records/variables/mode.yaml');
    expect(saved).toContain('- first # existing explanation');
    expect(saved).toContain('# preceding note');
    expect(saved).toContain('- second # another explanation');
    const reopened = await workspace.open('/project');
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok)
      expect(reopened.snapshot.project.variables.mode?.data.enumValues).toEqual([
        'first',
        'second',
        'third',
      ]);
  });

  it('admits a sparse staged YAML Variable, preserves comments across a selective save, and reopens', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const original = projectWorkspaceFiles(project, project.editor);
    const yaml =
      '# Hand-authored Variable\nid: flag\nlabel: Flag # editor label\ndata:\n  type: boolean # stable type\n  # keep this note\n  value: false\n';
    const files = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({ ...original, 'records/variables/flag.yaml': yaml })
          .filter(([file]) => file !== 'records/variables/flag.json')
          .map(([file, contents]) => [`/project/${file}`, contents]),
      ),
    );
    const workspace = new ProjectWorkspaceService(files);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.project.variables.flag?.data).toEqual(defaultVariableData('boolean'));
    expect(opened.snapshot.saveUnitFileOwnership['record:variables:flag']?.files).toContain(
      'records/variables/flag.yaml',
    );
    const next = structuredClone(opened.snapshot.project);
    next.variables.flag!.data.value = true;
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      next,
      opened.editorState,
      {},
      {
        affectedPaths: ['/variables/flag/data/value'],
      },
    );
    const saved = await files.readText('/project/records/variables/flag.yaml');
    expect(saved).toContain('# Hand-authored Variable');
    expect(saved).toContain('# stable type');
    expect(saved).toContain('# keep this note');
    expect(saved).toContain('value: true');
    expect(await files.inspect('/project/records/variables/flag.json')).toBe('missing');
    expect(await files.readText('/project/project.yaml')).toBe(original['project.yaml']);
    const reopened = await workspace.open('/project');
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok) expect(reopened.snapshot.project.variables.flag?.data.value).toBe(true);
  });

  it('keeps YAML source revisions and comments separate from normalized Variable meaning', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const sources = projectWorkspaceFiles(project, project.editor);
    const filename = 'records/variables/flag.yaml';
    const original =
      '# reader note\nid: flag\nlabel: Flag\ndata:\n  type: boolean\n  nullable: false # deliberately explicit\n  value: false\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({ ...sources, [filename]: original })
          .filter(([path]) => path !== 'records/variables/flag.json')
          .map(([path, text]) => [`/project/${path}`, text]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      opened.snapshot.project,
      opened.editorState,
      {},
      { affectedPaths: ['/variables/flag/data/value'] },
    );
    expect(await fileSystem.readText(`/project/${filename}`)).toBe(original);

    const external = `${original}# new author comment\n`;
    await fileSystem.writeTextAtomic(`/project/${filename}`, external);
    const reconciled = await workspace.reconcileExistingSources(opened, [filename]);
    expect(reconciled?.ok).toBe(true);
    if (!reconciled?.ok) return;
    expect(reconciled.snapshot.project.variables.flag).toEqual(
      opened.snapshot.project.variables.flag,
    );
    expect(reconciled.snapshot.fileRevisions[filename]?.contentHash).not.toBe(
      opened.snapshot.fileRevisions[filename]?.contentHash,
    );

    const updated = cloneAuthoringProject(reconciled.snapshot.project);
    updated.variables.flag!.label = 'Changed';
    await expect(
      workspace.write(
        '/project',
        opened.snapshot.workspaceRevision,
        updated,
        updated.editor,
        {},
        {
          targetFiles: [filename],
          expectedFileRevisions: {
            [filename]: opened.snapshot.fileRevisions[filename]!.contentHash,
          },
        },
      ),
    ).rejects.toThrow();
    expect(await fileSystem.readText(`/project/${filename}`)).toBe(external);
  });

  it('rejects unsupported YAML features and ambiguous scalars without writing source', async () => {
    const codec = projectWorkspaceSourceCodec('records/variables/flag.yaml');
    const invalid = [
      'id: flag\nid: flag\nlabel: Flag\ndata: { type: boolean, value: false }\n',
      'id: flag\nlabel: Flag\ndata: &anchor { type: boolean, value: false }\n',
      'id: flag\nlabel: Flag\ndata: { type: boolean, value: *alias }\n',
      'id: flag\nlabel: Flag\ndata: { <<: { type: boolean }, value: false }\n',
      'id: flag\nlabel: !bad Flag\ndata: { type: boolean, value: false }\n',
      'id: flag\nlabel: Flag\ndata: { type: boolean, value: false }\n---\n{}\n',
      'id: flag\nlabel: Flag\ndata: { type: boolean, value: FALSE }\n',
      'id: flag\nlabel: Flag\ndata: { type: integer, value: 01 }\n',
      'id: flag\nlabel: Flag\ndata: { type: boolean, value: [] }\n',
      'id: flag\nlabel: Flag\ndata: { type: boolean, value: false, kind: variable }\n',
    ];
    for (const text of invalid) expect(() => codec.decode(text), text).toThrow();
    const multiline = codec.decode(
      'id: flag\nlabel: "007"\ndescription: |\n  Line one\n  Line two\ndata:\n  type: string\n  value: "yes"\n',
    );
    expect(multiline).toMatchObject({
      label: '007',
      description: 'Line one\nLine two\n',
      data: { value: 'yes' },
    });
    expect(
      codec.decode(
        'id: flag\nlabel: Flag\ndata:\n  type: string\n  nullable: true\n  value: null\n',
      ),
    ).toMatchObject({ data: { kind: 'variable', type: 'string', nullable: true, value: null } });
    expect(
      codec.decode('id: flag\nlabel: Flag\ndata:\n  type: string\n  value: ""\n'),
    ).toMatchObject({ data: { value: '' } });
  });
  it('shares localization source views only within the admitted workspace generation', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    const service = new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(filesFor(project)),
    );
    const first = await service.open('/projects/headless');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const views = service.localizationSourceViews(first.snapshot);
    expect(service.localizationSourceViews(first.snapshot)).toBe(views);
    const second = await service.open('/projects/headless');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(service.localizationSourceViews(second.snapshot)).not.toBe(views);
    expect(service.localizationSourceViews(second.snapshot)).toEqual(views);
  });

  it('uses Unicode code-point ordering for deterministic snapshot maps', () => {
    expect(['ä', 'z', 'Z'].sort(compareProjectWorkspaceUnicodeCodePoints)).toEqual(['Z', 'z', 'ä']);
    expect(['\u{10000}', '\u{e000}'].sort(compareProjectWorkspaceUnicodeCodePoints)).toEqual([
      '\u{e000}',
      '\u{10000}',
    ]);
  });

  it('uses the identical per-file projection for complete and selective JSON and text sources', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return true\n' } },
    };
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = '<rml>HUD</rml>\n';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const files = projectWorkspaceFiles(project, project.editor);

    for (const [path, text] of Object.entries(files)) {
      expect(projectWorkspaceFile(project, project.editor, {}, path), path).toBe(text);
      const codec = projectWorkspaceSourceCodec(path);
      expect(codec.encode(codec.decode(text), undefined, text), path).toBe(text);
    }
    expect(files['records/scripts/bootstrap.yaml']).toContain('project-file');
    expect(files['records/layouts/hud/layout.rml']).toBe('<rml>HUD</rml>\n');
    expect(
      projectWorkspaceFile(project, project.editor, {}, 'i18n/locales/es.yaml'),
    ).toBeUndefined();
  });

  it('keeps declared workspace field order while sorting record dictionaries', () => {
    const files = projectWorkspaceFiles(createAuthoringProject(), createAuthoringProject().editor);
    expect(files['project.yaml']).toMatch(
      /^schema:.*\nschemaVersion:.*\nproject:.*\n  id:.*\n  name:/s,
    );
  });

  it('round-trips an explicit Project undefined-Interaction fallback and defaults an omitted fallback', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.undefinedInteractionProgram = {
      instructions: [],
      completion: { kind: 'return' },
      outcome: 'unhandled',
    };
    const files = filesFor(project);
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(files),
    ).open('/projects/headless');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.project.undefinedInteractionProgram).toEqual(
      project.undefinedInteractionProgram,
    );

    const sparseFiles = filesFor(createAuthoringProject({ id: 'headless', name: 'Headless' }));
    const sparseManifest = projectWorkspaceSourceCodec('project.yaml').decode(
      sparseFiles['/projects/headless/project.yaml']!,
    ) as Record<string, unknown>;
    expect(sparseManifest).not.toHaveProperty('undefinedInteractionProgram');
    expect(sparseManifest).not.toHaveProperty('entrypoint');
    const sparseOpened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(sparseFiles),
    ).open('/projects/headless');
    expect(sparseOpened.ok).toBe(true);
    if (!sparseOpened.ok) return;
    expect(sparseOpened.snapshot.project.undefinedInteractionProgram).toBeNull();
    expect(sparseOpened.snapshot.project.entrypoint).toBeNull();
  });

  it('canonically projects every schema dictionary without disturbing fixed field order', () => {
    const first = createAuthoringProject();
    const second = createAuthoringProject();
    const entries = ['z', '\u{e000}', '\u{10000}'] as const;
    const definition = (id: string) => ({
      id,
      label: id,
      ownerKinds: ['room'] as 'room'[],
      properties: [],
    });
    first.traits = Object.fromEntries(entries.map((id) => [id, definition(id)]));
    second.traits = Object.fromEntries([...entries].reverse().map((id) => [id, definition(id)]));
    first.localization.locales = {
      en: { supported: true, parentLocale: null, fontStack: null },
      ...Object.fromEntries(
        entries.map((id) => [id, { supported: false, parentLocale: null, fontStack: null }]),
      ),
    };
    second.localization.locales = {
      ...Object.fromEntries(
        [...entries]
          .reverse()
          .map((id) => [id, { supported: false, parentLocale: null, fontStack: null }]),
      ),
      en: { supported: true, parentLocale: null, fontStack: null },
    };
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
    expect(firstFiles['traits.yaml']).toMatch(/z:[\s\S]*\uE000:[\s\S]*\u{10000}:/u);
    expect(firstFiles).not.toHaveProperty('properties.json');
    expect(firstFiles['records/rooms/foyer.yaml']).not.toContain('"properties"');
    expect(firstFiles['records/rooms/foyer.yaml']).toContain(
      'canEnter:\n      kind: variable-comparison\n      variable: flag\n      operator: equal\n      value: true',
    );
    expect(firstFiles['records/layouts/main/layout.yaml']).toMatch(
      /sampleState:\n    z:[\s\S]*\uE000:[\s\S]*\u{10000}:/u,
    );
    expect(firstFiles['project.yaml']).toMatch(
      /^schema:.*\nschemaVersion:.*\nproject:.*\n  id:.*\n  name:/s,
    );
  });

  it('certifies the final workspace-v1 source-tree fixture across every collection and source surface', async () => {
    const files = finalWorkspaceV1SourceTreeFixture();
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(files),
    ).open(FINAL_WORKSPACE_FIXTURE_ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    for (const collection of [
      'assets',
      'variables',
      'materials',
      'layouts',
      'characters',
      'rooms',
      'interactables',
      'verbs',
      'interactions',
      'dialogues',
      'scenes',
      'maps',
      'scripts',
      'tests',
    ] as const) {
      expect(Object.keys(opened.snapshot.project[collection]).length, collection).toBeGreaterThan(
        0,
      );
    }

    expect(opened.snapshot.canonicalSourceFiles).toEqual(
      expect.arrayContaining([
        'project.yaml',
        'i18n/project.yaml',
        'i18n/messages.yaml',
        'i18n/usage-notes.yaml',
        'i18n/tracking.yaml',
        'i18n/orphans.yaml',
        'editor.yaml',
        'records/layouts/hud-inline/layout.yaml',
        'records/layouts/hud-inline/layout.rml',
        'records/layouts/hud-inline/layout.rcss',
        'records/layouts/hud-inline/layout.lua',
        'records/scripts/inline-module.yaml',
        'scripts/inline-module.lua',
      ]),
    );
    expect(opened.snapshot.canonicalSourceFiles).not.toContain('assets/images/main.png');
    expect(files).toHaveProperty(`${FINAL_WORKSPACE_FIXTURE_ROOT}/AGENTS.md`);
    expect(files).toHaveProperty(`${FINAL_WORKSPACE_FIXTURE_ROOT}/.gitignore`);
    expect(files).toHaveProperty(`${FINAL_WORKSPACE_FIXTURE_ROOT}/.noveltea/editor/state.json`);
    expect(opened.editorState).toMatchObject({ schema: 'noveltea.editor.project-state' });
  });

  it('loads the current segmented workspace without Electron', async () => {
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(filesFor()),
    ).open('/projects/headless');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.manifestPath).toBe('/projects/headless/project.yaml');
    expect(opened.snapshot.canonicalSourceFiles).toContain('project.yaml');
    expect(opened.snapshot.canonicalSourceFiles).toContain('editor.yaml');
    expect(opened.snapshot.saveUnitFileOwnership['project:settings']?.files).toEqual([
      'project.yaml',
    ]);
    expect(opened.snapshot.saveUnitFileOwnership['project:settings']?.paths).toContain(
      '/interactableInstances',
    );
    expect(opened.snapshot.saveUnitFileOwnership['collection:traits']?.files).toEqual([
      'traits.yaml',
    ]);
    expect(opened.snapshot.saveUnitFileOwnership['project:localization']).toEqual({
      files: [
        'i18n/messages.yaml',
        'i18n/orphans.yaml',
        'i18n/project.yaml',
        'i18n/tracking.yaml',
        'i18n/usage-notes.yaml',
      ],
      paths: ['/localization'],
    });
    expect(opened.snapshot.saveUnitFileOwnership['workflow:play-recorder']?.paths).toEqual([
      '/tests',
      '/editor/recordMetadata/tests',
    ]);
  });

  it('rejects retired shader variants in segmented project workspaces', async () => {
    const files = filesFor();
    const manifestPath = '/projects/headless/project.yaml';
    const manifest = projectWorkspaceSourceCodec('project.yaml').decode(files[manifestPath]!) as {
      export: { runtime: { shaderVariants: string[] } };
    };
    manifest.export.runtime.shaderVariants = ['unsupported-desktop', 'essl-300'];
    files[manifestPath] = projectWorkspaceSourceCodec('project.yaml').encode(manifest);

    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(files),
    ).open('/projects/headless');

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.diagnostics).toContainEqual(
      expect.objectContaining({
        path: '/export/runtime/shaderVariants/0',
      }),
    );
  });

  it('reports precise authoring schema diagnostics when workspace fragments assemble invalid data', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const files = filesFor(project);
    const roomPath = '/projects/headless/records/rooms/foyer.yaml';
    const room = parseYaml(files[roomPath]!) as {
      data: { interactables: unknown[] };
    };
    room.data.interactables = [
      {
        id: 'key-instance',
        interactable: { $ref: { collection: 'interactables', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 42,
        enabled: true,
        visible: true,
        order: 0,
        bounds: {},
      },
    ];
    files[roomPath] = `${JSON.stringify(room, null, 2)}\n`;

    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(files),
    ).open('/projects/headless');

    expect(opened.ok).toBe(false);
    if (opened.ok) return;

    expect(opened.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/foyer/data/interactables/0/placementId',
          code: 'authoring.schema.invalid_type',
        }),
        expect.objectContaining({
          path: '/rooms/foyer/data/interactables/0',
          code: 'authoring.schema.unrecognized_keys',
          message: expect.stringContaining('bounds'),
        }),
      ]),
    );
    expect(opened.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      'Workspace fragments do not assemble into the current authoring project.',
    );
  });

  it('returns the full composed editor state while keeping contentProject editor-free', async () => {
    const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.editor.recordMetadata.rooms = {
      hall: { tags: ['indoors'], color: null },
    };
    project.editor.tags.records.indoors = { name: 'indoors', color: 'tag-slate' };
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(filesFor(project)),
    ).open('/projects/headless');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.editorState.recordMetadata.rooms?.hall).toEqual({
      tags: ['indoors'],
      color: null,
    });
    expect(opened.editorState.tags.records.indoors).toEqual({
      name: 'indoors',
      color: 'tag-slate',
    });
    expect(opened.editorState).toEqual(opened.snapshot.project.editor);
    expect(opened.contentProject).not.toHaveProperty('editor');
  });

  it('rejects metadata keys that would mutate dictionary prototypes', async () => {
    const files = filesFor();
    files['/projects/headless/editor.yaml'] = `${JSON.stringify({
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
    files['/projects/headless/project.yaml'] = JSON.stringify({
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
    expect(files['records/rooms/foyer.yaml']).toContain('id: foyer');
    expect(files['scripts/bootstrap.lua']).toBe('return true\n');
    expect(files['records/scripts/bootstrap.yaml']).toContain('project-file');
    const opened = await new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem(
        Object.fromEntries(Object.entries(files).map(([file, text]) => [`/project/${file}`, text])),
      ),
    ).open('/project');
    expect(opened.ok).toBe(true);
    if (opened.ok)
      expect(opened.snapshot.project.scripts.bootstrap?.data).toEqual({
        kind: 'script-module',
        source: { kind: 'project-file', path: 'scripts/bootstrap.lua' },
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
    files['records/scripts/bootstrap.yaml'] = files['records/scripts/bootstrap.yaml']!.replace(
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

  it('preserves file-backed Script Module source across a collection-level Asset write', async () => {
    const project = createAuthoringProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: {
        kind: 'script-module',
        source: { kind: 'project-file', path: 'scripts/bootstrap.lua' },
      },
    } as never;
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    } as never;
    const projected = projectWorkspaceFiles(project, project.editor);
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({
          ...projected,
          'scripts/bootstrap.lua': 'return true\n',
          'assets/logo.bin': 'asset bytes',
        }).map(([file, text]) => [`/project/${file}`, text]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fileSystem);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const changed = structuredClone(opened.snapshot.project);
    changed.assets.logo!.label = 'Changed Logo';
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      changed,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      { affectedPaths: ['/assets'] },
    );

    expect(await fileSystem.readText('/project/scripts/bootstrap.lua')).toBe('return true\n');
    expect(await fileSystem.readText('/project/records/assets/logo.yaml')).toContain(
      'Changed Logo',
    );
    const reopened = await workspace.open('/project');
    expect(reopened.ok).toBe(true);
  });

  it('preserves project-file Script Module identity and asset-backed Layout identity', async () => {
    const project = createAuthoringProject();
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
        source: { kind: 'project-file', path: 'scripts/custom/bootstrap.lua' },
      },
    } as never;
    const layout = defaultLayoutData('HUD');
    layout.rml = {
      sourceMode: 'asset',
      sourceText: '',
      sourceAsset: { $ref: { collection: 'assets', id: 'rml' } },
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout } as never;

    const snapshot = await createProjectWorkspaceSnapshot(project, {
      bootstrap: 'scripts/custom/bootstrap.lua',
    });
    expect(snapshot.externalSourceDescriptors).toContainEqual(
      expect.objectContaining({
        semanticOwner: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
        sourcePath: '/scripts/bootstrap/data/source/path',
        sourceUrl: 'project:/scripts/custom/bootstrap.lua',
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

  it('keeps ignored editor-local state out of working workspace identity', async () => {
    const project = createAuthoringProject({ id: 'identity', name: 'Identity' });
    const baseline = await createProjectWorkspaceSnapshot(project);

    const localOnly = structuredClone(project);
    localOnly.editor.bottomPanel.visible = false;
    localOnly.editor.recovery = {
      sequence: 1,
      saveUnitsById: {
        'project:settings': {
          sequence: 1,
          patches: [{ op: 'replace', path: '/project/name', value: 'Recovered' }],
          affectedPaths: ['/project/name'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
        },
      },
    };
    expect((await createProjectWorkspaceSnapshot(localOnly)).workspaceRevision).toBe(
      baseline.workspaceRevision,
    );

    const tracked = structuredClone(project);
    tracked.editor.tags.records.story = { name: 'Story', color: 'tag-slate' };
    expect((await createProjectWorkspaceSnapshot(tracked)).workspaceRevision).not.toBe(
      baseline.workspaceRevision,
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
    files['records/scripts/before.yaml'] = files['records/scripts/before.yaml']!.replace(
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
    expect(await fileSystem.readText('/project/records/scripts/after.yaml')).toContain(
      'scripts/custom.lua',
    );
    expect(await fileSystem.readText('/project/scripts/custom.lua')).toBe('return true\n');
  });

  it('rejects a stale aggregate revision after authored content/editor/source changes but not asset bytes', async () => {
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
      ['project.yaml', `${originals['project.yaml']} `],
      ['editor.yaml', `${originals['editor.yaml']} `],
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
    if (!opened.ok) return;
    await files.writeTextAtomic('/project/assets/logo.bin', 'changed asset bytes');
    await expect(
      workspace.write(
        '/project',
        opened.snapshot.workspaceRevision,
        opened.snapshot.project,
        opened.editorState,
      ),
    ).resolves.toBeDefined();
  });
});
