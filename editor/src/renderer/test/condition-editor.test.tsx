import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('recursive Condition editor', () => {
  it('edits nested boolean children through the shared recursive component', () => {
    const project = createAuthoringProject();
    const onChange = vi.fn();
    render(
      <RecursiveConditionEditor
        project={project}
        value={{ kind: 'all', conditions: [{ kind: 'always' }] }}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByText('Always').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'all',
      conditions: [{ kind: 'always' }, { kind: 'always' }],
    });
  });

  it('exposes matcher Property and exact-Instance narrowing for quantity Conditions', () => {
    const project = createAuthoringProject();
    render(
      <RecursiveConditionEditor
        project={project}
        value={{
          kind: 'inventory-quantity-comparison',
          inventory: {
            kind: 'owner-inventory',
            owner: { kind: 'interaction-slot', slotId: 'container' },
            inventoryId: 'contents',
          },
          matcher: { traits: [], properties: [] },
          operator: 'greater',
          quantity: 0,
        }}
        scope={{
          interactionSlots: ['container', 'target'],
          commandResults: [{ id: 'created', kind: 'interactable' }],
        }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Property narrowing')).toBeTruthy();
    expect(screen.getByText('Exact Instance narrowing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
  });
});
