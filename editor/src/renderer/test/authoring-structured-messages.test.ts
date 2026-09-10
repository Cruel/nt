import { describe, expect, it } from 'vite-plus/test';
import {
  resolveStructuredMessageText,
  structuredMessageForPath,
  structuredMessages,
} from '../../shared/authoring-structured-messages';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

function projectWithRoom() {
  const project = createAuthoringProject({ id: 'structured-localization', name: 'Structured' });
  const room = defaultRoomData('Foyer');
  room.description = inlineTextContent('A quiet foyer.');
  room.placements = [
    {
      id: 'door',
      bounds: { x: 0, y: 0, width: 0.2, height: 0.3 },
      order: 0,
      presentation: { label: inlineTextContent('Door', 'plain'), layout: null },
    },
    {
      id: 'window',
      bounds: { x: 0.5, y: 0, width: 0.2, height: 0.3 },
      order: 1,
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
    expect(before).toMatchObject({ source: 'A quiet foyer.', usageNote: path });

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

  it('discovers direct structured-file edits read-only using deterministic semantic identity', () => {
    const project = projectWithRoom();
    const directEdit = structuredClone(project);
    directEdit.rooms.foyer!.data.description = inlineTextContent('Edited outside the editor.');
    const beforeValidation = JSON.stringify(directEdit);

    const discovered = structuredMessageForPath(directEdit, '/rooms/foyer/data/description');
    expect(discovered).toMatchObject({ source: 'Edited outside the editor.' });
    expect(validateAuthoringProject(directEdit)).not.toContainEqual(
      expect.objectContaining({ code: 'localization.translation.message-missing' }),
    );
    expect(JSON.stringify(directEdit)).toBe(beforeValidation);
    expect(discovered?.id).toBe(
      structuredMessageForPath(project, '/rooms/foyer/data/description')?.id,
    );
  });

  it('keeps ordinary record labels out of the Message model and permits sparse target translations', () => {
    const project = projectWithRoom();
    const messages = structuredMessages(project);
    expect(messages.some((message) => message.source === 'Editor-only room label')).toBe(false);

    const description = structuredMessageForPath(project, '/rooms/foyer/data/description');
    expect(description).not.toBeNull();
    if (!description) return;
    project.localization.locales.fr = { supported: false, parentLocale: null };
    project.localization.translations.fr = { [description.id]: 'Un foyer tranquille.' };

    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'localization.translation.message-missing' }),
    );
    expect(resolveStructuredMessageText(project, description, 'fr')).toEqual({
      text: 'Un foyer tranquille.',
      locale: 'fr',
    });
  });
});
