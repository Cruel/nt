import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InventoryDeclarationsEditor } from '@/components/inventories/InventoryControls';
import { PropertyManager } from '@/components/properties/PropertyManager';
import { useTranslation } from 'react-i18next';
import type { FeatureData } from '../../../shared/project-schema/authoring-features';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';

interface Props {
  project: AuthoringProject;
  features: readonly FeatureData[];
  anchorPrefix: 'room' | 'interactable';
  propertyMode: 'value' | 'default';
  onChange: (features: FeatureData[], label: string) => void;
}

function nextFeatureId(features: readonly FeatureData[]): string {
  const used = new Set(features.map((feature) => feature.id));
  if (!used.has('feature')) return 'feature';
  for (let index = 2; ; index += 1) {
    const id = `feature-${index}`;
    if (!used.has(id)) return id;
  }
}

export function FeatureAuthoringPanel({
  project,
  features,
  anchorPrefix,
  propertyMode,
  onChange,
}: Props) {
  const { t } = useTranslation('workspace');
  const replace = (featureId: string, next: FeatureData, label: string) =>
    onChange(
      features.map((feature) => (feature.id === featureId ? next : feature)),
      label,
    );

  return (
    <section
      className="space-y-3 rounded-lg border bg-card/30 p-3"
      data-workbench-anchor={`${anchorPrefix}.features`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">{t('features.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('features.subtitle')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            const id = nextFeatureId(features);
            onChange(
              [
                ...features,
                {
                  id,
                  label: t('features.defaultLabel'),
                  traits: [],
                  properties: {},
                  localProperties: [],
                  defaultProperties: [],
                  inventories: [],
                },
              ],
              'Add Feature',
            );
          }}
        >
          {t('features.add')}
        </Button>
      </div>
      {features.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('features.empty')}</p>
      ) : null}
      <div className="space-y-3">
        {features.map((feature) => (
          <div
            key={feature.id}
            className="space-y-3 rounded-md border bg-background/50 p-3"
            data-workbench-anchor={`${anchorPrefix}.feature.${feature.id}`}
          >
            <div className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end">
              <div>
                <Label>{t('features.fields.id')}</Label>
                <Input value={feature.id} readOnly className="font-mono" />
              </div>
              <div>
                <Label>{t('features.fields.label')}</Label>
                <Input
                  value={feature.label}
                  onChange={(event) =>
                    replace(
                      feature.id,
                      { ...feature, label: event.currentTarget.value },
                      'Update Feature label',
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  onChange(
                    features.filter((candidate) => candidate.id !== feature.id),
                    'Delete Feature',
                  )
                }
              >
                {t('features.delete')}
              </Button>
            </div>

            {propertyMode === 'value' ? (
              <PropertyManager
                mode="value"
                ownerLabel={`Feature '${feature.label}'`}
                ownerKind="feature"
                traits={project.traits}
                attachedTraits={feature.traits}
                properties={feature.localProperties}
                propertyOverrides={feature.properties}
                onChange={(localProperties) =>
                  replace(feature.id, { ...feature, localProperties }, 'Update Feature Properties')
                }
                onTraitStateChange={(state) =>
                  replace(
                    feature.id,
                    {
                      ...feature,
                      traits: state.traits,
                      localProperties: state.localProperties,
                      properties: state.properties,
                    },
                    'Update Feature Traits and Properties',
                  )
                }
              />
            ) : (
              <PropertyManager
                mode="default"
                ownerLabel={`Feature '${feature.label}'`}
                ownerKind="feature"
                traits={project.traits}
                attachedTraits={feature.traits}
                properties={feature.defaultProperties}
                onChange={(state) =>
                  replace(
                    feature.id,
                    { ...feature, traits: state.traits, defaultProperties: state.properties },
                    'Update Feature Traits and Properties',
                  )
                }
              />
            )}

            <InventoryDeclarationsEditor
              inventories={feature.inventories}
              title="Feature Inventories"
              onChange={(inventories, label) =>
                replace(feature.id, { ...feature, inventories }, label)
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}
