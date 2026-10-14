import { describe, expect, it } from 'vite-plus/test';
import { deleteEntity, renameEntity } from '../../cli/semantic-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

const root = '/comments';
const file = 'records/variables/score.yaml';
const original = `# Record intent
id: score
label: Score # label intent
data:
  type: integer
  value: 1 # starting score
  nullable: false # deliberate default
`;

async function fixture() {
  const project = createAuthoringProject({ id: 'comments', name: 'Comments' });
  const files = Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([path, text]) => [
      `${root}/${path}`,
      text,
    ]),
  );
  files[`${root}/${file}`] = original;
  const fs = new InMemoryProjectWorkspaceFileSystem(files);
  const workspace = new ProjectWorkspaceService(fs);
  const opened = await workspace.open(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.diagnostics));
  return { fs, workspace, opened };
}

describe('source-aware workspace mutations', () => {
  it('moves record metadata annotations with graph-aware CLI rename', async () => {
    const { fs, workspace } = await fixture();
    await fs.writeTextAtomic(
      `${root}/editor.yaml`,
      'chapters: {}\ntags: {}\nrecordMetadata:\n  variables:\n    # classification note\n    score:\n      tags: [] # intentional\n      color: null\n',
    );
    const opened = await workspace.open(root);
    if (!opened.ok) throw new Error('Metadata did not open');
    const result = await renameEntity(workspace, opened.snapshot, 'variables', 'score', 'points', {
      dryRun: false,
      allowPossibleSourceReferences: false,
    });
    expect(result.ok).toBe(true);
    const text = await fs.readText(`${root}/editor.yaml`);
    expect(text).toContain('# classification note');
    expect(text).toContain('tags: [] # intentional');
    expect(text).toContain('points:');
    expect(text).not.toContain('score:');
    expect(result.fields?.commentImpacts).toEqual([]);
  });

  it('moves Layout companion comments with their record identity and back', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    const data = defaultLayoutData('HUD', 'document');
    data.rml.sourceText = '<rml><!-- author note --><body/></rml>';
    data.rcss.sourceText = '/* style note */\nbody { color: white; }';
    data.lua = { sourceMode: 'inline', sourceText: '-- controller note\nreturn {}' };
    next.layouts.hud = { id: 'hud', label: 'HUD', data };
    const created = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/layouts/hud'] },
    );
    const renamed = cloneAuthoringProject(created.snapshot.project);
    renamed.layouts.overlay = { ...renamed.layouts.hud!, id: 'overlay' };
    delete renamed.layouts.hud;
    const written = await workspace.write(
      root,
      created.workspaceRevision,
      renamed,
      renamed.editor,
      {},
      {
        affectedPaths: ['/layouts/hud', '/layouts/overlay'],
        identityRemap: [{ fromPath: '/layouts/hud', toPath: '/layouts/overlay' }],
      },
    );
    expect(await fs.readText(`${root}/records/layouts/overlay/layout.rml`)).toBe(
      data.rml.sourceText,
    );
    expect(await fs.readText(`${root}/records/layouts/overlay/layout.rcss`)).toBe(
      data.rcss.sourceText,
    );
    expect(await fs.readText(`${root}/records/layouts/overlay/layout.lua`)).toBe(
      data.lua.sourceText,
    );
    await workspace.write(
      root,
      written.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/layouts/hud', '/layouts/overlay'],
        identityRemap: [{ fromPath: '/layouts/overlay', toPath: '/layouts/hud' }],
      },
    );
    expect(await fs.readText(`${root}/records/layouts/hud/layout.rml`)).toBe(data.rml.sourceText);
  });
  it('keeps ID-keyed item annotations through insertion/reorder, deletion and Undo without losing newer notes', async () => {
    const project = createAuthoringProject({ id: 'comments', name: 'Comments' });
    const data = defaultTestData('Test');
    data.steps.push({ ...structuredClone(data.steps[0]!), id: 'second', label: 'Second' });
    project.tests.example = { id: 'example', label: 'Example', data };
    const path = 'records/tests/example.yaml';
    const sources = projectWorkspaceFiles(project, project.editor, {}, new Set([path]));
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries(sources).map(([file, text]) => [
          `${root}/${file}`,
          file === path
            ? text
                .replace('id: second', 'id: second # second item')
                .replace('    - id: start', '    # first item\n    - id: start')
            : text,
        ]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    if (!opened.ok) throw new Error('Test did not open');
    const next = cloneAuthoringProject(opened.snapshot.project);
    const steps = next.tests.example!.data.steps;
    steps.reverse();
    steps.splice(1, 0, { ...structuredClone(steps[0]!), id: 'inserted', label: 'Inserted' });
    const reordered = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/tests/example/data/steps'] },
    );
    expect(reordered.commentImpacts).toEqual([]);
    const reorderedSource = await fs.readText(`${root}/${path}`);
    expect(reorderedSource).toMatch(/# first item\n\s*- id: start/u);
    expect(await fs.readText(`${root}/${path}`)).toContain('id: second # second item');
    const removed = cloneAuthoringProject(next);
    removed.tests.example!.data.steps.shift();
    const deletion = await workspace.write(
      root,
      reordered.workspaceRevision,
      removed,
      removed.editor,
      {},
      { affectedPaths: ['/tests/example/data/steps'] },
    );
    expect(deletion.commentImpacts).toEqual([
      expect.objectContaining({ comment: ' second item', kind: 'deleted' }),
    ]);
    const live = await fs.readText(`${root}/${path}`);
    await fs.writeTextAtomic(
      `${root}/${path}`,
      live.replace('id: inserted', 'id: inserted # agent added'),
    );
    const refreshed = await workspace.open(root);
    if (!refreshed.ok) throw new Error('Edited Test did not open');
    await workspace.write(
      root,
      refreshed.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/tests/example/data/steps'],
        sourceRestorations: deletion.deletedSourceTexts,
      },
    );
    const restored = await fs.readText(`${root}/${path}`);
    expect(restored).toContain('id: second # second item');
    expect(restored).toContain('id: inserted # agent added');
  });
  it('reports explicit CLI deletion comments in dry-run and result, then restores source on Undo', async () => {
    const { fs, workspace, opened } = await fixture();
    const options = { dryRun: true, force: false, allowPossibleSourceReferences: false };
    const preview = await deleteEntity(workspace, opened.snapshot, 'variables', 'score', options);
    expect(preview.ok).toBe(true);
    expect(preview.fields?.commentImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file, comment: ' starting score', kind: 'deleted' }),
        expect.objectContaining({ file, comment: ' Record intent', kind: 'deleted' }),
      ]),
    );
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
    const next = cloneAuthoringProject(opened.snapshot.project);
    delete next.variables.score;
    const deletion = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/variables/score'] },
    );
    expect(deletion.commentImpacts).toEqual(preview.fields?.commentImpacts);
    await workspace.write(
      root,
      deletion.workspaceRevision,
      opened.snapshot.project,
      opened.snapshot.project.editor,
      {},
      {
        affectedPaths: ['/variables/score'],
        sourceRestorations: deletion.deletedSourceTexts,
      },
    );
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
    const current = await workspace.open(root);
    if (!current.ok) throw new Error('Restored source did not open');
    const result = await deleteEntity(workspace, current.snapshot, 'variables', 'score', {
      ...options,
      dryRun: false,
    });
    expect(result.fields?.commentImpacts).toEqual(preview.fields?.commentImpacts);
  });

  it('duplicates semantic data without copying annotations', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.copy = { ...next.variables.score!, id: 'copy' };
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/variables/copy'] },
    );
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
    expect(await fs.readText(`${root}/records/variables/copy.yaml`)).not.toContain('#');
  });

  it('exposes changed field comments but excludes untouched annotations and the document header', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.score!.data.value = 2;
    const preview = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/variables/score'],
        preflightSnapshot: opened.snapshot,
        dryRun: true,
      },
    );
    expect(preview.commentImpacts).toEqual([
      { file, path: '/data/value', comment: ' starting score', kind: 'changed' },
    ]);
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
  });

  it('rejects stale and malformed external source and preserves a reconciled comment-only edit', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.score!.data.value = 2;
    for (const external of [original + '# agent note\n', 'id: [unfinished']) {
      await fs.writeTextAtomic(`${root}/${file}`, external);
      await expect(
        workspace.write(
          root,
          opened.snapshot.workspaceRevision,
          next,
          next.editor,
          {},
          {
            preflightSnapshot: opened.snapshot,
            affectedPaths: ['/variables/score/data/value'],
            refreshAfterCommit: false,
          },
        ),
      ).rejects.toThrow('changed outside the editor');
      expect(await fs.readText(`${root}/${file}`)).toBe(external);
    }
    await fs.writeTextAtomic(`${root}/${file}`, original + '# agent note\n');
    const refreshed = await workspace.open(root);
    if (!refreshed.ok) throw new Error('Comment edit did not open');
    await workspace.write(
      root,
      refreshed.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/variables/score/data/value'] },
    );
    expect(await fs.readText(`${root}/${file}`)).toContain('# agent note');
    expect(await fs.readText(`${root}/${file}`)).toContain('value: 2 # starting score');
  });

  it('adopts the exact moved source into the resident cache rather than a fresh semantic serialization', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.points = { ...next.variables.score!, id: 'points' };
    delete next.variables.score;
    const written = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/variables/score', '/variables/points'],
        identityRemap: [{ fromPath: '/variables/score', toPath: '/variables/points' }],
        preflightSnapshot: opened.snapshot,
        refreshAfterCommit: false,
      },
    );
    const adopted = workspace.advanceCommittedSnapshot(opened, written.snapshot, [
      file,
      'records/variables/points.yaml',
    ]);
    if (!adopted?.ok) throw new Error('Committed generation was not admitted');
    const contribution = adopted.sourceContributions['records/variables/points.yaml'];
    expect(contribution?.kind === 'json' && contribution.sourceText).toBe(
      await fs.readText(`${root}/records/variables/points.yaml`),
    );
  });
  it('moves annotated source on explicit rename, including the inverse rename', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.points = { ...next.variables.score!, id: 'points' };
    delete next.variables.score;
    const renamed = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/variables/score', '/variables/points'],
        identityRemap: [{ fromPath: '/variables/score', toPath: '/variables/points' }],
      },
    );
    expect(await fs.readText(`${root}/records/variables/points.yaml`)).toBe(
      original.replace('id: score', 'id: points'),
    );
    await workspace.write(
      root,
      renamed.workspaceRevision,
      opened.snapshot.project,
      opened.snapshot.project.editor,
      {},
      {
        affectedPaths: ['/variables/score', '/variables/points'],
        identityRemap: [{ fromPath: '/variables/points', toPath: '/variables/score' }],
      },
    );
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
  });

  it('does not classify an attached ID annotation as a destructive change on a safe rename', async () => {
    const { fs, workspace } = await fixture();
    await fs.writeTextAtomic(
      `${root}/${file}`,
      original.replace('id: score', 'id: score # identity'),
    );
    const opened = await workspace.open(root);
    if (!opened.ok) throw new Error('Commented record did not open');
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.points = { ...next.variables.score!, id: 'points' };
    delete next.variables.score;
    const renamed = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: ['/variables/score', '/variables/points'],
        identityRemap: [{ fromPath: '/variables/score', toPath: '/variables/points' }],
      },
    );
    expect(renamed.commentImpacts).toEqual([]);
    expect(await fs.readText(`${root}/records/variables/points.yaml`)).toContain(
      'id: points # identity',
    );
  });

  it('keeps an existing JSON owner in JSON during an identity rename in a staged mixed family', async () => {
    const { fs, workspace, opened } = await fixture();
    const seeded = cloneAuthoringProject(opened.snapshot.project);
    seeded.variables.legacy = { ...seeded.variables.score!, id: 'legacy', label: 'Legacy' };
    await fs.writeTextAtomic(
      `${root}/records/variables/legacy.json`,
      `${JSON.stringify(seeded.variables.legacy, null, 2)}\n`,
    );
    const mixed = await workspace.open(root);
    if (!mixed.ok) throw new Error('Mixed staged collection did not open');
    const renamed = cloneAuthoringProject(mixed.snapshot.project);
    renamed.variables.modern = { ...renamed.variables.legacy!, id: 'modern' };
    delete renamed.variables.legacy;
    await workspace.write(
      root,
      mixed.snapshot.workspaceRevision,
      renamed,
      renamed.editor,
      {},
      {
        affectedPaths: ['/variables/legacy', '/variables/modern'],
        identityRemap: [{ fromPath: '/variables/legacy', toPath: '/variables/modern' }],
      },
    );
    expect(await fs.readText(`${root}/records/variables/modern.json`)).toContain('"id": "modern"');
    await expect(fs.readText(`${root}/records/variables/modern.yaml`)).rejects.toThrow();
    expect(await fs.readText(`${root}/${file}`)).toBe(original);
  });
  it('keeps scalar annotations and explicit untouched defaults during a broad record replacement', async () => {
    const { fs, workspace, opened } = await fixture();
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.variables.score!.data.value = 2;
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      { affectedPaths: ['/variables/score'] },
    );
    expect(await fs.readText(`${root}/${file}`)).toBe(original.replace('value: 1', 'value: 2'));
    const reopened = await workspace.open(root);
    expect(reopened.ok && reopened.snapshot.project.variables.score!.data.value).toBe(2);
  });
});
