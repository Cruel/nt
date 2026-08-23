import { describe, expect, it } from 'vite-plus/test';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultVerbData, verbDataSchema } from '../../shared/project-schema/authoring-verbs';

describe('authoring verbs', () => {
  it('accepts stable named completed-command placeholders and rejects positional or unknown placeholders', () => {
    const verb = defaultVerbData('Show');
    verb.slots = [
      {
        id: 'object',
        label: { source: { kind: 'inline', text: 'Object' }, markup: 'plain' },
        prompt: { source: { kind: 'inline', text: 'Choose an object' }, markup: 'plain' },
        selectors: [{ kind: 'any-subject' }],
      },
      {
        id: 'recipient',
        label: { source: { kind: 'inline', text: 'Recipient' }, markup: 'plain' },
        prompt: { source: { kind: 'inline', text: 'Choose a recipient' }, markup: 'plain' },
        selectors: [{ kind: 'family', family: 'character' }],
      },
    ];
    verb.bindingOrder = ['object', 'recipient'];
    verb.completedCommandText = {
      source: { kind: 'inline', text: 'Show {object} to {recipient}' },
      markup: 'plain',
    };
    expect(verbDataSchema.safeParse(verb).success).toBe(true);

    verb.completedCommandText = {
      source: { kind: 'inline', text: 'Show {0} to {missing}' },
      markup: 'plain',
    };
    expect(verbDataSchema.safeParse(verb).success).toBe(false);

    verb.completedCommandText = {
      source: { kind: 'inline', text: 'Show {object} to {recipient}' },
      markup: 'plain',
    };
    verb.slots[0]!.label = {
      source: { kind: 'inline', text: 'Object {missing}' },
      markup: 'plain',
    };
    expect(verbDataSchema.safeParse(verb).success).toBe(false);
  });

  it('validates named placeholders in every authored localized completed-command template', () => {
    const project = createAuthoringProject();
    const verb = defaultVerbData('Use');
    verb.slots = [
      {
        id: 'target',
        label: { source: { kind: 'localized', key: 'target-label' }, markup: 'plain' },
        prompt: { source: { kind: 'localized', key: 'target-prompt' }, markup: 'plain' },
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    verb.bindingOrder = ['target'];
    verb.completedCommandText = {
      source: { kind: 'localized', key: 'use-command' },
      markup: 'plain',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    project.localization.catalogs.en = {
      'target-label': 'Target {missing}',
      'target-prompt': 'Choose {0}',
      'use-command': 'Use {missing}',
    };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/localization/catalogs/en/target-label',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/localization/catalogs/en/target-prompt',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/localization/catalogs/en/use-command',
          severity: 'error',
        }),
      ]),
    );
  });

  it('represents handled and unhandled default-program outcomes explicitly', () => {
    const handled = defaultVerbData('Use');
    const unhandled = {
      ...handled,
      defaultProgram: { ...handled.defaultProgram, outcome: 'unhandled' as const },
    };

    expect(
      isAuthoringProject({
        ...createAuthoringProject(),
        verbs: {
          use: {
            id: 'use',
            label: 'Use',
            data: handled,
          },
        },
      }),
    ).toBe(true);
    expect(unhandled.defaultProgram.outcome).toBe('unhandled');
  });
});
