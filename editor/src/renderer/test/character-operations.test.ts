import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';

describe('character commands', () => {
  it('creates typed character data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'characters', entityId: 'iris', label: 'Iris' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      characters: {
        iris: {
          data: {
            kind: 'character',
            displayName: 'Iris',
            poses: [{ id: 'default' }],
            expressions: [{ id: 'neutral' }],
          },
        },
      },
    });
  });

  it('patches valid character data and rejects invalid data', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalid = executeCommand(state, {
      type: 'character.replaceData',
      payload: { characterId: 'iris', data: { ...defaultCharacterData('Iris'), poses: [] } },
    });
    expect(invalid.ok).toBe(false);

    const next = {
      ...defaultCharacterData('Iris'),
      dialogue: { name: 'Iris V.', nameColor: null, textColor: null, styleClass: 'hero' },
    };
    const valid = executeCommand(state, {
      type: 'character.replaceData',
      label: 'Set character dialogue style',
      payload: { characterId: 'iris', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({
      characters: { iris: { data: { dialogue: { name: 'Iris V.', styleClass: 'hero' } } } },
    });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      characters: { iris: { data: { dialogue: { name: 'Iris', styleClass: '' } } } },
    });
  });
});
