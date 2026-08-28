import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectItem } from '@/components/ui/select';
import type {
  LuaExplicitDependencies,
  LuaExplicitDependencyTarget,
} from '../../shared/project-schema/authoring-lua-analysis';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

const targetKey = (target: LuaExplicitDependencyTarget) => JSON.stringify(target);

function defaultTarget(kind: LuaExplicitDependencyTarget['kind']): LuaExplicitDependencyTarget {
  if (kind === 'record') return { kind, collection: 'characters', id: 'target' };
  if (kind === 'property-value')
    return { kind, owner: { kind: 'character', id: 'target' }, propertyId: 'property' };
  if (kind === 'room-placement') return { kind, roomId: 'room', placementId: 'placement' };
  return { kind, roomId: 'room', exitId: 'exit' };
}

export function LuaExplicitFallbackEditor({
  value,
  onChange,
}: {
  value: LuaExplicitDependencies | undefined;
  onChange: (next: LuaExplicitDependencies) => void;
}) {
  const targets = value?.targets ?? [];
  const replace = (index: number, target: LuaExplicitDependencyTarget) =>
    onChange({ targets: targets.map((item, itemIndex) => (itemIndex === index ? target : item)) });
  return (
    <div className="space-y-2 rounded border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Additional Lua dependencies</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ targets: [...targets, defaultTarget('record')] })}
        >
          Add dependency
        </Button>
      </div>
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add only targets that cannot be inferred from literal Lua references.
        </p>
      ) : null}
      {targets.map((target, index) => (
        <div
          key={`${targetKey(target)}:${index}`}
          className="grid gap-2 md:grid-cols-[180px_1fr_auto]"
        >
          <Select
            value={target.kind}
            onValueChange={(kind) =>
              replace(index, defaultTarget(kind as LuaExplicitDependencyTarget['kind']))
            }
          >
            <SelectItem value="record">Record</SelectItem>
            <SelectItem value="property-value">Property value</SelectItem>
            <SelectItem value="room-placement">Room placement</SelectItem>
            <SelectItem value="room-exit">Room exit</SelectItem>
          </Select>
          {target.kind === 'record' ? (
            <div className="grid gap-2 md:grid-cols-2">
              <Select
                value={target.collection}
                onValueChange={(collection) =>
                  replace(index, {
                    ...target,
                    collection: collection as AuthoringCollectionKey,
                  })
                }
              >
                {authoringCollectionKeys.map((collection) => (
                  <SelectItem key={collection} value={collection}>
                    {collection}
                  </SelectItem>
                ))}
              </Select>
              <Input
                aria-label="Record ID"
                value={target.id}
                onChange={(event) => replace(index, { ...target, id: event.currentTarget.value })}
              />
            </div>
          ) : target.kind === 'property-value' ? (
            <div className="grid gap-2 md:grid-cols-3">
              <Select
                value={target.owner.kind}
                onValueChange={(kind) =>
                  replace(index, {
                    ...target,
                    owner: { ...target.owner, kind: kind as typeof target.owner.kind },
                  })
                }
              >
                {['room', 'character', 'interactable'].map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </Select>
              <Input
                aria-label="Owner ID"
                value={target.owner.id}
                onChange={(event) =>
                  replace(index, {
                    ...target,
                    owner: { ...target.owner, id: event.currentTarget.value },
                  })
                }
              />
              <Input
                aria-label="Property ID"
                value={target.propertyId}
                onChange={(event) =>
                  replace(index, { ...target, propertyId: event.currentTarget.value })
                }
              />
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              <Input
                aria-label="Room ID"
                value={target.roomId}
                onChange={(event) =>
                  replace(index, { ...target, roomId: event.currentTarget.value })
                }
              />
              <Input
                aria-label={target.kind === 'room-placement' ? 'Placement ID' : 'Exit ID'}
                value={target.kind === 'room-placement' ? target.placementId : target.exitId}
                onChange={(event) =>
                  replace(
                    index,
                    target.kind === 'room-placement'
                      ? { ...target, placementId: event.currentTarget.value }
                      : { ...target, exitId: event.currentTarget.value },
                  )
                }
              />
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({ targets: targets.filter((_, itemIndex) => itemIndex !== index) })
            }
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
