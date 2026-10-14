import { describe, expect, it } from 'vite-plus/test';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { featureLabYamlFiles, featureLabYamlRecord } from './feature-lab-yaml-fixtures';

describe('Layout, Archetype and Script Module YAML owners', () => {
  it('retains Feature Lab Archetype pointers and Script Module file ownership', () => {
    for (const family of ['archetypes', 'scripts'] as const) {
      for (const name of featureLabYamlFiles(family)) {
        const record = authoringRecordSchemas[family].parse(featureLabYamlRecord(family, name));
        const codec = projectWorkspaceSourceCodec(`records/${family}/${name.slice(0, -5)}.yaml`);
        const yaml = codec.encode(record);
        expect(codec.decode(yaml), name).toEqual(record);
        expect(codec.encode(record, undefined, yaml)).toBe(yaml);
        expect(yaml).not.toContain('kind: script-module');
      }
    }
  });

  it('edits and reopens annotated YAML owners without rewriting companion Lua/RML/RCSS', async () => {
    const project = createAuthoringProject({ id: 'layout-yaml', name: 'Layout YAML' });
    project.archetypes.template = {
      id: 'template',
      label: 'Template',
      data: defaultArchetypeData('room'),
    };
    project.archetypes.template.data.overrides['/data/displayName'] = 'yes';
    project.scripts.hooks = {
      id: 'hooks',
      label: 'Hooks',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return {}\n' } },
    };
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = '<rml><body/></rml>\n';
    layout.rcss.sourceText = 'body { color: red; }\n';
    layout.lua = { sourceMode: 'inline', sourceText: 'return {}\n' };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const owners = [
      'records/archetypes/template.yaml',
      'records/scripts/hooks.yaml',
      'records/layouts/hud/layout.yaml',
    ];
    const files = projectWorkspaceFiles(project, project.editor, {}, new Set(owners));
    for (const path of owners) expect(files[path], path).toBeTruthy();
    expect(files['records/layouts/hud/layout.yaml']).not.toContain('sampleState:');
    expect(files['records/layouts/hud/layout.yaml']).not.toContain('kind: layout');
    const annotated = { ...files };
    for (const path of owners)
      annotated[path] = files[path]!.replace('label:', '# author comment\nlabel:');
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries(annotated).map(([path, value]) => [`/project/${path}`, value]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open('/project');
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    const updated = cloneAuthoringProject(opened.snapshot.project);
    updated.layouts.hud!.label = 'HUD Updated';
    updated.archetypes.template!.label = 'Template Updated';
    updated.scripts.hooks!.label = 'Hooks Updated';
    await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      updated,
      updated.editor,
      {},
      {
        affectedPaths: ['/layouts/hud/label', '/archetypes/template/label', '/scripts/hooks/label'],
      },
    );
    for (const path of owners)
      expect(await fs.readText(`/project/${path}`)).toContain('# author comment');
    for (const path of [
      'records/layouts/hud/layout.rml',
      'records/layouts/hud/layout.rcss',
      'records/layouts/hud/layout.lua',
      'scripts/hooks.lua',
    ]) {
      expect(await fs.readText(`/project/${path}`)).toBe(files[path]);
    }
    const reopened = await workspace.open('/project');
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok) {
      expect(reopened.snapshot.project.layouts.hud!.label).toBe('HUD Updated');
      expect(
        reopened.snapshot.project.archetypes.template!.data.overrides['/data/displayName'],
      ).toBe('yes');
      expect(reopened.snapshot.project.scripts.hooks!.data.source).toEqual({
        kind: 'project-file',
        path: 'scripts/hooks.lua',
      });
      const renamed = cloneAuthoringProject(reopened.snapshot.project);
      renamed.layouts.overlay = { ...renamed.layouts.hud!, id: 'overlay' };
      delete renamed.layouts.hud;
      const moved = await workspace.write(
        '/project',
        reopened.snapshot.workspaceRevision,
        renamed,
        renamed.editor,
        {},
        {
          affectedPaths: ['/layouts/hud', '/layouts/overlay'],
          identityRemap: [{ fromPath: '/layouts/hud', toPath: '/layouts/overlay' }],
        },
      );
      expect(await fs.inspect('/project/records/layouts/hud/layout.yaml')).toBe('missing');
      expect(await fs.readText('/project/records/layouts/overlay/layout.yaml')).toContain(
        '# author comment',
      );
      for (const channel of ['rml', 'rcss', 'lua'])
        expect(await fs.readText(`/project/records/layouts/overlay/layout.${channel}`)).toBe(
          files[`records/layouts/hud/layout.${channel}`],
        );
      const duplicated = cloneAuthoringProject(moved.snapshot.project);
      duplicated.archetypes.copy = { ...duplicated.archetypes.template!, id: 'copy' };
      const copied = await workspace.write(
        '/project',
        moved.workspaceRevision,
        duplicated,
        duplicated.editor,
        {},
        {
          affectedPaths: ['/archetypes/copy'],
        },
      );
      expect(await fs.inspect('/project/records/archetypes/copy.yaml')).toBe('file');
      const withoutCopy = cloneAuthoringProject(copied.snapshot.project);
      delete withoutCopy.archetypes.copy;
      const removed = await workspace.write(
        '/project',
        copied.workspaceRevision,
        withoutCopy,
        withoutCopy.editor,
        {},
        {
          affectedPaths: ['/archetypes/copy'],
        },
      );
      expect(await fs.inspect('/project/records/archetypes/copy.yaml')).toBe('missing');
      const renamedScript = cloneAuthoringProject(removed.snapshot.project);
      renamedScript.scripts.renamed = { ...renamedScript.scripts.hooks!, id: 'renamed' };
      renamedScript.scripts.renamed.data.source = {
        kind: 'project-file',
        path: 'scripts/renamed.lua',
      };
      delete renamedScript.scripts.hooks;
      const scriptMoved = await workspace.write(
        '/project',
        removed.workspaceRevision,
        renamedScript,
        renamedScript.editor,
        {},
        {
          affectedPaths: ['/scripts/hooks', '/scripts/renamed'],
          identityRemap: [{ fromPath: '/scripts/hooks', toPath: '/scripts/renamed' }],
        },
      );
      expect(await fs.inspect('/project/records/scripts/hooks.yaml')).toBe('missing');
      expect(await fs.readText('/project/records/scripts/renamed.yaml')).toContain(
        '# author comment',
      );
      expect(await fs.readText('/project/scripts/renamed.lua')).toBe('return {}\n');
      const added = cloneAuthoringProject(scriptMoved.snapshot.project);
      const another = defaultLayoutData('Another');
      another.rml.sourceText = '<rml><body>New</body></rml>\n';
      added.layouts.second = { id: 'second', label: 'Another', data: another };
      added.scripts.fresh = {
        id: 'fresh',
        label: 'Fresh',
        data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return 42\n' } },
      };
      const created = await workspace.write(
        '/project',
        scriptMoved.workspaceRevision,
        added,
        added.editor,
        {},
        { affectedPaths: ['/layouts/second', '/scripts/fresh'] },
      );
      expect(await fs.inspect('/project/records/layouts/second/layout.yaml')).toBe('file');
      expect(await fs.inspect('/project/records/scripts/fresh.yaml')).toBe('file');
      expect(await fs.readText('/project/records/layouts/second/layout.rml')).toBe(
        another.rml.sourceText,
      );
      expect(await fs.readText('/project/scripts/fresh.lua')).toBe('return 42\n');
      const last = cloneAuthoringProject(created.snapshot.project);
      delete last.layouts.second;
      delete last.scripts.fresh;
      await workspace.write(
        '/project',
        created.workspaceRevision,
        last,
        last.editor,
        {},
        {
          affectedPaths: ['/layouts/second', '/scripts/fresh'],
        },
      );
      expect(await fs.inspect('/project/records/layouts/second/layout.yaml')).toBe('missing');
      expect(await fs.inspect('/project/records/layouts/second/layout.rml')).toBe('missing');
      expect(await fs.inspect('/project/records/scripts/fresh.yaml')).toBe('missing');
      expect(await fs.inspect('/project/scripts/fresh.lua')).toBe('missing');
    }
  });

  it('preserves a Layout Lua none selector across scoped and full YAML saves', async () => {
    const project = createAuthoringProject({ id: 'layout-none', name: 'Layout None' });
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: defaultLayoutData('HUD'),
    };
    const metadata = 'records/layouts/hud/layout.yaml';
    const companion = 'records/layouts/hud/layout.lua';
    const files = { ...projectWorkspaceFiles(project, project.editor) };
    files[metadata] = files[metadata]!.replace(
      'lua:\n    sourceMode: file',
      'lua:\n    sourceMode: none',
    );
    expect(files[metadata]).toContain('lua:\n    sourceMode: none');
    delete files[companion];
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(files).map(([file, text]) => [`/project/${file}`, text])),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open('/project');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const projected = projectWorkspaceFiles(
      opened.snapshot.project,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      new Set(opened.snapshot.canonicalSourceFiles),
    );
    expect(projected[metadata]).toContain('lua:\n    sourceMode: none');
    expect(projected[companion]).toBeUndefined();

    const edited = cloneAuthoringProject(opened.snapshot.project);
    edited.layouts.hud!.label = 'HUD edited';
    const scoped = await workspace.write(
      '/project',
      opened.snapshot.workspaceRevision,
      edited,
      opened.editorState,
      opened.snapshot.scriptSourcePaths,
      { affectedPaths: ['/layouts/hud/label'] },
    );
    expect(await fs.readText(`/project/${metadata}`)).toContain('lua:\n    sourceMode: none');
    expect(await fs.inspect(`/project/${companion}`)).toBe('missing');

    const full = cloneAuthoringProject(scoped.snapshot.project);
    full.project.name = 'Layout None Updated';
    await workspace.write(
      '/project',
      scoped.workspaceRevision,
      full,
      scoped.snapshot.project.editor,
    );
    const reopened = await workspace.open('/project');
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.snapshot.project.layouts.hud!.label).toBe('HUD edited');
      expect(reopened.snapshot.project.project.name).toBe('Layout None Updated');
    }
    expect(await fs.readText(`/project/${metadata}`)).toContain('lua:\n    sourceMode: none');
    expect(await fs.inspect(`/project/${companion}`)).toBe('missing');
    if (!reopened.ok) return;

    const renamedProject = cloneAuthoringProject(reopened.snapshot.project);
    renamedProject.layouts.renamed = { ...renamedProject.layouts.hud!, id: 'renamed' };
    delete renamedProject.layouts.hud;
    const renamed = await workspace.write(
      '/project',
      reopened.snapshot.workspaceRevision,
      renamedProject,
      renamedProject.editor,
      {},
      {
        affectedPaths: ['/layouts/hud', '/layouts/renamed'],
        identityRemap: [{ fromPath: '/layouts/hud', toPath: '/layouts/renamed' }],
      },
    );
    expect(await fs.inspect(`/project/${metadata}`)).toBe('missing');
    expect(await fs.inspect(`/project/${companion}`)).toBe('missing');
    expect(await fs.readText('/project/records/layouts/renamed/layout.yaml')).toContain(
      'lua:\n    sourceMode: none',
    );
    expect(await fs.inspect('/project/records/layouts/renamed/layout.lua')).toBe('missing');
    expect((await workspace.open('/project')).ok).toBe(true);
    expect(renamed.snapshot.project.layouts.renamed?.id).toBe('renamed');
  });
});
