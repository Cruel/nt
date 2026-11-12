import { useGameplayRecordField } from '@/commands/gameplay-record-fields';
import { ProjectFieldError } from '@/commands/use-project-field';
import { toJsonValue } from '@/project/json-value';
import type { InventoryDefinitionData } from '../../../shared/project-schema/authoring-inventories';
import { InventoryDeclarationsEditor } from './InventoryControls';

/** The same recoverable inventory declaration editor for Character and
 * Interactable Definition owners. Exact Instances have distinct semantics. */
export function GameplayInventoriesField({
  collection,
  recordId,
  tabId,
  inventories,
  title,
}: {
  collection: 'characters' | 'interactables';
  recordId: string;
  tabId: string;
  inventories: readonly InventoryDefinitionData[];
  title: string;
}) {
  const draft = useGameplayRecordField({
    record: { collection, id: recordId },
    tabId,
    field: '/inventories',
    value: toJsonValue(inventories),
    label: `Update ${collection} inventories`,
  });
  return (
    <>
      <InventoryDeclarationsEditor
        inventories={draft.value as InventoryDefinitionData[]}
        onChange={(next) => draft.change(toJsonValue(next))}
        title={title}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}
