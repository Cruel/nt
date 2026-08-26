import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
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
  const { t } = useTranslation('workspace');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const archetypeItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['archetypes'],
        includeActions: false,
      }).filter((item) => {
        const candidate = item.entityId ? project.archetypes[item.entityId] : null;
        return candidate ? parseArchetypeData(candidate.data)?.instanceKind === kind : false;
      }),
    [kind, project.archetypes, selectorItems],
  );
  const attached = record.archetype?.$ref.id ?? null;
  const selectedItem = archetypeItems.find((item) => item.entityId === attached);
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
          <div className="flex overflow-hidden rounded-md border bg-background">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start rounded-none px-3 py-2 text-left"
              onClick={() => setSelectorOpen(true)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {selectedItem?.title ?? 'Choose archetype'}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedItem?.entityId ??
                    `${archetypeItems.length} compatible archetypes available`}
                </span>
              </span>
            </Button>
            {attached ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto rounded-none border-l px-3"
                onClick={() =>
                  void execute('gameplay-instance.setArchetype', 'Detach Archetype', {
                    collection,
                    entityId,
                    archetypeId: null,
                  })
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
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
      <SearchSelectorDialog
        open={selectorOpen}
        title={`Choose ${kind} Archetype`}
        placeholder="Search archetypes..."
        emptyMessage="No compatible Archetypes match your search."
        items={archetypeItems}
        selectedId={selectedItem?.id ?? null}
        onOpenChange={setSelectorOpen}
        onSelect={(item) => {
          if (!item.entityId) return;
          void execute('gameplay-instance.setArchetype', 'Set Archetype', {
            collection,
            entityId,
            archetypeId: item.entityId,
          });
        }}
      />
    </div>
  );
}
