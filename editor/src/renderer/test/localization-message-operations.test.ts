import { describe, expect, it } from 'vite-plus/test';
import { renameMessageValueReferencePatches } from '../project/localization-message-operations';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';

describe('localization Message operations', () => {
  it('renames only recognized typed Message value references', () => {
    const project = createAuthoringProject({ id: 'message-rename', name: 'Message Rename' });
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.old',
      source: 'Old',
    };
    const message = defaultVariableData('message');
    message.value = { $message: 'ui.old' };
    project.variables.prompt = { id: 'prompt', label: 'Prompt', data: message };
    const stringValue = defaultVariableData('string');
    stringValue.value = 'ui.old';
    project.variables.literal = { id: 'literal', label: 'Literal', data: stringValue };

    expect(renameMessageValueReferencePatches(project, 'ui.old', 'ui.new')).toEqual([
      {
        op: 'replace',
        path: '/variables/prompt/data/value/$message',
        value: 'ui.new',
      },
    ]);
  });
});
