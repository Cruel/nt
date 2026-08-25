import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';

describe('authoring reference index', () => {
  it('indexes typed entrypoint references', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData() };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    const usages = findUsages(buildReferenceIndex(project), { collection: 'rooms', id: 'foyer' });
    expect(usages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'entrypoint', path: '/entrypoint' }),
      ]),
    );
  });

  it('indexes Scene terminal targets and Dialogue completion targets', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    const scene = defaultSceneData('Opening');
    scene.terminal = {
      kind: 'continue-scene',
      scene: { $ref: { collection: 'scenes', id: 'next' } },
      inputs: [],
    };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.scenes.next = { id: 'next', label: 'Next', data: defaultSceneData('Next') };
    const dialogue = defaultDialogueData('Intro');
    dialogue.completion = { kind: 'room', id: 'foyer' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    expect(findUsages(buildReferenceIndex(project), { collection: 'rooms', id: 'foyer' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'flow-target', path: '/dialogues/intro/data/completion' }),
      ]),
    );
    expect(findUsages(buildReferenceIndex(project), { collection: 'scenes', id: 'next' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/scenes/opening/data/terminal/scene/$ref' }),
      ]),
    );
  });
});
