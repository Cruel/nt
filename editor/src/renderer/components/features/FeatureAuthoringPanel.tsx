import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionMasterDetail } from '@/components/collection-master-detail';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InventoryDeclarationsEditor } from '@/components/inventories/InventoryControls';
import { OwnerDefaultPropertiesEditor } from '@/components/properties/OwnerDefaultPropertiesEditor';
import { OwnerLocalPropertiesEditor } from '@/components/properties/OwnerLocalPropertiesEditor';
import type { FeatureData } from '../../../shared/project-schema/authoring-features';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';

interface Props {
  project: AuthoringProject;
  features: readonly FeatureData[];
  anchorPrefix: 'room' | 'interactable';
  ownerId?: string;
  dependentReferenceCountFor?: (featureId: string) => number;
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
  ownerId,
  dependentReferenceCountFor,
  propertyMode,
  onChange,
}: Props) {
  const { t } = useTranslation('workspace');
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    featureId: string;
    dependentOverrideCount: number;
    dependentReferenceCount: number;
  } | null>(null);
  const activeFeature =
    (selectedFeatureId ? features.find((feature) => feature.id === selectedFeatureId) : null) ??
    features[0] ??
    null;
  const activeFeatureId = activeFeature?.id ?? null;

  const replace = (featureId: string, next: FeatureData, label: string) =>
    onChange(
      features.map((feature) => (feature.id === featureId ? next : feature)),
      label,
    );

  const commitDelete = (featureId: string) => {
    const index = features.findIndex((feature) => feature.id === featureId);
    const nextFeatures = features.filter((candidate) => candidate.id !== featureId);
    const nextSelected =
      nextFeatures[Math.max(0, Math.min(index, nextFeatures.length - 1))]?.id ?? null;
    setSelectedFeatureId(nextSelected);
    onChange(nextFeatures, 'Delete Feature');
  };

  const deleteFeature = (featureId: string) => {
    const dependentOverrideCount =
      anchorPrefix === 'interactable' && ownerId
        ? Object.values(project.interactableInstances).filter(
            (instance) =>
              instance.definition.$ref.id === ownerId &&
              instance.featureOverrides.some((override) => override.featureId === featureId),
          ).length
        : 0;
    const dependentReferenceCount = dependentReferenceCountFor?.(featureId) ?? 0;
    if (dependentOverrideCount > 0 || dependentReferenceCount > 0) {
      setPendingDelete({ featureId, dependentOverrideCount, dependentReferenceCount });
      return;
    }
    commitDelete(featureId);
  };

  return (
    <>
      <CollectionMasterDetail
        anchor={`${anchorPrefix}.features`}
        className="rounded-lg border bg-card/30 p-3"
        title={t('features.title')}
        description={t('features.subtitle')}
        listAction={{
          label: t('features.add'),
          onClick: () => {
            const id = nextFeatureId(features);
            setSelectedFeatureId(id);
            onChange(
              [
                ...features,
                {
                  id,
                  label: t('features.defaultLabel'),
                  traits: [],
                  localProperties: [],
                  defaultProperties: [],
                  inventories: [],
                },
              ],
              'Add Feature',
            );
          },
        }}
        items={features}
        getKey={(feature) => feature.id}
        selectedKey={activeFeatureId}
        onSelectedKeyChange={(featureId) => setSelectedFeatureId(featureId)}
        listAriaLabel={t('features.title')}
        emptyState={t('features.empty')}
        getItemAnchor={(feature) => `${anchorPrefix}.feature.${feature.id}`}
        onDeleteItem={(feature) => deleteFeature(feature.id)}
        getDeleteLabel={() => t('features.delete')}
        getItemPresentation={(feature) => {
          const propertyCount =
            propertyMode === 'value'
              ? feature.localProperties.length
              : feature.defaultProperties.length;
          return {
            label: feature.label,
            secondary: <span className="font-mono">{feature.id}</span>,
            trailing: `${propertyCount} prop${propertyCount === 1 ? '' : 's'}`,
          };
        }}
        renderDetail={(feature) => (
          <div className="space-y-3 rounded-md border bg-background/50 p-3">
            <div className="grid gap-3 @3xl:grid-cols-[12rem_1fr_auto] @3xl:items-end">
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
            </div>

            {propertyMode === 'value' ? (
              <OwnerLocalPropertiesEditor
                ownerLabel={`Feature '${feature.label}'`}
                ownerKind="feature"
                traits={project.traits}
                attachedTraits={feature.traits}
                properties={feature.localProperties}
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
                    },
                    'Update Feature Traits and Properties',
                  )
                }
                traitColorFor={(traitId) =>
                  project.editor.recordMetadata.traits?.[traitId]?.color ?? null
                }
              />
            ) : (
              <OwnerDefaultPropertiesEditor
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
                traitColorFor={(traitId) =>
                  project.editor.recordMetadata.traits?.[traitId]?.color ?? null
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
        )}
      />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>
            {pendingDelete?.dependentReferenceCount
              ? t('features.deleteBlockedTitle')
              : t('features.deleteDependentTitle')}
          </DialogTitle>
          <DialogDescription>
            {pendingDelete?.dependentReferenceCount
              ? t('features.deleteBlockedDescription', {
                  count: pendingDelete.dependentReferenceCount,
                })
              : t('features.deleteDependentDescription', {
                  count: pendingDelete?.dependentOverrideCount ?? 0,
                })}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              {pendingDelete?.dependentReferenceCount
                ? t('features.deleteBlockedClose')
                : t('features.deleteDependentCancel')}
            </Button>
            {pendingDelete && pendingDelete.dependentReferenceCount === 0 ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  commitDelete(pendingDelete.featureId);
                  setPendingDelete(null);
                }}
              >
                {t('features.deleteDependentConfirm')}
              </Button>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
