import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  MaterialApplicationEditor,
  materialApplicationPreviewOverrides,
} from './MaterialApplicationEditor';
import { MaterialSelector, type MaterialSelectorOccurrenceOverrides } from './MaterialSelector';
import type { EffectiveInteractableProperty } from '../../../shared/project-schema/authoring-interactable-properties';
import {
  effectiveMaterialApplication,
  type MaterialApplication,
  type MaterialApplicationSpecialization,
} from '../../../shared/project-schema/authoring-material-applications';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';

export function MaterialApplicationSpecializationEditor({
  project,
  inheritedValue,
  value,
  properties = [],
  onChange,
  ariaLabel,
}: {
  project: AuthoringProject;
  inheritedValue: MaterialApplication | null;
  value: MaterialApplicationSpecialization;
  properties?: readonly EffectiveInteractableProperty[];
  onChange: (value: MaterialApplicationSpecialization) => void;
  ariaLabel?: string;
}) {
  const effective = effectiveMaterialApplication(inheritedValue, value);
  const inheritedMaterialId = inheritedValue?.material.$ref.id ?? null;
  const effectiveMaterialId = effective?.material.$ref.id ?? null;
  const hasMaterialOverride = value.material !== null;
  const occurrenceOverrides = useMemo<MaterialSelectorOccurrenceOverrides>(
    () => materialApplicationPreviewOverrides(effective, properties),
    [effective, properties],
  );
  const localApplication = effective
    ? {
        material: effective.material,
        parameters: value.parameters,
        textures: value.textures,
      }
    : null;

  return (
    <div className="space-y-2 rounded border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium">Material Application</div>
          <div className="text-[11px] text-muted-foreground">
            Instance values are sparse and fall back to the Definition when reset.
          </div>
        </div>
        <Badge variant={hasMaterialOverride ? 'default' : 'outline'}>
          {hasMaterialOverride
            ? 'Instance material override'
            : inheritedMaterialId
              ? 'Inherited from Definition'
              : 'No inherited Material'}
        </Badge>
      </div>
      <div className="flex items-stretch gap-1">
        <MaterialSelector
          project={project}
          value={effectiveMaterialId}
          expectedRole="engine-2d"
          occurrenceOverrides={occurrenceOverrides}
          ariaLabel={ariaLabel}
          className="min-w-0 flex-1"
          onValueChange={(materialId) =>
            onChange({
              ...value,
              material:
                materialId === inheritedMaterialId
                  ? null
                  : { $ref: { collection: 'materials', id: materialId } },
            })
          }
        />
        {hasMaterialOverride ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto shrink-0 px-3"
            onClick={() => onChange({ ...value, material: null })}
          >
            Reset to inherited
          </Button>
        ) : null}
      </div>
      {effective && localApplication ? (
        <MaterialApplicationEditor
          project={project}
          value={localApplication}
          inheritedValue={inheritedValue}
          expectedRole="engine-2d"
          properties={properties}
          overrideLabel="Instance override"
          hideMaterialSelector
          onChange={(next) => {
            if (!next) return;
            onChange({ ...value, parameters: next.parameters, textures: next.textures });
          }}
        />
      ) : (
        <div className="text-xs text-muted-foreground">
          Choose an Instance Material override or assign a Definition Material to edit parameters.
        </div>
      )}
    </div>
  );
}
