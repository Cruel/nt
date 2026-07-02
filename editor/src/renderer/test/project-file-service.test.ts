import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveProject, saveProjectAs } from '../../main/services/project-file-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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
    tags: [],
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
  it('saves project JSON atomically', async () => {
    const root = tempRoot();
    const projectFilePath = path.join(root, 'game.json');
    const result = await saveProject(projectWithImage(), projectFilePath);
    expect(result.success).toBe(true);
    expect(fs.existsSync(projectFilePath)).toBe(true);
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

    const result = await saveProjectAs(owner, projectWithImage(), oldProjectFilePath, oldProjectFilePath);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(newRoot, 'assets', 'images', 'logo.png'), 'utf8')).toBe('image');
    expect(result.diagnostics ?? []).toEqual([]);
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

    const result = await saveProjectAs(owner, projectWithImage(), oldProjectFilePath, oldProjectFilePath);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Save canceled.');
    expect(fs.existsSync(newProjectFilePath)).toBe(false);
  });
});

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(async (_owner: never) => ({ canceled: false, filePath: (_owner as { __mockSavePath: string }).__mockSavePath })),
    showMessageBox: vi.fn(async (_owner: never) => ({ response: (_owner as { __mockMessageResponse?: number }).__mockMessageResponse ?? 1 })),
  },
}));
