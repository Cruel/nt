import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnerLocalPropertiesEditor } from '@/components/properties/OwnerLocalPropertiesEditor';
import type { TraitDefinition } from '../../shared/project-schema/authoring-properties';

describe('OwnerLocalPropertiesEditor Trait provenance', () => {
  it('renders one effective row with a navigable numeric Use count and hard-stop multi-Trait colors', async () => {
    const user = userEvent.setup();
    const onShowUsages = vi.fn();
    const first: TraitDefinition = {
      id: 'first',
      label: 'First',
      ownerKinds: ['room'],
      properties: [
        {
          id: 'mood',
          label: 'Mood',
          type: 'string',
          nullable: false,
          defaultValue: 'calm',
        },
      ],
    };
    const second: TraitDefinition = {
      id: 'second',
      label: 'Second',
      ownerKinds: ['room'],
      properties: [
        {
          id: 'mood',
          label: 'Different display label',
          type: 'string',
          nullable: false,
          defaultValue: 'calm',
        },
      ],
    };

    render(
      <OwnerLocalPropertiesEditor
        ownerLabel="Room"
        properties={[]}
        onChange={vi.fn()}
        usageCountFor={() => 3}
        onShowUsages={onShowUsages}
        traits={{ first, second }}
        ownerKind="room"
        attachedTraits={['second', 'first']}
        traitColorFor={(traitId) => (traitId === 'first' ? '#2563eb' : '#dc2626')}
        onTraitStateChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText('mood')).toHaveLength(1);
    const useCell = screen.getByLabelText('Use count 3; Trait sources: Second, First');
    expect(useCell).toHaveTextContent('3');
    expect(useCell.getAttribute('style')).toContain('linear-gradient');
    expect(useCell.getAttribute('style')).toContain('rgb(37, 99, 235)');
    expect(useCell.getAttribute('style')).toContain('rgb(220, 38, 38)');
    await user.click(screen.getByRole('button', { name: '3 usages for mood' }));
    expect(onShowUsages).toHaveBeenCalledWith('mood');
  });

  it('preserves an explicit local override as a standalone Property on last-source detach', async () => {
    const user = userEvent.setup();
    const onTraitStateChange = vi.fn();
    const inspectable: TraitDefinition = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [
        {
          id: 'clue',
          label: 'Clue',
          description: 'Visible evidence',
          type: 'string',
          nullable: false,
        },
      ],
    };

    render(
      <OwnerLocalPropertiesEditor
        ownerLabel="Room"
        onChange={vi.fn()}
        traits={{ inspectable }}
        ownerKind="room"
        attachedTraits={['inspectable']}
        properties={[{ id: 'clue', type: 'string', nullable: false, value: 'portrait' }]}
        onTraitStateChange={onTraitStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Detach inspectable' }));

    expect(onTraitStateChange).toHaveBeenCalledWith({
      traits: [],
      localProperties: [
        {
          id: 'clue',
          type: 'string',
          nullable: false,
          value: 'portrait',
        },
      ],
    });
  });

  it('keeps inherited Archetype schema read-only and resets a concrete Value to its Default', async () => {
    const user = userEvent.setup();
    const onTraitStateChange = vi.fn();
    render(
      <OwnerLocalPropertiesEditor
        ownerLabel="Room"
        properties={[
          { id: 'mood', label: 'Mood', type: 'string', nullable: false, value: 'local' },
        ]}
        onChange={vi.fn()}
        traits={{}}
        ownerKind="room"
        attachedTraits={[]}
        inheritedProperties={[
          {
            sourceLabel: 'Base Room',
            property: {
              id: 'mood',
              label: 'Mood',
              type: 'string',
              nullable: false,
              defaultValue: 'archetype',
            },
          },
        ]}
        onTraitStateChange={onTraitStateChange}
      />,
    );

    expect(screen.getByText('"local"')).toBeInTheDocument();
    expect(screen.getByText('override')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset mood' }));
    expect(onTraitStateChange).toHaveBeenCalledWith({
      traits: [],
      localProperties: [],
    });
  });
});
