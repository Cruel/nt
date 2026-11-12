import type { ReactNode } from 'react';
import type { InteractableInstanceData } from '../../../shared/project-schema/authoring-interactables';
import { useProjectField, ProjectFieldError } from '@/commands/use-project-field';
import { buildJsonPointer } from '@/project/json-pointer';
import { jsonValuesEqual, toJsonValue } from '@/project/json-value';
import { recordSaveUnitId } from '@/project/save-unit-registry';

export interface ExactInstanceOwner {
  collection: 'rooms' | 'interactables';
  id: string;
}

/** Present the same exact registry state in a Room inspector and its Definition.
 * Each stable slice has a recoverable native intent; no whole-Instance
 * optimistic replacement can overwrite a sibling field during a slow ack.
 * Identity-changing Property renames must remain atomic semantic commands. */
export function ExactInstanceDrafts({
  instanceId,
  instance,
  owner,
  tabId,
  children,
  onAtomicRename,
}: {
  instanceId: string;
  instance: InteractableInstanceData;
  owner: ExactInstanceOwner;
  tabId: string;
  children: (
    current: InteractableInstanceData,
    update: (
      next: InteractableInstanceData,
      change?: { kind: 'rename'; fromId: string; toId: string },
    ) => void,
  ) => ReactNode;
  onAtomicRename: (
    next: InteractableInstanceData,
    change: { kind: 'rename'; fromId: string; toId: string },
  ) => void;
}) {
  const saveUnitId = recordSaveUnitId(owner.collection, owner.id);
  const path = (field: string) => buildJsonPointer(['interactableInstances', instanceId, field]);
  const properties = useProjectField({
    tabId,
    saveUnitId,
    path: path('localProperties'),
    label: 'Update exact Instance Properties',
    value: toJsonValue(instance.localProperties),
    scope: 'exact-instance',
  });
  const traits = useProjectField({
    tabId,
    saveUnitId,
    path: path('traits'),
    label: 'Update exact Instance Traits',
    value: toJsonValue(instance.traits),
    scope: 'exact-instance',
  });
  const overrides = useProjectField({
    tabId,
    saveUnitId,
    path: path('featureOverrides'),
    label: 'Update exact Instance Feature Overrides',
    value: toJsonValue(instance.featureOverrides),
    scope: 'exact-instance',
  });
  const material = useProjectField({
    tabId,
    saveUnitId,
    path: path('materialApplication'),
    label: 'Update exact Instance Material Application',
    value: toJsonValue(instance.materialApplication),
    scope: 'exact-instance',
  });
  const current: InteractableInstanceData = {
    ...instance,
    localProperties: properties.value as InteractableInstanceData['localProperties'],
    traits: traits.value as InteractableInstanceData['traits'],
    featureOverrides: overrides.value as InteractableInstanceData['featureOverrides'],
    materialApplication: material.value as InteractableInstanceData['materialApplication'],
  };
  const update = (
    next: InteractableInstanceData,
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) => {
    if (change) {
      onAtomicRename(next, change);
      return;
    }
    if (!jsonValuesEqual(toJsonValue(current.localProperties), toJsonValue(next.localProperties)))
      properties.change(toJsonValue(next.localProperties));
    if (!jsonValuesEqual(toJsonValue(current.traits), toJsonValue(next.traits)))
      traits.change(toJsonValue(next.traits));
    if (!jsonValuesEqual(toJsonValue(current.featureOverrides), toJsonValue(next.featureOverrides)))
      overrides.change(toJsonValue(next.featureOverrides));
    if (
      !jsonValuesEqual(
        toJsonValue(current.materialApplication),
        toJsonValue(next.materialApplication),
      )
    )
      material.change(toJsonValue(next.materialApplication));
  };
  return (
    <>
      {children(current, update)}
      <ProjectFieldError field={properties} />
      <ProjectFieldError field={traits} />
      <ProjectFieldError field={overrides} />
      <ProjectFieldError field={material} />
    </>
  );
}
