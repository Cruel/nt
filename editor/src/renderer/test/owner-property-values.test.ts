import { describe, expect, it } from 'vite-plus/test';
import { resolveOwnerPropertyValues } from '@/project/owner-property-values';
import {
  defaultArchetypeData,
  resolveGameplayInstanceRecord,
} from '../../shared/project-schema/authoring-archetypes';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

describe('owner Property value resolution', () => {
  it('applies Trait, Archetype Default, and owner-local precedence once for Room consumers', () => {
    const project = createAuthoringProject();
    project.traits.atmosphere = {
      id: 'atmosphere',
      label: 'Atmosphere',
      ownerKinds: ['room'],
      properties: [
        { id: 'mood', type: 'string', nullable: false, defaultValue: 'trait' },
        { id: 'weather', type: 'string', nullable: false, defaultValue: 'trait-weather' },
      ],
    };
    project.archetypes['room-base'] = {
      id: 'room-base',
      label: 'Room Base',
      data: {
        ...defaultArchetypeData('room'),
        overrides: {
          '/traits': ['atmosphere'],
          '/defaultProperties': [
            { id: 'mood', type: 'string', nullable: false, defaultValue: 'archetype' },
            { id: 'weather', type: 'string', nullable: false, defaultValue: 'archetype-weather' },
          ],
        },
      },
    };
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-base' } },
      archetypeOverrides: {},
      traits: [],
      localProperties: [{ id: 'mood', type: 'string', nullable: false, value: 'owner-local' }],
    };

    const record = project.rooms.foyer!;
    const effectiveRecord = resolveGameplayInstanceRecord(project, 'room', record);
    expect(resolveOwnerPropertyValues(project, record, effectiveRecord)).toEqual({
      mood: 'owner-local',
      weather: 'archetype-weather',
    });
  });
});
