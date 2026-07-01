import { describe, expect, it } from 'vitest';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { createAuthoringProject, isAuthoringProject, isValidEntityId, parseAuthoringProject } from '../../shared/project-schema/authoring-project';
import { EDITOR_PROJECT_STATE_SCHEMA, stripEditorProjectState } from '../../shared/project-schema/editor-project-state';

describe('authoring project schema', () => {
  it('creates a complete empty authoring project', () => {
    const project = createAuthoringProject({ id: 'demo-project', name: 'Demo Project' });

    expect(project.schema).toBe('noveltea.authoring.project');
    expect(project.schemaVersion).toBe(1);
    expect(project.project.id).toBe('demo-project');
    expect(project.project.name).toBe('Demo Project');
    expect(project.entrypoint).toBeNull();
    expect(project.editor.schema).toBe(EDITOR_PROJECT_STATE_SCHEMA);
    for (const key of authoringCollectionKeys) {
      expect(project[key]).toEqual({});
    }
  });

  it('detects authoring projects and rejects non-authoring documents', () => {
    expect(isAuthoringProject(createAuthoringProject())).toBe(true);
    expect(isAuthoringProject({ room: {}, object: {} })).toBe(false);
  });

  it('validates entity id syntax', () => {
    expect(isValidEntityId('valid-id-2')).toBe(true);
    expect(isValidEntityId('2-bad')).toBe(false);
    expect(isValidEntityId('bad_id')).toBe(false);
    expect(isValidEntityId('bad/id')).toBe(false);
  });

  it('normalizes missing editor state and strips editor state for runtime export', () => {
    const project = createAuthoringProject();
    const withoutEditor = { ...project };
    delete (withoutEditor as Partial<typeof project>).editor;
    const parsed = parseAuthoringProject(withoutEditor);
    expect(parsed.editor.schema).toBe(EDITOR_PROJECT_STATE_SCHEMA);

    const stripped = stripEditorProjectState(project);
    expect('editor' in (stripped as Record<string, unknown>)).toBe(false);
    expect('editor' in project).toBe(true);
  });

  it('uses layouts as the authoring layout collection', () => {
    const project = createAuthoringProject();
    expect(project.layouts).toEqual({});
    expect('uiLayouts' in project).toBe(false);
  });
});
