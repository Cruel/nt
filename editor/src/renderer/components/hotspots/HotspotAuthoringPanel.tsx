import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionMasterDetail } from '@/components/collection-master-detail';
import { EditorSectionHeading } from '@/components/editor-section-heading';
import { MaterialApplicationEditor } from '@/components/materials/MaterialApplicationEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import type { HotspotEditorViewState } from '@/components/image-stage/hotspot-view-state';
import type { InteractionSubjectData } from '../../../shared/project-schema/authoring-features';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';
import { emptyMaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import { systemCursorNames } from '../../../shared/project-schema/authoring-cursor-vocabulary';
import { Button } from '@/components/ui/button';
import type { EditableHotspot, EditableHotspotTarget } from './hotspot-types';

export type { EditableHotspot } from './hotspot-types';

interface Props {
  project: AuthoringProject;
  title: string;
  projectFilePath: string | null;
  assetId: string | null;
  hotspots: readonly EditableHotspot[];
  selectedView: HotspotEditorViewState;
  ownerKind: 'room' | 'interactable';
  ownerId: string;
  materialProperties?: readonly {
    id: string;
    contract: { type: string; label?: string | null };
  }[];
  localFeatures: readonly { id: string; label: string }[];
  exits?: readonly { id: string; label: string }[];
  alphaMode?: boolean;
  detailOnly?: boolean;
  anchorPrefix: 'room' | 'interactable';
  onViewChange(next: HotspotEditorViewState): void;
  onDelete(id: string): void;
  onRename(id: string, nextId: string): void;
  onUpdate(id: string, next: Omit<EditableHotspot, 'id' | 'shape'>): void;
  onEditGeometry(selectedHotspotId?: string | null): void;
}

interface TargetOption {
  value: string;
  label: string;
  target: EditableHotspotTarget;
}

function targetKey(target: EditableHotspotTarget): string {
  return JSON.stringify(target);
}

function subjectTarget(subject: InteractionSubjectData): EditableHotspotTarget {
  return { kind: 'subject', subject };
}

export function HotspotAuthoringPanel(props: Props) {
  const { t } = useTranslation('workspace');
  const asset = props.assetId ? props.project.assets[props.assetId] : null;
  const assetData = parseAssetData(asset?.data);

  const selected =
    props.hotspots.find((item) => item.id === props.selectedView.selectedHotspotId) ?? null;
  const selectedCondition = selected?.condition ?? null;
  const materials = Object.entries(props.project.materials).filter(
    ([id]) => resolveMaterialData(props.project, id).data?.role === 'hotspot-overlay',
  );
  const variables = Object.entries(props.project.variables);

  const targetOptions = useMemo<TargetOption[]>(() => {
    const options: TargetOption[] = [];
    if (props.ownerKind === 'interactable') {
      options.push({
        value: 'owner',
        label: t('hotspots.targets.owner'),
        target: { kind: 'owner' },
      });
    }
    options.push({ value: 'none', label: t('hotspots.targets.none'), target: { kind: 'none' } });
    for (const feature of props.localFeatures) {
      options.push({
        value: `owner-feature:${feature.id}`,
        label: t('hotspots.targets.localFeature', { label: feature.label }),
        target: { kind: 'owner-feature', featureId: feature.id },
      });
    }
    for (const exit of props.exits ?? []) {
      options.push({
        value: `exit:${exit.id}`,
        label: t('hotspots.targets.exit', { label: exit.label }),
        target: { kind: 'exit', exitId: exit.id },
      });
    }
    for (const [id, record] of Object.entries(props.project.characters)) {
      options.push({
        value: `character:${id}`,
        label: t('hotspots.targets.character', { label: record.label }),
        target: subjectTarget({
          kind: 'character',
          character: { $ref: { collection: 'characters', id } },
        }),
      });
    }
    for (const [id, instance] of Object.entries(props.project.interactableInstances)) {
      const definition = props.project.interactables[instance.definition.$ref.id];
      options.push({
        value: `interactable:${id}`,
        label: t('hotspots.targets.interactable', {
          label: instance.editorLabel ?? definition?.label ?? id,
        }),
        target: subjectTarget({
          kind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id } },
        }),
      });
    }
    for (const [instanceId, instance] of Object.entries(props.project.interactableInstances)) {
      const record = props.project.interactables[instance.definition.$ref.id];
      const data = record ? parseInteractableData(record.data) : null;
      if (!data) continue;
      for (const feature of data.features)
        options.push({
          value: `interactable-feature:${instanceId}:${feature.id}`,
          label: t('hotspots.targets.feature', {
            owner: instance.editorLabel ?? instanceId,
            label: feature.label,
          }),
          target: subjectTarget({
            kind: 'feature',
            feature: {
              ownerKind: 'interactable',
              interactable: {
                $ref: { registry: 'interactableInstances', id: instanceId },
              },
              featureId: feature.id,
            },
          }),
        });
    }
    for (const [id, record] of Object.entries(props.project.rooms)) {
      if (props.ownerKind === 'room' && id === props.ownerId) continue;
      const data = parseRoomData(record.data);
      if (!data) continue;
      for (const feature of data.features)
        options.push({
          value: `room-feature:${id}:${feature.id}`,
          label: t('hotspots.targets.feature', { owner: record.label, label: feature.label }),
          target: subjectTarget({
            kind: 'feature',
            feature: {
              ownerKind: 'room',
              room: { $ref: { collection: 'rooms', id } },
              featureId: feature.id,
            },
          }),
        });
    }
    return options;
  }, [props.exits, props.localFeatures, props.ownerId, props.ownerKind, props.project, t]);

  const updateView = (patch: Partial<HotspotEditorViewState>) =>
    props.onViewChange({ ...props.selectedView, ...patch });
  const updateSelected = (patch: Partial<Omit<EditableHotspot, 'id' | 'shape'>>) => {
    if (!selected) return;
    props.onUpdate(selected.id, {
      label: selected.label,
      condition: selected.condition,
      inputOrder: selected.inputOrder,
      highlight: selected.highlight,
      cursor: selected.cursor ?? null,
      target: selected.target,
      ...patch,
    });
  };
  const metadata = assetData?.kind === 'image' ? assetData.imageMetadata : null;
  const selectedTargetOption = selected
    ? targetOptions.find((option) => targetKey(option.target) === targetKey(selected.target))
    : null;
  const selectedNamedCursorId = selected?.cursor?.kind === 'named' ? selected.cursor.id : null;
  const missingNamedCursorId =
    selectedNamedCursorId &&
    !props.project.settings.cursors.named.some((cursor) => cursor.id === selectedNamedCursorId)
      ? selectedNamedCursorId
      : null;

  return (
    <section
      className="space-y-3 rounded-lg border bg-card/30 p-3"
      data-workbench-anchor={`${props.anchorPrefix}.hotspots`}
    >
      <EditorSectionHeading
        title={props.title}
        help={t('hotspots.subtitle')}
        helpLabel={`About ${props.title}`}
      />
      {!metadata ? <p className="text-sm text-destructive">{t('hotspots.invalidImage')}</p> : null}
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
        <p className="text-xs text-muted-foreground">{t('hotspots.geometryDescription')}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!metadata}
          onClick={() => props.onEditGeometry(props.selectedView.selectedHotspotId)}
        >
          {props.alphaMode ? t('hotspots.inspectGeometry') : t('hotspots.editGeometry')}
        </Button>
      </div>
      <CollectionMasterDetail
        items={props.hotspots}
        getKey={(item) => item.id}
        selectedKey={selected?.id ?? null}
        onSelectedKeyChange={(selectedHotspotId) => updateView({ selectedHotspotId })}
        listAriaLabel={props.title}
        emptyState={t('hotspots.selectPrompt')}
        layoutClassName={
          props.detailOnly
            ? 'grid-cols-1 gap-3 [&>div:first-child]:hidden @5xl:grid-cols-1'
            : 'gap-3 @5xl:grid-cols-[14rem_1fr]'
        }
        getItemAnchor={(item) => `${props.anchorPrefix}.hotspot.${item.id}`}
        getDeleteLabel={() => t('hotspots.delete')}
        onDeleteItem={(item) => props.onDelete(item.id)}
        getItemPresentation={(item) => ({
          label: item.label,
          trailing: <span className="font-mono">{item.id}</span>,
        })}
        renderDetail={(selected) => (
          <div className="grid gap-3 @3xl:grid-cols-2">
            <div>
              <Label>{t('hotspots.fields.id')}</Label>
              <Input
                key={selected.id}
                defaultValue={selected.id}
                onBlur={(event) =>
                  event.currentTarget.value !== selected.id &&
                  props.onRename(selected.id, event.currentTarget.value)
                }
              />
            </div>
            <div>
              <Label>{t('hotspots.fields.label')}</Label>
              <Input
                value={selected.label}
                onChange={(event) => updateSelected({ label: event.currentTarget.value })}
              />
            </div>
            <div>
              <Label>{t('hotspots.fields.inputOrder')}</Label>
              <Input
                type="number"
                value={selected.inputOrder}
                onChange={(event) =>
                  updateSelected({ inputOrder: Number(event.currentTarget.value) })
                }
              />
            </div>
            <div>
              <Label>{t('hotspots.fields.highlight')}</Label>
              <Select
                value={selected.highlight.kind}
                onValueChange={(kind) =>
                  updateSelected({
                    highlight:
                      kind === 'material'
                        ? {
                            kind: 'material',
                            materialApplication: emptyMaterialApplication(materials[0]?.[0] ?? ''),
                          }
                        : { kind: kind as 'default' | 'none' },
                  })
                }
              >
                <SelectItem value="default">{t('hotspots.highlight.default')}</SelectItem>
                <SelectItem value="material" disabled={!materials.length}>
                  {t('hotspots.highlight.material')}
                </SelectItem>
                <SelectItem value="none">{t('hotspots.highlight.none')}</SelectItem>
              </Select>
            </div>
            {selected.highlight.kind === 'material' ? (
              <div>
                <Label>{t('hotspots.fields.highlightMaterial')}</Label>
                <MaterialApplicationEditor
                  project={props.project}
                  value={selected.highlight.materialApplication}
                  expectedRole="hotspot-overlay"
                  properties={props.materialProperties ?? []}
                  allowClear={false}
                  onChange={(materialApplication) => {
                    if (!materialApplication) return;
                    updateSelected({
                      highlight: { kind: 'material', materialApplication },
                    });
                  }}
                />
              </div>
            ) : null}
            {props.ownerKind === 'room' || !props.alphaMode ? (
              <div>
                <Label>{t('hotspots.fields.cursor')}</Label>
                <Select
                  value={
                    selected.cursor?.kind === 'system'
                      ? `system:${selected.cursor.cursor}`
                      : selected.cursor?.kind === 'named'
                        ? `named:${selected.cursor.id}`
                        : selected.cursor?.kind === 'none'
                          ? 'none'
                          : 'fallback'
                  }
                  onValueChange={(value) => {
                    if (!value) return;
                    if (value === 'fallback') updateSelected({ cursor: null });
                    else if (value === 'none') updateSelected({ cursor: { kind: 'none' } });
                    else if (value.startsWith('system:'))
                      updateSelected({
                        cursor: {
                          kind: 'system',
                          cursor: value.slice(
                            'system:'.length,
                          ) as (typeof systemCursorNames)[number],
                        },
                      });
                    else if (value.startsWith('named:'))
                      updateSelected({
                        cursor: { kind: 'named', id: value.slice('named:'.length) },
                      });
                  }}
                >
                  <SelectItem value="fallback">
                    {props.ownerKind === 'room'
                      ? t('hotspots.cursor.projectDefault')
                      : t('hotspots.cursor.interactableDefault')}
                  </SelectItem>
                  <SelectItem value="none">{t('hotspots.cursor.none')}</SelectItem>
                  {systemCursorNames.map((cursor) => (
                    <SelectItem key={cursor} value={`system:${cursor}`}>
                      {cursor}
                    </SelectItem>
                  ))}
                  {props.project.settings.cursors.named.map((cursor) => (
                    <SelectItem key={cursor.id} value={`named:${cursor.id}`}>
                      {cursor.id}
                    </SelectItem>
                  ))}
                  {missingNamedCursorId ? (
                    <SelectItem value={`named:${missingNamedCursorId}`}>
                      {t('hotspots.cursor.missingNamed', { id: missingNamedCursorId })}
                    </SelectItem>
                  ) : null}
                </Select>
              </div>
            ) : null}
            <div className="@3xl:col-span-2">
              <Label>{t('hotspots.fields.target')}</Label>
              <Select
                value={selectedTargetOption?.value ?? '__invalid__'}
                onValueChange={(value) => {
                  const option = targetOptions.find((candidate) => candidate.value === value);
                  if (option) updateSelected({ target: option.target });
                }}
              >
                {selectedTargetOption ? null : (
                  <SelectItem value="__invalid__">{t('hotspots.targets.invalid')}</SelectItem>
                )}
                {targetOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t('hotspots.fields.condition')}</Label>
              <Select
                value={selectedCondition?.kind ?? 'always'}
                onValueChange={(kind) =>
                  updateSelected({
                    condition:
                      kind === 'variable-comparison'
                        ? {
                            kind: 'variable-comparison',
                            variable: {
                              $ref: { collection: 'variables', id: variables[0]?.[0] ?? '' },
                            },
                            operator: 'truthy',
                          }
                        : kind === 'lua-predicate'
                          ? {
                              kind: 'lua-predicate',
                              source: 'return true',
                              additionalDependencies: { targets: [] },
                            }
                          : { kind: 'always' },
                  })
                }
              >
                <SelectItem value="always">{t('hotspots.condition.always')}</SelectItem>
                <SelectItem value="variable-comparison" disabled={!variables.length}>
                  {t('hotspots.condition.variable')}
                </SelectItem>
                <SelectItem value="lua-predicate">{t('hotspots.condition.lua')}</SelectItem>
              </Select>
            </div>
            {selectedCondition?.kind === 'variable-comparison' ? (
              <>
                <div>
                  <Label>{t('hotspots.fields.variable')}</Label>
                  <Select
                    value={selectedCondition.variable.$ref.id}
                    onValueChange={(id) =>
                      updateSelected({
                        condition: {
                          ...selectedCondition,
                          variable: { $ref: { collection: 'variables', id: String(id) } },
                        },
                      })
                    }
                  >
                    {variables.map(([id, record]) => (
                      <SelectItem key={id} value={id}>
                        {record.label}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>{t('hotspots.fields.operator')}</Label>
                  <Select
                    value={selectedCondition.operator}
                    onValueChange={(operator) =>
                      updateSelected({
                        condition: {
                          ...selectedCondition,
                          operator: operator as typeof selectedCondition.operator,
                        },
                      })
                    }
                  >
                    {[
                      'equal',
                      'not-equal',
                      'less',
                      'less-equal',
                      'greater',
                      'greater-equal',
                      'truthy',
                      'falsy',
                    ].map((operator) => (
                      <SelectItem key={operator} value={operator}>
                        {t(`hotspots.operators.${operator}`)}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                {!['truthy', 'falsy'].includes(selectedCondition.operator) ? (
                  <div>
                    <Label>{t('hotspots.fields.value')}</Label>
                    <Input
                      value={String(selectedCondition.value ?? '')}
                      onChange={(event) =>
                        updateSelected({
                          condition: { ...selectedCondition, value: event.currentTarget.value },
                        })
                      }
                    />
                  </div>
                ) : null}
              </>
            ) : null}
            {selectedCondition?.kind === 'lua-predicate' ? (
              <div className="@3xl:col-span-2">
                <Label>{t('hotspots.fields.luaPredicate')}</Label>
                <Input
                  value={selectedCondition.source}
                  onChange={(event) =>
                    updateSelected({
                      condition: {
                        ...selectedCondition,
                        source: event.currentTarget.value || ' ',
                      },
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        )}
      />
    </section>
  );
}
