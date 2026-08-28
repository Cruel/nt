import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnerLocalPropertiesEditor } from '@/components/properties/OwnerLocalPropertiesEditor';
import type { TraitDefinition } from '../../shared/project-schema/authoring-properties';

describe('OwnerLocalPropertiesEditor Trait provenance', () => {
  it('renders one effective row with a numeric Use count and hard-stop multi-Trait colors', () => {
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
  });

  it('materializes an explicit override as a standalone local Property on last-source detach', async () => {
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
        properties={[]}
        onChange={vi.fn()}
        traits={{ inspectable }}
        ownerKind="room"
        attachedTraits={['inspectable']}
        propertyOverrides={{ clue: 'portrait' }}
        onTraitStateChange={onTraitStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Detach inspectable' }));

    expect(onTraitStateChange).toHaveBeenCalledWith({
      traits: [],
      properties: {},
      localProperties: [
        {
          id: 'clue',
          label: 'Clue',
          description: 'Visible evidence',
          type: 'string',
          nullable: false,
          value: 'portrait',
        },
      ],
    });
  });
});
