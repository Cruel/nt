import { describe, expect, it } from 'vitest';
import { createAuthoringProject, isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

describe('authoring verbs', () => {
  it('represents handled and unhandled default-program outcomes explicitly', () => {
    const handled = defaultVerbData('Use');
    const unhandled = { ...handled, defaultProgram: { ...handled.defaultProgram, outcome: 'unhandled' as const } };

    expect(isAuthoringProject({
      ...createAuthoringProject(),
      verbs: {
        use: {
          id: 'use',
          label: 'Use',
          extends: null,
          properties: {},
          data: handled,
        },
      },
    })).toBe(true);
    expect(unhandled.defaultProgram.outcome).toBe('unhandled');
  });
});
