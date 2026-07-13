import { describe, expect, it } from 'vitest';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { replaceInteractionDataPatches } from '@/project/interaction-operations';

describe('interaction operations', () => {
  it('publishes validated Interaction data through one patch', () => {
    const project = createAuthoringProject(); project.verbs.look = { id: 'look', label: 'Look', extends: null, properties: {}, data: defaultVerbData('Look') }; project.interactions.actions = { id: 'actions', label: 'Actions', extends: null, properties: {}, data: defaultInteractionData() };
    const data = defaultInteractionData(); data.rules.push({ id: 'look-rule', verb: { $ref: { collection: 'verbs', id: 'look' } }, operands: [], context: { kind: 'any' }, program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' } });
    expect(replaceInteractionDataPatches(project, { interactionId: 'actions', data }).patches).toEqual([expect.objectContaining({ op: 'replace', path: '/interactions/actions/data' })]);
  });
});
