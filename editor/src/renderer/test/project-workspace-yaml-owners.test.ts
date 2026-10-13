import { describe, expect, it } from 'vite-plus/test';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';

const root = '/project';

function sources() {
  const project = createAuthoringProject({ id: 'yaml-project', name: 'First' });
  project.traits.guard = {
    id: 'guard',
    label: 'Guard',
    ownerKinds: ['room'],
    properties: [],
  };
  const files = projectWorkspaceFiles(project, project.editor);
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      `${root}/${path}`,
      path === 'project.yaml'
        ? text
            .replace('name: First', 'name: First # project comment')
            .replace('interactableInstances: {}', 'entrypoint: null\ninteractableInstances: {}')
        : path === 'traits.yaml'
          ? text.replace('label: Guard', 'label: Guard # trait comment')
          : path === 'editor.yaml'
            ? text.replace('chapters: {}', 'chapters: {} # chapters comment')
            : text,
    ]),
  );
}

describe('YAML manifest, Traits, and collaborator metadata', () => {
  it('projects canonical YAML with strict normalized contracts and reopens selective edits without losing comments', async () => {
    const files = sources();
    const fs = new InMemoryProjectWorkspaceFileSystem(files);
    const workspace = new ProjectWorkspaceService(fs);
    expect(files[`${root}/project.json`]).toBeUndefined();
    expect(files[`${root}/traits.json`]).toBeUndefined();
    expect(files[`${root}/editor.json`]).toBeUndefined();
    const opened = await workspace.open(root);
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    expect(opened.snapshot.project.traits.guard?.id).toBe('guard');
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.project.name = 'Second';
    next.traits.guard!.label = 'Updated';
    next.editor.tags.records.blue = { name: 'Blue', color: '#336699' };
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/project/name', '/traits/guard/label', '/editor/tags/records/blue'],
      },
    );
    expect(await fs.readText(`${root}/project.yaml`)).toContain('name: Second # project comment');
    expect(await fs.readText(`${root}/project.yaml`)).toContain('entrypoint: null');
    expect(await fs.readText(`${root}/project.yaml`)).not.toContain('undefinedInteractionProgram:');
    expect(await fs.readText(`${root}/traits.yaml`)).toContain('label: Updated # trait comment');
    expect(await fs.readText(`${root}/editor.yaml`)).toContain('# chapters comment');
    expect(await fs.readText(`${root}/editor.yaml`)).toContain('blue:');
    const reopened = await workspace.open(root);
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!reopened.ok) return;
    expect(reopened.snapshot.project.project.name).toBe('Second');
    expect(reopened.snapshot.project.traits.guard?.label).toBe('Updated');
    expect(reopened.editorState.tags.records.blue?.name).toBe('Blue');
  });

  it('rejects unsupported YAML, unknown manifest fields, and Trait key/ID mismatches', async () => {
    const originals = sources();
    const mutations: [string, (source: string) => string][] = [
      ['project.yaml', (source) => `# invalid alias\nref: &anchor foo\n${source}`],
      [
        'project.yaml',
        (source) => source.replace('schemaVersion: 1', 'schemaVersion: 1\nextra: nope'),
      ],
      ['traits.yaml', (source) => source.replace('id: guard', 'id: other')],
    ];
    for (const [file, change] of mutations) {
      const fs = new InMemoryProjectWorkspaceFileSystem({
        ...originals,
        [`${root}/${file}`]: change(originals[`${root}/${file}`]!),
      });
      const opened = await new ProjectWorkspaceService(fs).open(root);
      expect(opened.ok, file).toBe(false);
      expect(await fs.readText(`${root}/${file}`)).toBe(change(originals[`${root}/${file}`]!));
    }
  });

  it('quotes ambiguous YAML strings and preserves explicit non-default nulls', () => {
    const codec = projectWorkspaceSourceCodec('editor.yaml');
    const input = {
      chapters: { records: {}, assignments: {} },
      tags: { records: { on: { name: 'yes', color: '#aa', sortKey: null } } },
      recordMetadata: { '001': { guard: { color: null } } },
    };
    const text = codec.encode(input);
    expect(codec.decode(text)).toEqual(input);
    expect(text).toMatch(/name: ["']yes["']/u);
    expect(text).toMatch(/["']001["']:/u);
    expect(text).toContain('sortKey: null');
    expect(text).toContain('color: null');
    expect(() => codec.decode('root: *alias\n')).toThrow();
  });

  it('rejects unkeyed sequence replacement when a descendant contains a comment', () => {
    const codec = projectWorkspaceSourceCodec('project.yaml');
    const original =
      'settings:\n  text:\n    fontStack:\n      - $ref:\n          collection: assets\n          id: first # retain this comment\n';
    const parsed = codec.decode(original) as {
      settings: { text: { fontStack: { $ref: { collection: string; id: string } }[] } };
    };
    parsed.settings.text.fontStack.push({ $ref: { collection: 'assets', id: 'second' } });
    expect(() => codec.encode(parsed, undefined, original)).toThrow(
      'Cannot replace a commented YAML sequence without stable item identities.',
    );
    // Rejection happens before any file update; the input bytes remain authoritative.
    expect(original).toContain('id: first # retain this comment');
  });

  it('leaves YAML bytes unchanged when a transactional fontStack append encounters a nested comment', async () => {
    const files = sources();
    const key = `${root}/project.yaml`;
    const before = files[key]!;
    expect(before).toContain('fontStack: []');
    files[key] = before.replace(
      'fontStack: []',
      'fontStack:\n      - $ref:\n          collection: assets\n          id: original # keep nested comment',
    );
    const fs = new InMemoryProjectWorkspaceFileSystem(files);
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    if (!opened.ok) throw new Error(opened.diagnostics.map((d) => d.message).join('; '));
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.settings.text.fontStack.push({ $ref: { collection: 'assets', id: 'added' } });
    const originalText = await fs.readText(key);
    await expect(
      workspace.write(
        root,
        opened.snapshot.workspaceRevision,
        next,
        next.editor,
        {},
        {
          affectedPaths: ['/settings/text/fontStack'],
        },
      ),
    ).rejects.toThrow('Cannot replace a commented YAML sequence without stable item identities.');
    expect(await fs.readText(key)).toBe(originalText);
  });

  it('preserves nested omitted manifest defaults on an unrelated name edit', async () => {
    const files = sources();
    const key = `${root}/project.yaml`;
    expect(files[key]).toMatch(/showAuthor: false/u);
    files[key] = files[key]!.replace(/^\s*showAuthor: false\n/mu, '');
    const fs = new InMemoryProjectWorkspaceFileSystem(files);
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    if (!opened.ok) throw new Error(opened.diagnostics.map((d) => d.message).join('; '));
    expect(opened.snapshot.project.settings.titleScreen.showAuthor).toBe(false);
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.project.name = 'Only name changed';
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/project/name'],
      },
    );
    const updated = await fs.readText(key);
    expect(updated).toContain('name: Only name changed');
    expect(updated).not.toContain('showAuthor:');
    const reopened = await workspace.open(root);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const explicit = cloneAuthoringProject(reopened.snapshot.project);
    explicit.settings.titleScreen.showAuthor = true;
    await workspace.write(
      root,
      reopened.snapshot.workspaceRevision,
      explicit,
      explicit.editor,
      {},
      {
        affectedPaths: ['/settings/titleScreen/showAuthor'],
      },
    );
    expect(await fs.readText(key)).toContain('showAuthor: true');
  });
});
