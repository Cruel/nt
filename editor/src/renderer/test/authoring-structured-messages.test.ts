import { describe, expect, it } from 'vite-plus/test';
import { structuredMessageForPath } from '../../shared/authoring-structured-messages';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';

function projectWithRoom() {
  const project = createAuthoringProject({ id: 'structured-localization', name: 'Structured' });
  const room = defaultRoomData('Foyer');
  room.description = inlineTextContent('A quiet foyer.');
  room.placements = [
    {
      id: 'door',
      bounds: { x: 0, y: 0, width: 0.2, height: 0.3 },
      presentation: { label: inlineTextContent('Door', 'plain'), layout: null },
    },
    {
      id: 'window',
      bounds: { x: 0.5, y: 0, width: 0.2, height: 0.3 },
      presentation: { label: inlineTextContent('Window', 'plain'), layout: null },
    },
  ];
  project.rooms.foyer = { id: 'foyer', label: 'Editor-only room label', data: room };
  return project;
}

describe('structured localization Messages', () => {
  it('derives stable Message identity from semantic owner paths rather than source prose', () => {
    const project = projectWithRoom();
    const path = '/rooms/foyer/data/description';
    const before = structuredMessageForPath(project, path);
    expect(before).toMatchObject({ source: 'A quiet foyer.', usedIn: path });

    const edited = structuredClone(project);
    edited.rooms.foyer!.data.description = inlineTextContent('A renovated foyer.');
    const after = structuredMessageForPath(edited, path);
    expect(after?.id).toBe(before?.id);
    expect(after?.source).toBe('A renovated foyer.');
  });

  it('uses nested semantic IDs so reordering structured records does not change Message identity', () => {
    const project = projectWithRoom();
    const doorPath = '/rooms/foyer/data/placements/@door/presentation/label';
    const before = structuredMessageForPath(project, doorPath);
    expect(before?.source).toBe('Door');

    const reordered = structuredClone(project);
    reordered.rooms.foyer!.data.placements.reverse();
    const after = structuredMessageForPath(reordered, doorPath);
    expect(after?.id).toBe(before?.id);
  });
});
