import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VariablesEditor } from '@/editors/variables/VariablesEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

describe('VariablesEditor', () => {
  it('renders existing variables and creates new variables through commands', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables['has-key'] = { id: 'has-key', label: 'Has Key', tags: [], data: defaultVariableData('boolean') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<VariablesEditor tab={{ id: 'tab:variables', title: 'Variables', editorType: 'variables' }} />);

    expect(screen.getByText('Variables')).toBeInTheDocument();
    expect(screen.getByText('has-key')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Has Key')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('has-key'), 'score');
    await user.type(screen.getByPlaceholderText('Has key'), 'Score');
    await user.click(screen.getByText('Create'));

    expect(useProjectStore.getState().document).toMatchObject({
      variables: {
        'has-key': { label: 'Has Key' },
        score: { label: 'Score', data: { kind: 'variable', type: 'boolean', defaultValue: false } },
      },
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('entity.createRecord');
  });
});
