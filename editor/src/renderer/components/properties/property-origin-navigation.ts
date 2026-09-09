import { buildTraitsEditorTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import type { TraitDefinition } from '../../../shared/project-schema/authoring-properties';
import type { PropertyManagerRow } from './PropertyManager';

export function traitPropertyOriginActions(
  traitIds: readonly string[],
  traits: Readonly<Record<string, TraitDefinition>>,
): NonNullable<PropertyManagerRow['originActions']> {
  return [...new Set(traitIds)].map((traitId) => ({
    label: `Open source Trait '${traits[traitId]?.label ?? traitId}'`,
    onClick: () =>
      navigateToWorkbenchTarget({
        tab: buildTraitsEditorTab(),
        target: { id: `trait.${traitId}`, block: 'center', flash: true },
      }),
  }));
}
