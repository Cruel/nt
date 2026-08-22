import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import {
  authoringInventoryKey,
  enumerateAuthoringInventories,
} from '../../../shared/project-schema/authoring-inventory-queries';
import type { InventoryDefinitionData } from '../../../shared/project-schema/authoring-inventories';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { InteractableData } from '../../../shared/project-schema/authoring-interactables';

export function InventoryDeclarationsEditor({
  inventories,
  onChange,
  title = 'Inventories',
}: {
  inventories: readonly InventoryDefinitionData[];
  onChange: (inventories: InventoryDefinitionData[], label: string) => void;
  title?: string;
}) {
  const nextId = () => {
    const ids = new Set(inventories.map((inventory) => inventory.id));
    let index = 1;
    while (ids.has(index === 1 ? 'inventory' : `inventory-${index}`)) index += 1;
    return index === 1 ? 'inventory' : `inventory-${index}`;
  };

  return (
    <section className="space-y-2 rounded border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">
            Stable owner-local containers. Membership is determined only by Interactable Location.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const id = nextId();
            onChange([...inventories, { id, label: 'Inventory' }], 'Add inventory');
          }}
        >
          Add
        </Button>
      </div>
      {inventories.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Inventories declared.</p>
      ) : (
        inventories.map((inventory, index) => (
          <div
            key={inventory.id}
            className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
          >
            <Input aria-label="Inventory ID" value={inventory.id} readOnly />
            <Input
              aria-label="Inventory label"
              value={inventory.label}
              onChange={(event) =>
                onChange(
                  inventories.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, label: event.currentTarget.value }
                      : candidate,
                  ),
                  'Update inventory label',
                )
              }
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onChange(
                  inventories.filter((_, candidateIndex) => candidateIndex !== index),
                  'Delete inventory',
                )
              }
            >
              Delete
            </Button>
          </div>
        ))
      )}
    </section>
  );
}

export function InteractableLocationEditor({
  project,
  location,
  onChange,
}: {
  project: AuthoringProject;
  location: InteractableData['initialState']['location'];
  onChange: (location: InteractableData['initialState']['location']) => void;
}) {
  const inventories = enumerateAuthoringInventories(project);
  const selectedInventory =
    location.kind === 'inventory' ? authoringInventoryKey(location.inventory) : null;
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <div className="space-y-1">
        <Label>Location</Label>
        <Select
          value={location.kind}
          onValueChange={(kind) => {
            if (kind === 'unplaced') onChange({ kind: 'unplaced' });
            else if (kind === 'room') {
              const roomId = Object.keys(project.rooms).sort()[0];
              onChange(
                roomId
                  ? { kind: 'room', room: { $ref: { collection: 'rooms', id: roomId } } }
                  : { kind: 'unplaced' },
              );
            } else if (kind === 'inventory') {
              const inventory = inventories[0];
              onChange(
                inventory
                  ? { kind: 'inventory', inventory: structuredClone(inventory.reference) }
                  : { kind: 'unplaced' },
              );
            }
          }}
        >
          <SelectItem value="unplaced">Unplaced</SelectItem>
          <SelectItem value="room" disabled={!Object.keys(project.rooms).length}>
            Room
          </SelectItem>
          <SelectItem value="inventory" disabled={!inventories.length}>
            Inventory
          </SelectItem>
        </Select>
      </div>
      {location.kind === 'room' ? (
        <div className="space-y-1">
          <Label>Room</Label>
          <Select
            value={location.room.$ref.id}
            onValueChange={(id) =>
              onChange({ kind: 'room', room: { $ref: { collection: 'rooms', id: String(id) } } })
            }
          >
            {Object.entries(project.rooms)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([id, record]) => (
                <SelectItem key={id} value={id}>
                  {record.label} ({id})
                </SelectItem>
              ))}
          </Select>
        </div>
      ) : null}
      {location.kind === 'inventory' ? (
        <div className="space-y-1">
          <Label>Inventory</Label>
          <Select
            value={selectedInventory ?? ''}
            onValueChange={(key) => {
              const inventory = inventories.find((candidate) => candidate.key === key);
              if (inventory)
                onChange({ kind: 'inventory', inventory: structuredClone(inventory.reference) });
            }}
          >
            {inventories.map((inventory) => (
              <SelectItem key={inventory.key} value={inventory.key}>
                {inventory.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}
