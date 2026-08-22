import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { buildJsonPointer } from '@/project/json-pointer';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  parseItemDefinitionData,
  parseItemStackData,
  type ItemDefinitionData,
  type ItemStackData,
} from '../../../shared/project-schema/authoring-items';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';

function commitData(
  collection: 'itemDefinitions' | 'itemStacks',
  id: string,
  value: ItemDefinitionData | ItemStackData,
) {
  useCommandStore.getState().executeCommand({
    type: 'project.replaceAtPath',
    label: collection === 'itemDefinitions' ? 'Update Item Definition' : 'Update Item Stack',
    payload: { path: buildJsonPointer([collection, id, 'data']), value },
    originSaveUnitId: recordSaveUnitId(collection, id),
    persistencePolicy: 'manual-save',
  });
}

export function ItemEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const collection = tab.resource?.collection;
  const id = tab.resource?.entityId;
  if (!project || !id || (collection !== 'itemDefinitions' && collection !== 'itemStacks'))
    return <div className="p-4 text-sm text-muted-foreground">Item record not found.</div>;
  const record = project[collection][id];
  if (!record)
    return <div className="p-4 text-sm text-muted-foreground">Item record not found.</div>;

  const definition = collection === 'itemDefinitions' ? parseItemDefinitionData(record.data) : null;
  const stack = collection === 'itemStacks' ? parseItemStackData(record.data) : null;
  if (!definition && !stack)
    return <div className="p-4 text-sm text-muted-foreground">Item data is invalid.</div>;

  const commit = (value: ItemDefinitionData | ItemStackData) => commitData(collection, id, value);
  const locationValue = stack
    ? stack.location.kind === 'room'
      ? `room:${stack.location.room.$ref.id}`
      : stack.location.kind === 'inventory' && stack.location.inventory.owner.kind === 'project'
        ? `inventory:${stack.location.inventory.inventoryId}`
        : stack.location.kind
    : 'unplaced';

  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      {definition ? (
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <div>
            <Label>Display name</Label>
            <Input
              value={definition.displayName}
              onChange={(event) =>
                commit({ ...definition, displayName: event.currentTarget.value })
              }
            />
          </div>
          <div>
            <Label>Stack limit</Label>
            <Input
              type="number"
              min={1}
              value={definition.stackLimit ?? ''}
              placeholder="Unlimited"
              onChange={(event) => {
                const value = event.currentTarget.value;
                commit({ ...definition, stackLimit: value ? Number(value) : null });
              }}
            />
          </div>
          <div className="md:col-span-2">
            <Label>Description</Label>
            <Input
              value={definition.description}
              onChange={(event) =>
                commit({ ...definition, description: event.currentTarget.value })
              }
            />
          </div>
          <div>
            <Label>Sprite</Label>
            <Select
              value={definition.presentation.sprite?.$ref.id ?? '__none__'}
              onValueChange={(value) =>
                commit({
                  ...definition,
                  presentation: {
                    ...definition.presentation,
                    sprite:
                      value === '__none__'
                        ? null
                        : { $ref: { collection: 'assets', id: String(value) } },
                  },
                })
              }
            >
              <SelectItem value="__none__">No sprite</SelectItem>
              {Object.entries(project.assets)
                .filter(([, asset]) => (asset.data as { kind?: string }).kind === 'image')
                .map(([assetId, asset]) => (
                  <SelectItem key={assetId} value={assetId}>
                    {asset.label || assetId}
                  </SelectItem>
                ))}
            </Select>
          </div>
          <div>
            <Label>Material</Label>
            <Select
              value={definition.presentation.material?.$ref.id ?? '__none__'}
              onValueChange={(value) =>
                commit({
                  ...definition,
                  presentation: {
                    ...definition.presentation,
                    material:
                      value === '__none__'
                        ? null
                        : { $ref: { collection: 'materials', id: String(value) } },
                  },
                })
              }
            >
              <SelectItem value="__none__">No material</SelectItem>
              {Object.entries(project.materials).map(([materialId, material]) => (
                <SelectItem key={materialId} value={materialId}>
                  {material.label || materialId}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>
      ) : null}
      {stack ? (
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <div>
            <Label>Item Definition</Label>
            <Select
              value={stack.definition.$ref.id}
              onValueChange={(value) =>
                commit({
                  ...stack,
                  definition: {
                    $ref: { collection: 'itemDefinitions', id: String(value) },
                  },
                })
              }
            >
              {Object.entries(project.itemDefinitions).map(([definitionId, item]) => (
                <SelectItem key={definitionId} value={definitionId}>
                  {item.label || definitionId}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div>
            <Label>Initial quantity</Label>
            <Input
              type="number"
              min={1}
              value={stack.quantity}
              onChange={(event) =>
                commit({ ...stack, quantity: Number(event.currentTarget.value) })
              }
            />
          </div>
          <div className="md:col-span-2">
            <Label>Initial Location</Label>
            <Select
              value={locationValue}
              onValueChange={(value) => {
                const target = String(value);
                if (target === 'unplaced') commit({ ...stack, location: { kind: 'unplaced' } });
                else if (target.startsWith('room:'))
                  commit({
                    ...stack,
                    location: {
                      kind: 'room',
                      room: { $ref: { collection: 'rooms', id: target.slice(5) } },
                    },
                  });
                else if (target.startsWith('inventory:'))
                  commit({
                    ...stack,
                    location: {
                      kind: 'inventory',
                      inventory: {
                        owner: { kind: 'project' },
                        inventoryId: target.slice(10),
                      },
                    },
                  });
              }}
            >
              <SelectItem value="unplaced">Unplaced</SelectItem>
              {Object.entries(project.rooms).map(([roomId, room]) => (
                <SelectItem key={`room:${roomId}`} value={`room:${roomId}`}>
                  Room: {room.label || roomId}
                </SelectItem>
              ))}
              {project.inventories.map((inventory) => (
                <SelectItem key={`inventory:${inventory.id}`} value={`inventory:${inventory.id}`}>
                  Project inventory: {inventory.label}
                </SelectItem>
              ))}
              {!['unplaced'].includes(locationValue) &&
              !locationValue.startsWith('room:') &&
              !locationValue.startsWith('inventory:') ? (
                <SelectItem value={locationValue}>Existing nested inventory</SelectItem>
              ) : null}
            </Select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
