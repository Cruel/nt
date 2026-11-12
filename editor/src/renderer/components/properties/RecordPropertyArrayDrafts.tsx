import type { ReactNode } from 'react';
import { useProjectField, ProjectFieldError } from '@/commands/use-project-field';
import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { recordSaveUnitId } from '@/project/save-unit-registry';

/** Shared Property Manager collection projection. Schema/value edits which do
 * not remap references use the normal native field scheduler; renames and
 * Trait changes keep their existing atomic semantic commands. */
type PropertyRecordTarget =
  | { collection: 'rooms' | 'characters'; fieldName: 'localProperties' }
  | { collection: 'interactables'; fieldName: 'defaultProperties' };

export function RecordPropertyArrayDrafts<Property>({
  collection,
  recordId,
  tabId,
  fieldName,
  properties,
  children,
}: PropertyRecordTarget & {
  recordId: string;
  tabId: string;
  properties: readonly Property[];
  children: (current: Property[], change: (next: Property[]) => void) => ReactNode;
}) {
  const field = useProjectField({
    tabId,
    saveUnitId: recordSaveUnitId(collection, recordId),
    path: buildJsonPointer([collection, recordId, fieldName]),
    label: `Update ${fieldName}`,
    value: toJsonValue(properties),
  });
  return (
    <>
      {children(field.value as Property[], (next) => field.change(toJsonValue(next)))}
      <ProjectFieldError field={field} />
    </>
  );
}
