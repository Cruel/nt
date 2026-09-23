import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectItem } from '@/components/ui/select';
import { MaterialSelector, type MaterialSelectorOccurrenceOverrides } from './MaterialSelector';
import { useMaterialPreviewResource } from '@/material-preview/material-preview-provider';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  emptyMaterialApplication,
  materialStandardFacetValues,
  type MaterialApplication,
  type MaterialApplicationParameterOverride,
} from '../../../shared/project-schema/authoring-material-applications';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  isUniformValueCompatible,
  shaderUniformValueSchema,
  type ShaderRole,
  type ShaderUniformType,
  type ShaderUniformValue,
} from '../../../shared/project-schema/authoring-shaders';

function defaultValue(type: ShaderUniformType): ShaderUniformValue {
  switch (type) {
    case 'float':
    case 'int':
      return 0;
    case 'bool':
      return false;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'vec4':
      return [0, 0, 0, 0];
    case 'color':
      return { r: 0, g: 0, b: 0, a: 1 };
  }
}

function valueToText(value: ShaderUniformValue | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return [value.r, value.g, value.b, value.a].join(', ');
  return value === undefined || value === null ? '' : String(value);
}

function parseValue(type: ShaderUniformType, text: string): ShaderUniformValue | null {
  if (type === 'bool') return text === 'true';
  if (type === 'float') {
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (type === 'int') {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  }
  const values = text.split(',').map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isFinite(value))) return null;
  const raw: unknown =
    type === 'color'
      ? values.length === 4
        ? { r: values[0], g: values[1], b: values[2], a: values[3] }
        : null
      : values;
  const parsed = shaderUniformValueSchema.safeParse(raw);
  return parsed.success && isUniformValueCompatible(type, parsed.data) ? parsed.data : null;
}

export interface MaterialApplicationPropertyBindingOption {
  id: string;
  contract: {
    type: string;
    label?: string | null;
  };
}

function propertyCompatible(
  type: ShaderUniformType,
  property: MaterialApplicationPropertyBindingOption,
) {
  if (type === 'bool') return property.contract.type === 'boolean';
  if (type === 'int') return property.contract.type === 'integer';
  if (type === 'float')
    return property.contract.type === 'number' || property.contract.type === 'integer';
  return false;
}

function sourceLabel(override: MaterialApplicationParameterOverride) {
  if (override.source.kind === 'literal') return 'Literal';
  if (override.source.kind === 'property') return `Property · ${override.source.property}`;
  return `Facet · ${override.source.facet}`;
}

export function materialApplicationParameterOverrideCompatible(
  type: ShaderUniformType,
  override: MaterialApplicationParameterOverride,
  properties: readonly MaterialApplicationPropertyBindingOption[],
): boolean {
  if (override.type !== type) return false;
  if (override.source.kind === 'literal')
    return isUniformValueCompatible(type, override.source.value);
  if (override.source.kind === 'standard-facet') return type === 'float';
  if (!('property' in override.source)) return false;
  const propertyId = override.source.property;
  const property = properties.find((candidate) => candidate.id === propertyId);
  return !!property && propertyCompatible(type, property);
}

