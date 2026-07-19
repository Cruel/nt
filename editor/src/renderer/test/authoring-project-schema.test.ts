import { describe, expect, it } from 'vite-plus/test';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import {
  createAuthoringProject,
  isAuthoringProject,
  isValidEntityId,
  parseAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  EDITOR_PROJECT_STATE_SCHEMA,
  stripEditorProjectState,
} from '../../shared/project-schema/editor-project-state';

describe('authoring project V2 schema', () => {
  it('creates a complete empty V2 project root', () => {
    const project = createAuthoringProject({ id: 'demo-project', name: 'Demo Project' });
    expect(project).toMatchObject({
      schema: 'noveltea.authoring.project',
      schemaVersion: 2,
      project: { id: 'demo-project', name: 'Demo Project' },
      startupHook: null,
      entrypoint: null,
      properties: {},
      localization: { defaultLocale: 'en', fallbackLocale: null, catalogs: { en: {} } },
      editor: { schema: EDITOR_PROJECT_STATE_SCHEMA, recordMetadata: {} },
    });
    for (const key of authoringCollectionKeys) expect(project[key]).toEqual({});
    expect('objects' in project).toBe(false);
    expect('actions' in project).toBe(false);
  });

  it('rejects V1, legacy collection names, and unknown root fields', () => {
    const project = createAuthoringProject();
    expect(isAuthoringProject(project)).toBe(true);
    expect(isAuthoringProject({ ...project, schemaVersion: 1 })).toBe(false);
    expect(isAuthoringProject({ ...project, objects: {} })).toBe(false);
    expect(isAuthoringProject({ ...project, unknown: true })).toBe(false);
  });

  it('validates entity id syntax', () => {
    expect(isValidEntityId('valid-id-2')).toBe(true);
    expect(isValidEntityId('2-bad')).toBe(false);
    expect(isValidEntityId('bad_id')).toBe(false);
    expect(isValidEntityId('bad/id')).toBe(false);
  });

  it('normalizes missing editor state and strips editor metadata', () => {
    const project = createAuthoringProject();
    const withoutEditor = { ...project } as Partial<typeof project>;
    delete withoutEditor.editor;
    expect(parseAuthoringProject(withoutEditor).editor.schema).toBe(EDITOR_PROJECT_STATE_SCHEMA);
    expect('editor' in (stripEditorProjectState(project) as Record<string, unknown>)).toBe(false);
    expect('editor' in project).toBe(true);
  });
});
