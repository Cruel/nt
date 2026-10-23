import { describe, expect, it } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../../shared/project-workspace/project-workspace-contracts';
import { readNativeEditorLocalState } from '../../main/services/native-editor-local-state';

describe('native Project Open local-only editor recovery', () => {
  it('uses tracked native editor.yaml organization even when a local recovery file exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-local-'));
    try {
      const project = createAuthoringProject({ id: 'native-local', name: 'Native Local' });
      project.editor.chapters.records.chapter = { id: 'chapter', label: 'Native chapter' };
      const {
        chapters: _chapters,
        tags: _tags,
        recordMetadata: _metadata,
        ...local
      } = emptyEditorProjectState();
      const bytes = JSON.stringify({
        ...local,
        schema: EDITOR_LOCAL_STATE_SCHEMA,
        previewLocale: 'ja',
        recovery: { sequence: 7, saveUnitsById: {} },
      });
      await mkdir(path.join(root, '.noveltea', 'editor'), { recursive: true });
      await writeFile(path.join(root, '.noveltea', 'editor', 'state.json'), bytes);
      const state = await readNativeEditorLocalState(root, project);
      expect(state.chapters).toEqual(project.editor.chapters);
      expect(state.recordMetadata).toEqual(project.editor.recordMetadata);
      expect(state.previewLocale).toBe('ja');
      expect(state.recovery.sequence).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults only missing state; malformed recovery is not discarded or rewritten', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-invalid-'));
    try {
      const project = createAuthoringProject({ id: 'native-local', name: 'Native Local' });
      expect(await readNativeEditorLocalState(root, project)).toEqual(project.editor);
      await mkdir(path.join(root, '.noveltea', 'editor'), { recursive: true });
      const filename = path.join(root, '.noveltea', 'editor', 'state.json');
      const corrupt = '{"schema":"unknown","recovery":{"sequence":11}}';
      await writeFile(filename, corrupt);
      await expect(readNativeEditorLocalState(root, project)).rejects.toThrow(
        /cannot be recovered/,
      );
      expect(await readFile(filename, 'utf8')).toBe(corrupt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
