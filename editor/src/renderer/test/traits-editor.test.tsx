import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCommandStore } from '@/commands/command-store';
import { TraitsEditor } from '@/editors/traits/TraitsEditor';
import { useProjectStore } from '@/project/project-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

function loadProject() {
  const project = createAuthoringProject();
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  return project;
}

const tab = { id: 'tab:traits', title: 'Traits', editorType: 'traits' };

describe('TraitsEditor', () => {
  it('creates empty Traits with collaborator-shared editor color metadata', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<TraitsEditor tab={tab} />);

    await user.click(screen.getByRole('button', { name: 'New Trait' }));
    await user.type(screen.getByPlaceholderText('inspectable'), 'inspectable');
    await user.type(screen.getByPlaceholderText('Inspectable'), 'Inspectable');
    await user.click(screen.getByRole('button', { name: 'Create Trait' }));

    const document = useProjectStore.getState().document;
    expect(isAuthoringProject(document)).toBe(true);
    if (!isAuthoringProject(document)) throw new Error('Expected authoring project');
    expect(document.traits.inspectable).toEqual({
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [],
    });
    expect(document.editor.recordMetadata.traits?.inspectable?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('authors ordered typed Trait Properties with an optional Default', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [],
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<TraitsEditor tab={tab} />);

    await user.click(screen.getByRole('button', { name: 'Add Property' }));
    await user.type(screen.getByPlaceholderText('has-key'), 'clue');
    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'String' }));
    const hasDefault = screen.getByRole('switch', { name: 'Has Default' });
    await user.click(hasDefault);
    expect(hasDefault).toHaveAttribute('aria-checked', 'true');
    const propertyDialog = screen.getByRole('dialog', { name: 'Add Property' });
    const defaultInput = within(propertyDialog).getByRole('textbox', { name: 'Default' });
    await user.type(defaultInput, 'portrait');
    expect(defaultInput).toHaveValue('portrait');
    await user.click(screen.getByRole('button', { name: 'Add Property' }));

    const document = useProjectStore.getState().document;
    expect(isAuthoringProject(document)).toBe(true);
    if (!isAuthoringProject(document)) throw new Error('Expected authoring project');
    expect(document.traits.inspectable?.properties).toEqual([
      {
        id: 'clue',
        type: 'string',
        nullable: false,
        defaultValue: 'portrait',
      },
    ]);
  });

  it('renames straightforward typed Trait references along with attachments and metadata', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [],
    };
    project.editor.recordMetadata.traits = {
      inspectable: { tags: [], color: '#2563eb' },
    };
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      traits: ['inspectable'],
      data: defaultRoomData('Room'),
    };
    const verb = defaultVerbData('Inspect');
    verb.slots = [
      {
        id: 'target',
        label: { source: { kind: 'inline', text: 'Target' }, markup: 'plain' },
        prompt: { source: { kind: 'inline', text: 'Choose target' }, markup: 'plain' },
        selectors: [
          { kind: 'trait', trait: { $ref: { collection: 'traits', id: 'inspectable' } } },
        ],
      },
    ];
    verb.bindingOrder = ['target'];
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: verb };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<TraitsEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Edit Inspectable' }));
    const idInput = screen.getByDisplayValue('inspectable');
    await user.clear(idInput);
    await user.type(idInput, 'examinable');
    await user.click(screen.getByRole('button', { name: 'Save Trait' }));

    const document = useProjectStore.getState().document;
    expect(isAuthoringProject(document)).toBe(true);
    if (!isAuthoringProject(document)) throw new Error('Expected authoring project');
    expect(document.traits.inspectable).toBeUndefined();
    expect(document.traits.examinable?.id).toBe('examinable');
    expect(document.rooms.room?.traits).toEqual(['examinable']);
    expect(document.editor.recordMetadata.traits?.inspectable).toBeUndefined();
    expect(document.editor.recordMetadata.traits?.examinable?.color).toBe('#2563eb');
    expect(document.verbs.inspect?.data).toMatchObject({
      slots: [
        {
          selectors: [
            { kind: 'trait', trait: { $ref: { collection: 'traits', id: 'examinable' } } },
          ],
        },
      ],
    });
  });
});
