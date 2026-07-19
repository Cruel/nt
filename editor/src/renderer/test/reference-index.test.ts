import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';

describe('authoring reference index', () => {
  it('indexes typed entrypoint and same-type extends references', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.hall = { id: 'hall', label: 'Hall', extends: 'foyer', data: defaultRoomData() };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    const usages = findUsages(buildReferenceIndex(project), { collection: 'rooms', id: 'foyer' });
    expect(usages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'entrypoint', path: '/entrypoint' }),
        expect.objectContaining({ kind: 'extends', path: '/rooms/hall/extends' }),
      ]),
    );
  });

  it('indexes Scene continuations and Dialogue completion targets', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    const scene = defaultSceneData('Opening');
    scene.continuation = { kind: 'room', id: 'foyer' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    const dialogue = defaultDialogueData('Intro');
    dialogue.completion = { kind: 'room', id: 'foyer' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    expect(findUsages(buildReferenceIndex(project), { collection: 'rooms', id: 'foyer' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'flow-target', path: '/scenes/opening/data/continuation' }),
        expect.objectContaining({ kind: 'flow-target', path: '/dialogues/intro/data/completion' }),
      ]),
    );
  });
});
