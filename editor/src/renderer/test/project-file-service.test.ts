import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
const dialogs = vi.hoisted(() => ({ destination: '' }));
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dialogs.destination] }),
    showMessageBox: async () => ({ response: 1 }),
  },
}));
import {
  createProject,
  projectContentFingerprint,
  saveProjectContent,
  saveProjectEditorMetadata,
  saveProjectCopyAs,
} from '../../main/services/project-file-service';
import { ProjectWorkspaceService } from '../../shared/project-workspace';
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-save-project-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project-file-service workspace-v1', () => {
  it('creates the canonical segmented project root and ignored local namespace', async () => {
    const root = tempRoot();
    const projectDirectory = path.join(root, 'my-project');
    const result = await createProject({ projectName: 'My Project', projectDirectory });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'properties.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'localization.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'editor.json'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDirectory, '.gitignore'), 'utf8')).toContain(
      '/.noveltea/',
    );
    expect(fs.existsSync(path.join(projectDirectory, 'records'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(projectDirectory, 'assets'))).toBe(true);
  });

  it('does not discover retired game.json projects', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'game.json'), '{}');
    const opened = await new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem()).open(
      root,
    );
    expect(opened.ok).toBe(false);
  });

  it('writes project content as segmented files and only changes affected files', async () => {
    const root = tempRoot();
    await createProject({ projectName: 'Save', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const beforeEditor = fs.readFileSync(path.join(root, 'editor.json'), 'utf8');
    const candidate = {
      ...opened.snapshot.project,
      project: { ...opened.snapshot.project.project, name: 'After' },
    };
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      candidate,
      opened.editorState,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).project.name).toBe(
      'After',
    );
    expect(fs.readFileSync(path.join(root, 'editor.json'), 'utf8')).toBe(beforeEditor);
  });

  it('persists only local editor state outside tracked editor.json', async () => {
    const root = tempRoot();
    await createProject({ projectName: 'Metadata', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const state = {
      ...emptyEditorProjectState(opened.contentFingerprint),
      bottomPanel: { visible: false, activePanelId: 'problems' as const, sizePercent: 24 },
    };
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      state,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'editor.json'), 'utf8'))).toEqual({
      chapters: { assignments: {}, records: {} },
      recordMetadata: {},
      tags: { records: {} },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.noveltea/editor/state.json'), 'utf8')),
    ).toMatchObject({
      schema: 'noveltea.editor.local-state',
      schemaVersion: 1,
      workspaceRevision: result.workspaceRevision,
      bottomPanel: { visible: false },
    });
  });

  it('rejects saves after the coarse workspace baseline changes', async () => {
    const root = tempRoot();
    await createProject({ projectName: 'Conflict', projectDirectory: root });
    const service = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    fs.writeFileSync(
      path.join(root, 'project.json'),
      fs.readFileSync(path.join(root, 'project.json'), 'utf8').replace('Conflict', 'External'),
    );
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      emptyEditorProjectState(projectContentFingerprint(opened.snapshot.project)),
    );
    expect(result.success).toBe(false);
  });

  it('preserves a loaded Script Module source owner through production content save', async () => {
    const root = tempRoot();
    await createProject({ projectName: 'Script source', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const initial = await workspace.open(root);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const project = structuredClone(initial.snapshot.project);
    project.scripts.before = {
      id: 'before',
      label: 'Before',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return 1\n' } },
    };
    await workspace.write(root, initial.snapshot.workspaceRevision, project, initial.editorState, {
      before: 'scripts/custom/entry.lua',
    });
    const loaded = await workspace.open(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const renamed = structuredClone(loaded.snapshot.project);
    renamed.scripts.after = { ...renamed.scripts.before!, id: 'after', label: 'After' };
    delete renamed.scripts.before;
    const result = await saveProjectContent(
      path.join(root, 'project.json'),
      loaded.snapshot.workspaceRevision,
      renamed,
      loaded.editorState,
      { after: 'scripts/custom/entry.lua' },
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'records/scripts/after.json'), 'utf8')).toContain(
      'scripts/custom/entry.lua',
    );
    expect(fs.readFileSync(path.join(root, 'scripts/custom/entry.lua'), 'utf8')).toBe('return 1\n');
  });

  it('rejects a local-state symlink escape instead of writing through it', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    await createProject({ projectName: 'Contained', projectDirectory: root });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    fs.mkdirSync(path.join(root, '.noveltea', 'editor'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.noveltea', 'editor', 'escape'));
    const state = emptyEditorProjectState(opened.contentFingerprint);
    const result = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      opened.snapshot.workspaceRevision,
      state,
    );
    expect(result.success).toBe(true);
    fs.rmSync(path.join(root, '.noveltea', 'editor'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, '.noveltea', 'editor'));
    const rejected = await saveProjectEditorMetadata(
      path.join(root, 'project.json'),
      result.workspaceRevision!,
      state,
    );
    expect(rejected.success).toBe(false);
    expect(fs.existsSync(path.join(outside, 'state.json'))).toBe(false);
  });

  it.each([
    ['projected records', 'records'],
    ['local state', '.noveltea'],
    ['copied assets', 'assets'],
    ['copied workflows', 'workflows'],
  ])('rejects Save As %s symlink escapes', async (_label, escapedDirectory) => {
    const source = tempRoot();
    const destination = tempRoot();
    const outside = tempRoot();
    await createProject({ projectName: 'Source', projectDirectory: source });
    const workspace = new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
    const opened = await workspace.open(source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const project = structuredClone(opened.snapshot.project);
    project.scripts.script = {
      id: 'script',
      label: 'Script',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return 1\n' } },
    };
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/image.png' },
        aliases: [],
        imageMetadata: null,
      },
    };
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(source, 'assets/image.png'), 'image');
    await workspace.write(source, opened.snapshot.workspaceRevision, project, opened.editorState);
    fs.mkdirSync(path.join(source, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(source, 'workflows', 'sample.json'), '{}');
    fs.symlinkSync(outside, path.join(destination, escapedDirectory));
    dialogs.destination = destination;
    const result = await saveProjectCopyAs(
      {} as never,
      project,
      null,
      path.join(source, 'project.json'),
      [],
    );
    expect(result.success).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
