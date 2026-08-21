import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useTranslation } from 'react-i18next';
import type { FeatureData } from '../../../shared/project-schema/authoring-features';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type {
  AuthoredRuntimeValue,
  PropertyDefinition,
} from '../../../shared/project-schema/authoring-properties';

interface Props {
  project: AuthoringProject;
  features: readonly FeatureData[];
  anchorPrefix: 'room' | 'interactable';
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

function initialPropertyValue(definition: PropertyDefinition): AuthoredRuntimeValue {
  if (definition.defaultValue !== undefined) return definition.defaultValue;
  if (definition.nullable) return null;
  if (definition.type === 'boolean') return false;
  if (definition.type === 'integer' || definition.type === 'number') return 0;
  if (definition.type === 'enum') return definition.enumValues?.[0] ?? '';
  return '';
}

function parseTextValue(definition: PropertyDefinition, value: string): AuthoredRuntimeValue {
  if (definition.nullable && value === 'null') return null;
  if (definition.type === 'integer') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (definition.type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return value;
}

export function FeatureAuthoringPanel({ project, features, anchorPrefix, onChange }: Props) {
  const { t } = useTranslation('workspace');
  const traits = Object.values(project.traits).filter((trait) =>
    trait.ownerKinds.includes('feature'),
  );
  const properties = Object.values(project.properties).filter((property) =>
    property.ownerKinds.includes('feature'),
  );
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
              [...features, { id, label: t('features.defaultLabel'), traits: [], properties: {} }],
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
        {features.map((feature) => {
          const availableTraits = traits.filter((trait) => !feature.traits.includes(trait.id));
          const availableProperties = properties.filter(
            (property) => !Object.prototype.hasOwnProperty.call(feature.properties, property.id),
          );
          return (
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

              <div className="space-y-2">
                <Label>{t('features.fields.traits')}</Label>
                <div className="flex flex-wrap gap-2">
                  {feature.traits.map((traitId) => (
                    <Button
                      key={traitId}
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        replace(
                          feature.id,
                          { ...feature, traits: feature.traits.filter((id) => id !== traitId) },
                          'Detach Feature Trait',
                        )
                      }
                    >
                      {project.traits[traitId]?.label ?? traitId} ×
                    </Button>
                  ))}
                  <Select
                    value="__add__"
                    onValueChange={(traitId) => {
                      if (traitId === '__add__') return;
                      replace(
                        feature.id,
                        { ...feature, traits: [...feature.traits, String(traitId)] },
                        'Attach Feature Trait',
                      );
                    }}
                  >
                    <SelectItem value="__add__" disabled>
                      {t('features.addTrait')}
                    </SelectItem>
                    {availableTraits.map((trait) => (
                      <SelectItem key={trait.id} value={trait.id}>
                        {trait.label}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('features.fields.properties')}</Label>
                {Object.entries(feature.properties).map(([propertyId, value]) => {
                  const definition = project.properties[propertyId];
                  if (!definition)
                    return (
                      <div key={propertyId} className="flex items-center gap-2">
                        <span className="font-mono text-sm">{propertyId}</span>
                        <span className="text-sm text-destructive">
                          {t('features.invalidProperty')}
                        </span>
                      </div>
                    );
                  return (
                    <div
                      key={propertyId}
                      className="grid gap-2 md:grid-cols-[12rem_1fr_auto] md:items-center"
                    >
                      <span className="text-sm">{definition.label}</span>
                      {definition.type === 'boolean' ? (
                        <Select
                          value={value === null ? 'null' : value ? 'true' : 'false'}
                          onValueChange={(next) =>
                            replace(
                              feature.id,
                              {
                                ...feature,
                                properties: {
                                  ...feature.properties,
                                  [propertyId]: next === 'null' ? null : next === 'true',
                                },
                              },
                              'Update Feature Property',
                            )
                          }
                        >
                          <SelectItem value="false">False</SelectItem>
                          <SelectItem value="true">True</SelectItem>
                          {definition.nullable ? <SelectItem value="null">Null</SelectItem> : null}
                        </Select>
                      ) : definition.type === 'enum' ? (
                        <Select
                          value={String(value ?? '')}
                          onValueChange={(next) =>
                            replace(
                              feature.id,
                              {
                                ...feature,
                                properties: { ...feature.properties, [propertyId]: String(next) },
                              },
                              'Update Feature Property',
                            )
                          }
                        >
                          {(definition.enumValues ?? []).map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                          {definition.nullable ? <SelectItem value="null">Null</SelectItem> : null}
                        </Select>
                      ) : (
                        <Input
                          value={value === null ? 'null' : String(value)}
                          onChange={(event) =>
                            replace(
                              feature.id,
                              {
                                ...feature,
                                properties: {
                                  ...feature.properties,
                                  [propertyId]: parseTextValue(
                                    definition,
                                    event.currentTarget.value,
                                  ),
                                },
                              },
                              'Update Feature Property',
                            )
                          }
                        />
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = { ...feature.properties };
                          delete next[propertyId];
                          replace(
                            feature.id,
                            { ...feature, properties: next },
                            'Remove Feature Property',
                          );
                        }}
                      >
                        {t('features.removeProperty')}
                      </Button>
                    </div>
                  );
                })}
                <Select
                  value="__add__"
                  onValueChange={(propertyId) => {
                    if (propertyId === '__add__') return;
                    const definition = project.properties[String(propertyId)];
                    if (!definition) return;
                    replace(
                      feature.id,
                      {
                        ...feature,
                        properties: {
                          ...feature.properties,
                          [definition.id]: initialPropertyValue(definition),
                        },
                      },
                      'Add Feature Property',
                    );
                  }}
                >
                  <SelectItem value="__add__" disabled>
                    {t('features.addProperty')}
                  </SelectItem>
                  {availableProperties.map((property) => (
                    <SelectItem key={property.id} value={property.id}>
                      {property.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
