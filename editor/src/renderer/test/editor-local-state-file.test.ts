import { describe, expect, it } from 'vite-plus/test';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { projectWorkspaceLocalStateFile } from '../../shared/editor-local-state-file';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../../shared/project-workspace/project-workspace-contracts';

describe('authoring-independent local editor-state JSON writer', () => {
  it('retains the exact old machine.json bytes while omitting all tracked editor.yaml state', () => {
    const state = emptyEditorProjectState();
    state.previewLocale = 'ja';
    state.recovery.sequence = 8;
    state.chapters.records['chapter-1'] = { id: 'chapter-1', label: 'Not local' };
    state.tags.records['tag-1'] = { name: 'Not local', color: '#aaaaaa' };
    const {
      chapters: _chapters,
      tags: _tags,
      recordMetadata: _metadata,
      schema: _schema,
      ...local
    } = state;
    const expected = projectWorkspaceSourceCodec('machine.json').encode({
      schema: EDITOR_LOCAL_STATE_SCHEMA,
      ...local,
    });
    const actual = projectWorkspaceLocalStateFile(state);
    expect(actual).toBe(expected);
    expect(actual).toMatch(/\n$/u);
    expect(actual).not.toContain('Not local');
  });

  it('uses Unicode code-point ordering for nested local state, not locale-sensitive sort', () => {
    const state = emptyEditorProjectState();
    Object.assign(state, {
      extraPreviewState: {
        '🫖': { é: 2, a: 1 },
        z: [1, 2],
        á: { beta: null },
      },
    });
    const {
      chapters: _chapters,
      tags: _tags,
      recordMetadata: _metadata,
      schema: _schema,
      ...local
    } = state;
    expect(projectWorkspaceLocalStateFile(state)).toBe(
      projectWorkspaceSourceCodec('machine.json').encode({
        schema: EDITOR_LOCAL_STATE_SCHEMA,
        ...local,
      }),
    );
  });
});
