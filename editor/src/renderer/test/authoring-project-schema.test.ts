import { describe, expect, it } from 'vitest';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { createAuthoringProject, isAuthoringProject, isValidEntityId } from '../../shared/project-schema/authoring-project';

describe('authoring project schema', () => {
  it('creates a complete empty authoring project', () => {
    const project = createAuthoringProject({ id: 'demo-project', name: 'Demo Project' });

    expect(project.schema).toBe('noveltea.authoring.project');
    expect(project.schemaVersion).toBe(1);
    expect(project.project.id).toBe('demo-project');
    expect(project.project.name).toBe('Demo Project');
    expect(project.entrypoint).toBeNull();
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

  it('uses layouts as the authoring layout collection', () => {
    const project = createAuthoringProject();
    expect(project.layouts).toEqual({});
    expect('uiLayouts' in project).toBe(false);
  });
});
