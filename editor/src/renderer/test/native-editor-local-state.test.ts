import { describe, expect, it } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../../shared/project-workspace/project-workspace-contracts';
import { readNativeEditorLocalState } from '../../main/services/native-editor-local-state';
import { saveProjectEditorMetadata } from '../../main/services/project-editor-metadata-service';
import { guardNativeEditorProjectAuthority } from '../../shared/project-workspace/legacy-project-authority-guard';

describe('native Project Open local-only editor recovery', () => {
  it('persists local view/recovery state with legacy authority disabled and leaves native dirty work untouched', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-save-local-'));
    const release = guardNativeEditorProjectAuthority();
    try {
      const project = createAuthoringProject({ id: 'native-local', name: 'Native Local' });
      const state = emptyEditorProjectState();
      state.previewLocale = 'ja';
      state.recovery.sequence = 7;
      state.recovery.saveUnitsById['project-settings'] = {
        sequence: 7,
        patches: [],
        affectedPaths: ['/settings/window/width'],
        pendingRawInputByPath: { '/settings/window/width': { value: 'unfinished input' } },
        atomicTransactionGroupIds: [],
      };
      await mkdir(path.join(root, '.noveltea', 'editor'), { recursive: true });
      const nativeDirty = path.join(root, '.noveltea', 'editor', 'native-dirty-state.json');
      const checkpoint = 'native checkpoint is independently owned';
      await writeFile(nativeDirty, checkpoint);
      const saved = await saveProjectEditorMetadata(root, state);
      expect(saved.success, saved.error).toBe(true);
      const recovered = await readNativeEditorLocalState(root, project);
      expect(recovered.previewLocale).toBe('ja');
      expect(recovered.recovery).toEqual(state.recovery);
      expect(await readFile(nativeDirty, 'utf8')).toBe(checkpoint);
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('rejects even contained recovery-directory links rather than persisting state that native Open cannot recover', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-editor-linked-local-'));
    const release = guardNativeEditorProjectAuthority();
    try {
      const target = path.join(root, '.noveltea', 'recovery-store');
      await mkdir(target, { recursive: true });
      const filename = path.join(target, 'state.json');
      await writeFile(filename, 'existing recovery');
      await symlink(target, path.join(root, '.noveltea', 'editor'), 'junction');
      const saved = await saveProjectEditorMetadata(root, emptyEditorProjectState());
      expect(saved.success).toBe(false);
      expect(await readFile(filename, 'utf8')).toBe('existing recovery');
    } finally {
      release();
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
