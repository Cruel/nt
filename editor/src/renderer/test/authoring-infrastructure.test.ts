import { describe, expect, it } from 'vite-plus/test';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';

describe('authoring V2 infrastructure', () => {
  it('accepts only gameplay entrypoints and requires a strict Bootstrap Module reference', () => {
    const project = createAuthoringProject();
    project.rooms.start = { id: 'start', label: 'Start', data: defaultRoomData('Start') };
    project.entrypoint = { kind: 'room', id: 'start' };
    expect(isAuthoringProject(project)).toBe(true);
    expect(isAuthoringProject({ ...project, entrypoint: { kind: 'script', id: 'boot' } })).toBe(
      false,
    );
    const { bootstrapModule: _bootstrapModule, ...withoutBootstrap } = project;
    expect(isAuthoringProject(withoutBootstrap)).toBe(false);
    expect(isAuthoringProject({ ...project, startupHook: { source: '' } })).toBe(false);
  });

  it('rejects unknown record and content fields instead of stripping them', () => {
    const project = createAuthoringProject();
    project.rooms.start = { id: 'start', label: 'Start', data: defaultRoomData('Start') };
    expect(
      isAuthoringProject({
        ...project,
        rooms: { start: { ...project.rooms.start, parent: null } },
      }),
    ).toBe(false);
    expect(
      isAuthoringProject({
        ...project,
        rooms: {
          start: { ...project.rooms.start, data: { ...project.rooms.start.data, mystery: true } },
        },
      }),
    ).toBe(false);
  });

  it('keeps category and tag metadata separate from runtime Traits and assignments', () => {
    const project = createAuthoringProject();
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      defaultValue: 'calm',
      ownerKinds: ['room'],
    };
    project.traits['tense-room'] = {
      id: 'tense-room',
      label: 'Tense Room',
      ownerKinds: ['room'],
      properties: [{ id: 'mood', type: 'string', nullable: false, defaultValue: 'tense' }],
    };
    project.rooms.child = {
      id: 'child',
      label: 'Child',
      traits: ['tense-room'],
      properties: {},
      data: defaultRoomData('Child'),
    };
    project.editor.chapters.records.area = { id: 'area', label: 'Area category' };
    project.editor.chapters.assignments.area = ['rooms:child'];
    project.editor.recordMetadata.rooms = { child: { tags: ['Chapter one'], color: '#fff' } };
    expect(isAuthoringProject(project)).toBe(true);
    expect(project.rooms.child).not.toHaveProperty('tags');
    expect(project.rooms.child.traits).toEqual(['tense-room']);
  });

  it('validates property declarations, owner allowlists, nullability, and assignment types', () => {
    const project = createAuthoringProject();
    project.properties.map = {
      id: 'map',
      label: 'Map',
      type: 'string',
      nullable: false,
      defaultValue: 'main',
      ownerKinds: ['room'],
    };
    project.rooms.area = {
      id: 'area',
      label: 'Area',
      properties: { map: null },
      data: defaultRoomData('Area'),
    };
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({ path: '/rooms/area/properties/map' }),
    );
  });

  it('uses globally scoped variable IDs and validates localization catalogs', () => {
    const project = createAuthoringProject();
    project.variables.route = { id: 'route', label: 'Route', data: defaultVariableData('string') };
    project.localization = { defaultLocale: 'en', fallbackLocale: 'pt-BR', catalogs: { en: {} } };
    expect(isAuthoringProject(project)).toBe(false);
    expect(
      isAuthoringProject({
        ...createAuthoringProject(),
        variables: {
          route: {
            id: 'route',
            label: 'Route',
            data: { ...defaultVariableData('string'), runtimeName: 'legacy' },
          },
        },
      }),
    ).toBe(false);
  });
});