export function MaterialApplicationEditor({
  project,
  value,
  expectedRole,
  properties = [],
  onChange,
  ariaLabel,
  inheritedValue = null,
  overrideLabel = 'Definition override',
  hideMaterialSelector = false,
  allowClear = true,
}: {
  project: AuthoringProject;
  value: MaterialApplication | null;
  expectedRole: ShaderRole;
  properties?: readonly MaterialApplicationPropertyBindingOption[];
  onChange: (value: MaterialApplication | null) => void;
  ariaLabel?: string;
  inheritedValue?: MaterialApplication | null;
  overrideLabel?: string;
  hideMaterialSelector?: boolean;
  allowClear?: boolean;
}) {
  const materialId = value?.material.$ref.id ?? null;
  const resource = useMaterialPreviewResource(materialId);
  const imageAssets = useMemo(
    () =>
      Object.entries(project.assets)
        .flatMap(([id, record]) =>
          parseAssetData(record.data)?.kind === 'image' ? [{ id, label: record.label }] : [],
        )
        .sort(
          (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
        ),
    [project.assets],
  );
  const occurrenceOverrides = useMemo<MaterialSelectorOccurrenceOverrides>(
    () => ({
      parameters: Object.fromEntries(
        Object.entries({ ...inheritedValue?.parameters, ...value?.parameters }).flatMap(
          ([name, override]) =>
            override.source.kind === 'literal'
              ? [[name, { type: override.type, value: override.source.value }]]
              : [],
        ),
      ),
    }),
    [inheritedValue?.parameters, value?.parameters],
  );
  const uniforms = resource?.derivedInterface?.uniforms ?? {};
  const samplers = resource?.derivedInterface?.samplers ?? {};
  const activeParameterNames = new Set(
    Object.entries(uniforms)
      .filter(([name, declaration]) => {
        const override = value?.parameters[name];
        return (
          declaration.binding == null &&
          !!override &&
          materialApplicationParameterOverrideCompatible(declaration.type, override, properties)
        );
      })
      .map(([name]) => name),
  );
  const activeTextureNames = new Set(
    Object.entries(samplers)
      .filter(([name, declaration]) => declaration.binding == null && !!value?.textures[name])
      .map(([name]) => name),
  );

  const updateParameter = (name: string, override: MaterialApplicationParameterOverride | null) => {
    if (!value) return;
    const parameters = { ...value.parameters };
    if (override) parameters[name] = override;
    else delete parameters[name];
    onChange({ ...value, parameters });
  };
  const updateTexture = (name: string, assetId: string | null) => {
    if (!value) return;
    const textures = { ...value.textures };
    if (assetId) textures[name] = { source: { $ref: { collection: 'assets', id: assetId } } };
    else delete textures[name];
    onChange({ ...value, textures });
  };

  return (
    <div className="space-y-3">
      {!hideMaterialSelector ? (
        <div className="flex items-stretch gap-1">
          <MaterialSelector
            project={project}
            value={materialId}
            expectedRole={expectedRole}
            occurrenceOverrides={occurrenceOverrides}
            ariaLabel={ariaLabel}
            className="min-w-0 flex-1"
            onValueChange={(nextMaterialId) =>
              onChange(
                value
                  ? {
                      ...value,
                      material: { $ref: { collection: 'materials', id: nextMaterialId } },
                    }
                  : emptyMaterialApplication(nextMaterialId),
              )
            }
          />
          {value && allowClear ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto shrink-0 px-3"
              onClick={() => onChange(null)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      {value && resource?.derivedInterface ? (
        <div className="space-y-3 rounded-md border p-2.5">
          <div className="space-y-1">
            <div className="text-xs font-medium">Parameters</div>
            {Object.entries(uniforms).map(([name, declaration]) => {
              const override = value.parameters[name];
              const inheritedOverride = inheritedValue?.parameters[name];
              const active =
                declaration.binding == null &&
                !!override &&
                materialApplicationParameterOverrideCompatible(
                  declaration.type,
                  override,
                  properties,
                );
              const inheritedActive =
                declaration.binding == null &&
                !!inheritedOverride &&
                materialApplicationParameterOverrideCompatible(
                  declaration.type,
                  inheritedOverride,
                  properties,
                );
              const materialDefault =
                resource.resolved.parameters[name]?.value ?? declaration.default;
              const effectiveInheritedLiteral =
                inheritedActive && inheritedOverride.source.kind === 'literal'
                  ? inheritedOverride.source.value
                  : undefined;
              const literal =
                active && override.source.kind === 'literal' ? override.source.value : undefined;
              const compatibleProperties = properties.filter((property) =>
                propertyCompatible(declaration.type, property),
              );
              return (
                <div
                  key={name}
                  className="grid gap-2 rounded border p-2 @3xl:grid-cols-[minmax(120px,1fr)_160px_minmax(170px,1.4fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      {declaration.editor?.label ?? name}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {name} · {declaration.type}
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Badge variant={active ? 'default' : 'outline'}>
                      {declaration.binding != null
                        ? 'Renderer supplied'
                        : active
                          ? overrideLabel
                          : inheritedActive
                            ? 'Inherited from Definition'
                            : 'Material default'}
                    </Badge>
                  </div>
                  {declaration.binding != null ? (
                    <div className="self-center text-xs text-muted-foreground">
                      {declaration.binding}
                    </div>
                  ) : active ? (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Select
                        value={override.source.kind}
                        onValueChange={(kind) => {
                          if (kind === 'literal')
                            updateParameter(name, {
                              type: declaration.type,
                              source: {
                                kind: 'literal',
                                value:
                                  effectiveInheritedLiteral ??
                                  materialDefault ??
                                  defaultValue(declaration.type),
                              },
                            });
                          else if (kind === 'property') {
                            const property = compatibleProperties[0];
                            if (property)
                              updateParameter(name, {
                                type: declaration.type,
                                source: { kind: 'property', property: property.id },
                              });
                          } else
                            updateParameter(name, {
                              type: declaration.type,
                              source: { kind: 'standard-facet', facet: 'occurrence-time' },
                            });
                        }}
                      >
                        <SelectItem value="literal">Literal</SelectItem>
                        <SelectItem value="property" disabled={compatibleProperties.length === 0}>
                          Property
                        </SelectItem>
                        <SelectItem value="standard-facet" disabled={declaration.type !== 'float'}>
                          Standard facet
                        </SelectItem>
                      </Select>
                      {override.source.kind === 'literal' ? (
                        declaration.type === 'bool' ? (
                          <Select
                            value={literal === true ? 'true' : 'false'}
                            onValueChange={(next) =>
                              updateParameter(name, {
                                type: declaration.type,
                                source: { kind: 'literal', value: next === 'true' },
                              })
                            }
                          >
                            <SelectItem value="false">false</SelectItem>
                            <SelectItem value="true">true</SelectItem>
                          </Select>
                        ) : (
                          <Input
                            value={valueToText(literal)}
                            onChange={(event) => {
                              const parsed = parseValue(
                                declaration.type,
                                event.currentTarget.value,
                              );
                              if (parsed !== null)
                                updateParameter(name, {
                                  type: declaration.type,
                                  source: { kind: 'literal', value: parsed },
                                });
                            }}
                          />
                        )
                      ) : override.source.kind === 'property' ? (
                        <Select
                          value={override.source.property}
                          onValueChange={(property) =>
                            updateParameter(name, {
                              type: declaration.type,
                              source: { kind: 'property', property: String(property) },
                            })
                          }
                        >
                          {compatibleProperties.map((property) => (
                            <SelectItem key={property.id} value={property.id}>
                              {property.contract.label ?? property.id}
                            </SelectItem>
                          ))}
                        </Select>
                      ) : (
                        <Select
                          value={override.source.facet}
                          onValueChange={(facet) =>
                            updateParameter(name, {
                              type: declaration.type,
                              source: {
                                kind: 'standard-facet',
                                facet: facet as (typeof materialStandardFacetValues)[number],
                              },
                            })
                          }
                        >
                          {materialStandardFacetValues.map((facet) => (
                            <SelectItem key={facet} value={facet}>
                              {facet}
                            </SelectItem>
                          ))}
                        </Select>
                      )}
                    </div>
                  ) : (
                    <div className="self-center truncate text-xs text-muted-foreground">
                      {inheritedActive && inheritedOverride
                        ? inheritedOverride.source.kind === 'literal'
                          ? valueToText(inheritedOverride.source.value)
                          : sourceLabel(inheritedOverride)
                        : valueToText(materialDefault)}
                    </div>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={declaration.binding != null}
                    onClick={() =>
                      active
                        ? updateParameter(name, null)
                        : updateParameter(name, {
                            type: declaration.type,
                            source: {
                              kind: 'literal',
                              value:
                                effectiveInheritedLiteral ??
                                materialDefault ??
                                defaultValue(declaration.type),
                            },
                          })
                    }
                  >
                    {active ? 'Reset' : 'Override'}
                  </Button>
                </div>
              );
            })}
            {Object.entries(value.parameters)
              .filter(([name]) => !activeParameterNames.has(name))
              .map(([name, override]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-2 rounded border border-dashed p-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-mono">{name}</span>
                    <span className="ml-2 text-muted-foreground">
                      Dormant · {override.type} · {sourceLabel(override)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateParameter(name, null)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium">Textures</div>
            {Object.entries(samplers).map(([name, declaration]) => {
              const override = value.textures[name];
              const inheritedOverride = inheritedValue?.textures[name];
              const active = !!override && declaration.binding == null;
              const inheritedActive = !!inheritedOverride && declaration.binding == null;
              return (
                <div
                  key={name}
                  className="grid gap-2 rounded border p-2 @3xl:grid-cols-[minmax(120px,1fr)_160px_minmax(180px,1.4fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{name}</div>
                    <div className="text-[10px] text-muted-foreground">texture2d</div>
                  </div>
                  <div className="flex items-center">
                    <Badge variant={active ? 'default' : 'outline'}>
                      {declaration.binding != null
                        ? 'Renderer supplied'
                        : active
                          ? overrideLabel
                          : inheritedActive
                            ? 'Inherited from Definition'
                            : 'Material default'}
                    </Badge>
                  </div>
                  {declaration.binding != null ? (
                    <div className="self-center text-xs text-muted-foreground">
                      {declaration.binding}
                    </div>
                  ) : active ? (
                    <Select
                      value={override.source.$ref.id}
                      onValueChange={(assetId) => updateTexture(name, String(assetId))}
                    >
                      {imageAssets.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.label} ({asset.id})
                        </SelectItem>
                      ))}
                    </Select>
                  ) : (
                    <div className="self-center text-xs text-muted-foreground">
                      {inheritedActive && inheritedOverride
                        ? `Inherited · ${inheritedOverride.source.$ref.id}`
                        : 'Inherited Material texture'}
                    </div>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={declaration.binding != null || (!active && imageAssets.length === 0)}
                    onClick={() =>
                      updateTexture(name, active ? null : (imageAssets[0]?.id ?? null))
                    }
                  >
                    {active ? 'Reset' : 'Override'}
                  </Button>
                </div>
              );
            })}
            {Object.entries(value.textures)
              .filter(([name]) => !activeTextureNames.has(name))
              .map(([name, override]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-2 rounded border border-dashed p-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-mono">{name}</span>
                    <span className="ml-2 text-muted-foreground">
                      Dormant texture · {override.source.$ref.id}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateTexture(name, null)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
          </div>
        </div>
      ) : value ? (
        <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          The certified Material interface is unavailable. Saved application overrides are
          preserved.
        </div>
      ) : null}
    </div>
  );
}
