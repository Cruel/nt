import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VariablesEditor } from '@/editors/variables/VariablesEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { captureWorkbenchTabState, clearWorkbenchTabStates } from '@/workbench/workbench-tab-state';

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('VariablesEditor', () => {
  it('restores an unfinished creation draft after remount', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const tab = { id: 'tab:variables', title: 'Variables', editorType: 'variables' };
    const view = render(<VariablesEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'New variable' }));
    await user.type(screen.getByPlaceholderText('has-key'), 'unfinished-score');
    captureWorkbenchTabState(tab.id);
    view.unmount();

    render(<VariablesEditor tab={tab} />);
    expect(screen.getByPlaceholderText('has-key')).toHaveValue('unfinished-score');
  });

  it('renders existing variables and creates new variables through the shared dialog', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables['has-key'] = {
      id: 'has-key',
      label: 'has-key',
      data: defaultVariableData('boolean'),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(
      <VariablesEditor
        tab={{ id: 'tab:variables', title: 'Variables', editorType: 'variables' }}
      />,
    );

    expect(screen.getByText('has-key')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New variable' }));
    await user.type(screen.getByPlaceholderText('has-key'), 'score');
    await user.type(screen.getByPlaceholderText('Uses the ID when empty'), 'Score');
    await user.click(screen.getByRole('button', { name: 'Create variable' }));

    expect(useProjectStore.getState().document).toMatchObject({
      variables: {
        'has-key': { label: 'has-key' },
        score: { label: 'Score', data: { kind: 'variable', type: 'boolean', defaultValue: false } },
      },
    });
  });

  it('edits existing variable metadata and enum values in the shared dialog', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables.state = {
      id: 'state',
      label: 'State',
      description: '',
      data: { ...defaultVariableData('enum'), enumValues: ['default'], defaultValue: 'default' },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(
      <VariablesEditor
        tab={{ id: 'tab:variables', title: 'Variables', editorType: 'variables' }}
      />,
    );

    await user.click(screen.getByText('State'));
    const label = screen.getByPlaceholderText('Uses the ID when empty');
    await user.clear(label);
    await user.type(label, 'State Label');
    const description = screen.getByPlaceholderText('What this variable represents');
    await user.type(description, 'Current state');
    const enumValues = screen.getByPlaceholderText('idle, active, complete');
    await user.clear(enumValues);
    await user.type(enumValues, 'idle, active');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(useProjectStore.getState().document).toMatchObject({
      variables: {
        state: {
          label: 'State Label',
          description: 'Current state',
          data: { type: 'enum', enumValues: ['idle', 'active'], defaultValue: 'idle' },
        },
      },
    });
  });

  it('removes enumValues when changing an enum variable to boolean', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables['enum-test'] = {
      id: 'enum-test',
      label: 'Enum',
      data: {
        ...defaultVariableData('enum'),
        enumValues: ['first', 'second'],
        defaultValue: 'first',
      },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(
      <VariablesEditor
        tab={{ id: 'tab:variables', title: 'Variables', editorType: 'variables' }}
      />,
    );

    await user.click(screen.getByText('Enum'));
    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Boolean' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const document = useProjectStore.getState().document;
    expect(isAuthoringProject(document)).toBe(true);
    if (!isAuthoringProject(document)) throw new Error('Expected a project');
    const variable = document.variables['enum-test'];
    expect(variable?.data.type).toBe('boolean');
    expect(variable?.data.enumValues).toBeUndefined();
    expect(screen.getByText('Enum')).toBeInTheDocument();
  });
});
