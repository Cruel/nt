import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createProject,
  projectContentFingerprint,
  saveProject,
  saveProjectAs,
  saveProjectContent,
  saveProjectCopyAs,
  saveProjectEditorMetadata,
} from '../../main/services/project-file-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  emptyEditorProjectState,
  stripEditorProjectState,
} from '../../shared/project-schema/editor-project-state';

const roots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-save-project-'));
  roots.push(root);
  return root;
}

function projectWithImage() {
  const project = createAuthoringProject();
  project.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
    },
  };
  return project;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project-file-service', () => {
  it('creates a new project in an empty directory', async () => {
    const root = tempRoot();
    const projectDirectory = path.join(root, 'my-project');

    const result = await createProject({ projectName: 'My Project', projectDirectory });

    expect(result.success).toBe(true);
    expect(result.projectFilePath).toBe(path.join(projectDirectory, 'project.json'));
    const project = JSON.parse(
      fs.readFileSync(path.join(projectDirectory, 'project.json'), 'utf8'),
    );
    expect(project.project).toMatchObject({ id: 'my-project', name: 'My Project' });
  });

  it('rejects creating a project in a path with spaces', async () => {
    const root = tempRoot();
    const projectDirectory = path.join(root, 'my project');

    const result = await createProject({ projectName: 'My Project', projectDirectory });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project paths must not contain spaces.');
    expect(fs.existsSync(path.join(projectDirectory, 'project.json'))).toBe(false);
  });

  it('rejects creating a project in a non-empty directory', async () => {
    const root = tempRoot();
    const projectDirectory = path.join(root, 'my-project');
    fs.mkdirSync(projectDirectory);
    fs.writeFileSync(path.join(projectDirectory, 'notes.txt'), 'existing');

    const result = await createProject({ projectName: 'My Project', projectDirectory });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project directory already exists and is not empty.');
    expect(fs.existsSync(path.join(projectDirectory, 'project.json'))).toBe(false);
  });

  it('saves project JSON atomically', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'game.json');
    const result = await saveProject(projectWithImage(), projectFilePath);
    expect(result.success).toBe(true);
    expect(fs.existsSync(projectFilePath)).toBe(true);
  });

  it('blocks saving invalid authoring projects', async () => {
    const root = tempRoot();
    const project = projectWithImage();
    project.project.name = '';

    const result = await saveProject(project, path.join(root, 'game.json'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project title is required.');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/project/name' }),
    );
    expect(fs.existsSync(path.join(root, 'game.json'))).toBe(false);
  });

  it('fingerprints canonical content while excluding editor metadata', () => {
    const project = createAuthoringProject({ id: 'fingerprint', name: 'Fingerprint' });
    const first = projectContentFingerprint(project);
    const reordered = Object.fromEntries(Object.entries(project).reverse());
    expect(projectContentFingerprint(reordered)).toBe(first);
    expect(
      projectContentFingerprint({
        ...project,
        editor: {
          ...project.editor,
          bottomPanel: { ...project.editor.bottomPanel, visible: false },
        },
      }),
    ).toBe(first);
  });

  it('writes only editor metadata when the content fingerprint still matches', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'project.json');
    const project = createAuthoringProject({ id: 'metadata', name: 'Metadata' });
    fs.writeFileSync(projectFilePath, `${JSON.stringify(project, null, 2)}\n`);
    const fingerprint = projectContentFingerprint(project);
    const editorState = {
      ...emptyEditorProjectState(fingerprint),
      bottomPanel: { visible: false, activePanelId: 'problems' as const, sizePercent: 24 },
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:settings': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'Recovered' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: ['atomic:1'],
          },
        },
      },
    };

    const result = await saveProjectEditorMetadata(projectFilePath, fingerprint, editorState);
    const persisted = JSON.parse(fs.readFileSync(projectFilePath, 'utf8'));

    expect(result.success).toBe(true);
    expect(stripEditorProjectState(persisted)).toEqual(stripEditorProjectState(project));
    expect(persisted.editor).toEqual(editorState);
  });

  it('leaves the file untouched when editor metadata detects external content changes', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'project.json');
    const project = createAuthoringProject({ id: 'conflict', name: 'Before' });
    const expectedFingerprint = projectContentFingerprint(project);
    const externallyChanged = { ...project, project: { ...project.project, name: 'External' } };
    const externalText = `${JSON.stringify(externallyChanged, null, 2)}\n`;
    fs.writeFileSync(projectFilePath, externalText);

    const result = await saveProjectEditorMetadata(
      projectFilePath,
      expectedFingerprint,
      emptyEditorProjectState(expectedFingerprint),
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.metadata.content-conflict', severity: 'error' }),
    );
    expect(fs.readFileSync(projectFilePath, 'utf8')).toBe(externalText);
  });

  it('writes a scoped content candidate with rebased editor recovery in one atomic update', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'project.json');
    const saved = createAuthoringProject({ id: 'scoped-save', name: 'Before' });
    const savedText = `${JSON.stringify(saved, null, 2)}\n`;
    fs.writeFileSync(projectFilePath, savedText);
    const expectedFingerprint = projectContentFingerprint(saved);
    const candidate = {
      ...saved,
      project: { ...saved.project, name: 'After' },
      settings: { ...saved.settings, app: { ...saved.settings.app, version: '' } },
    };
    const editorState = {
      ...emptyEditorProjectState(expectedFingerprint),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:blocked': {
            sequence: 1,
            patches: [
              {
                op: 'add' as const,
                path: '/rooms/blocked',
                value: { id: 'blocked', label: 'Blocked', data: {} },
              },
            ],
            affectedPaths: ['/rooms/blocked'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const result = await saveProjectContent(
      projectFilePath,
      expectedFingerprint,
      candidate,
      editorState,
    );
    const persisted = JSON.parse(fs.readFileSync(projectFilePath, 'utf8'));

    expect(result.success).toBe(true);
    expect(persisted.project.name).toBe('After');
    expect(persisted.settings.app.version).toBe('');
    expect(persisted.editor.recovery.saveUnitsById).toHaveProperty('record:rooms:blocked');
    expect(persisted.editor.contentFingerprint).toBe(
      projectContentFingerprint(stripEditorProjectState(candidate)),
    );
  });

  it('leaves the file untouched when scoped content save detects external changes', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'project.json');
    const saved = createAuthoringProject({ id: 'content-conflict', name: 'Before' });
    const expectedFingerprint = projectContentFingerprint(saved);
    const external = { ...saved, project: { ...saved.project, name: 'External' } };
    const externalText = `${JSON.stringify(external, null, 2)}\n`;
    fs.writeFileSync(projectFilePath, externalText);

    const result = await saveProjectContent(
      projectFilePath,
      expectedFingerprint,
      { ...saved, project: { ...saved.project, name: 'Candidate' } },
      emptyEditorProjectState(expectedFingerprint),
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.content-save.content-conflict' }),
    );
    expect(fs.readFileSync(projectFilePath, 'utf8')).toBe(externalText);
  });

  it('copies project-owned asset files when Save As changes project root', async () => {
    const oldRoot = tempRoot();
    const newRoot = tempRoot();
    const oldProjectFilePath = path.join(oldRoot, 'game.json');
    const newProjectFilePath = path.join(newRoot, 'game.json');
    fs.mkdirSync(path.join(oldRoot, 'assets', 'images'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'assets', 'images', 'logo.png'), 'image');
    fs.writeFileSync(oldProjectFilePath, '{}');
    const owner = {
      __mockSavePath: newProjectFilePath,
      __mockMessageResponse: 1,
    } as never;

    const result = await saveProjectAs(
      owner,
      projectWithImage(),
      oldProjectFilePath,
      oldProjectFilePath,
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(newRoot, 'assets', 'images', 'logo.png'), 'utf8')).toBe(
      'image',
    );
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('Save As copy writes the saved baseline and complete recovery without validating dirty work', async () => {
    const oldRoot = tempRoot();
    const newRoot = tempRoot();
    const oldProjectFilePath = path.join(oldRoot, 'game.json');
    const newProjectFilePath = path.join(newRoot, 'game.json');
    const baseline = createAuthoringProject({ id: 'copy', name: 'Copy' });
    baseline.project.name = '';
    const fingerprint = projectContentFingerprint(baseline);
    const editorState = {
      ...emptyEditorProjectState(fingerprint),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:settings': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'Recovered' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };
    const copy = { ...baseline, editor: editorState };
    fs.writeFileSync(oldProjectFilePath, `${JSON.stringify(copy, null, 2)}\n`);
    const owner = {
      __mockSavePath: newProjectFilePath,
      __mockMessageResponse: 1,
    } as never;

    const result = await saveProjectCopyAs(owner, copy, oldProjectFilePath, oldProjectFilePath);
    const persisted = JSON.parse(fs.readFileSync(newProjectFilePath, 'utf8'));

    expect(result.success).toBe(true);
    expect(persisted.project.name).toBe('');
    expect(persisted.editor.recovery.saveUnitsById).toHaveProperty('project:settings');
    expect(persisted.editor.contentFingerprint).toBe(fingerprint);
  });

  it('Save As copy includes asset files referenced only by dirty recovery', async () => {
    const oldRoot = tempRoot();
    const newRoot = tempRoot();
    const oldProjectFilePath = path.join(oldRoot, 'game.json');
    const newProjectFilePath = path.join(newRoot, 'game.json');
    const dirtyAssetPath = 'assets/images/dirty-cover.png';
    fs.mkdirSync(path.join(oldRoot, 'assets', 'images'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, dirtyAssetPath), 'dirty-image');
    fs.writeFileSync(oldProjectFilePath, '{}');
    const project = createAuthoringProject({ id: 'copy-assets', name: 'Copy Assets' });
    const owner = {
      __mockSavePath: newProjectFilePath,
      __mockMessageResponse: 1,
    } as never;

    const result = await saveProjectCopyAs(owner, project, oldProjectFilePath, oldProjectFilePath, [
      dirtyAssetPath,
    ]);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(newRoot, dirtyAssetPath), 'utf8')).toBe('dirty-image');
  });

  it('cancels Save As when the destination directory is non-empty and the user rejects it', async () => {
    const oldRoot = tempRoot();
    const newRoot = tempRoot();
    const oldProjectFilePath = path.join(oldRoot, 'game.json');
    const newProjectFilePath = path.join(newRoot, 'game.json');
    fs.writeFileSync(path.join(newRoot, 'unrelated.txt'), 'do not mix');
    const owner = {
      __mockSavePath: newProjectFilePath,
      __mockMessageResponse: 0,
    } as never;

    const result = await saveProjectAs(
      owner,
      projectWithImage(),
      oldProjectFilePath,
      oldProjectFilePath,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Save canceled.');
    expect(fs.existsSync(newProjectFilePath)).toBe(false);
  });
});

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(async (_owner: never) => ({
      canceled: false,
      filePath: (_owner as { __mockSavePath: string }).__mockSavePath,
    })),
    showMessageBox: vi.fn(async (_owner: never) => ({
      response: (_owner as { __mockMessageResponse?: number }).__mockMessageResponse ?? 1,
    })),
  },
}));
