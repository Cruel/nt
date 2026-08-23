import { describe, expect, it } from 'vite-plus/test';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { replaceInteractionDataPatches } from '@/project/interaction-operations';

describe('interaction operations', () => {
  it('publishes validated Interaction data through one patch', () => {
    const project = createAuthoringProject();
    project.verbs.look = {
      id: 'look',
      label: 'Look',
      data: defaultVerbData('Look'),
    };
    project.interactions.actions = {
      id: 'actions',
      label: 'Actions',
      data: defaultInteractionData(),
    };
    const data = defaultInteractionData();
    data.rules.push({
      id: 'look-rule',
      verb: { $ref: { collection: 'verbs', id: 'look' } },
      slots: [],
      offer: null,
      guard: { kind: 'always' },
      priority: 0,
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    expect(
      replaceInteractionDataPatches(project, { interactionId: 'actions', data }).patches,
    ).toEqual([expect.objectContaining({ op: 'replace', path: '/interactions/actions/data' })]);
  });
});
