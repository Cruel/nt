import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import {
  parseArchetypeData,
  type GameplayInstanceKind,
} from '../../shared/project-schema/authoring-archetypes';
import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import type { GameplayInstanceCollection } from '@/project/archetype-operations';

export function GameplayArchetypeControls({
  project,
  collection,
  entityId,
  record,
  kind,
}: {
  project: AuthoringProject;
  collection: GameplayInstanceCollection;
  entityId: string;
  record: AuthoringRecordBase;
  kind: GameplayInstanceKind;
}) {
  const archetypes = Object.entries(project.archetypes)
    .filter(([, candidate]) => parseArchetypeData(candidate.data)?.instanceKind === kind)
    .sort(([, left], [, right]) => left.label.localeCompare(right.label));
  const attached = record.archetype?.$ref.id ?? '__none__';
  const overrideCount = Object.keys(record.archetypeOverrides ?? {}).length;
  const execute = (type: string, label: string, payload: unknown) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload,
      originSaveUnitId: recordSaveUnitId(collection, entityId),
      persistencePolicy: 'manual-save',
    });

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>Archetype</Label>
          <Select
            value={attached}
            onValueChange={(value) =>
              void execute('gameplay-instance.setArchetype', 'Set Archetype', {
                collection,
                entityId,
                archetypeId: value === '__none__' ? null : value,
              })
            }
          >
            <SelectItem value="__none__">None</SelectItem>
            {archetypes.map(([id, archetype]) => (
              <SelectItem key={id} value={id}>
                {archetype.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        {record.archetype ? (
          <Button
            type="button"
            variant="outline"
            disabled={overrideCount === 0}
            onClick={() =>
              void execute(
                'gameplay-instance.clearArchetypeOverrides',
                'Reset Archetype overrides',
                {
                  collection,
                  entityId,
                },
              )
            }
          >
            Reset overrides
          </Button>
        ) : null}
      </div>
      {record.archetype ? (
        <p className="text-xs text-muted-foreground">
          {overrideCount === 0
            ? 'Using the Archetype configuration directly. Detaching materializes the current effective values.'
            : `${overrideCount} authored override${overrideCount === 1 ? '' : 's'}. Resetting reveals the Archetype values.`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Attach one same-kind Archetype to reuse immutable configuration.
        </p>
      )}
    </div>
  );
}
