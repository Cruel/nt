import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionMasterDetail } from '@/components/collection-master-detail';
import { EditorSectionHeading } from '@/components/editor-section-heading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import type { HotspotEditorViewState } from '@/components/image-stage/hotspot-view-state';
import {
  roomBackgroundTransform,
  type RoomBackgroundFit,
  type StageSize,
} from '@/components/image-stage/image-stage-transforms';
import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import type {
  InteractionSubjectData,
  InteractableHotspotTarget,
  RoomHotspotTarget,
} from '../../../shared/project-schema/authoring-features';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { parseMaterialData } from '../../../shared/project-schema/authoring-materials';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import type { Condition } from '../../../shared/project-schema/authoring-flow';
import {
  systemCursorNames,
  type CursorTarget,
} from '../../../shared/project-schema/authoring-cursor-vocabulary';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import { useProjectStore } from '@/project/project-store';

type EditableHotspotTarget = RoomHotspotTarget | InteractableHotspotTarget;

export interface EditableHotspot {
  id: string;
  label: string;
  condition: Condition;
  inputOrder: number;
  highlight: {
    kind: 'default' | 'none' | 'material';
    material?: { $ref: { collection: 'materials'; id: string } };
  };
  cursor?: CursorTarget | null;
  target: EditableHotspotTarget;
  shape?: { kind: 'rect'; bounds: ImageNormalizedRect };
}

interface Props {
  project: AuthoringProject;
  title: string;
  projectFilePath: string | null;
  assetId: string | null;
  hotspots: readonly EditableHotspot[];
  selectedView: HotspotEditorViewState;
  ownerKind: 'room' | 'interactable';
  ownerId: string;
  localFeatures: readonly { id: string; label: string }[];
  exits?: readonly { id: string; label: string }[];
  alphaMode?: boolean;
  roomVisibleGuide?: { referenceSize: StageSize; fit: RoomBackgroundFit };
  anchorPrefix: 'room' | 'interactable';
  onViewChange(next: HotspotEditorViewState): void;
  onAdd(bounds: ImageNormalizedRect, target: EditableHotspotTarget): void;
  onDelete(id: string): void;
  onRename(id: string, nextId: string): void;
  onUpdate(id: string, next: Omit<EditableHotspot, 'id' | 'shape'>): void;
  onBounds(id: string, bounds: ImageNormalizedRect): void;
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
  const [materialSelectorOpen, setMaterialSelectorOpen] = useState(false);
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const asset = props.assetId ? props.project.assets[props.assetId] : null;
  const assetData = parseAssetData(asset?.data);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    setImageUrl(null);
    if (!projectSessionId || !props.assetId || assetData?.kind !== 'image') return;
    void window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, props.assetId)
      .then((result) => {
        if (!canceled) setImageUrl(result.ok ? result.url : null);
      })
      .catch(() => {
        if (!canceled) setImageUrl(null);
      });
    return () => {
      canceled = true;
    };
  }, [assetData?.kind, assetData?.source.path, projectSessionId, props.assetId]);

  const selected =
    props.hotspots.find((item) => item.id === props.selectedView.selectedHotspotId) ?? null;
  const selectedCondition = selected?.condition ?? null;
  const materials = Object.entries(props.project.materials).filter(
    ([, record]) => parseMaterialData(record.data)?.role === 'hotspot-overlay',
  );
  const selectorItems = useMemo(
    () => buildCommandPaletteItems(props.project, t),
    [props.project, t],
  );
  const materialSelectorItems = useMemo(() => {
    const allowed = new Set(materials.map(([id]) => id));
    return filterSelectorItems(selectorItems, {
      collections: ['materials'],
      includeActions: false,
    }).filter((item) => item.entityId && allowed.has(item.entityId));
  }, [materials, selectorItems]);
  const variables = Object.entries(props.project.variables);

  const targetOptions = useMemo<TargetOption[]>(() => {
    const options: TargetOption[] = [];
    if (props.ownerKind === 'interactable')
      options.push({
        value: 'owner',
        label: t('hotspots.targets.owner'),
        target: { kind: 'owner' },
      });
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
  const addingRectangle = props.selectedView.tool === 'draw-rect';
  const metadata = assetData?.kind === 'image' ? assetData.imageMetadata : null;
  const visibleImageGuide = useMemo(
    () =>
      metadata && props.roomVisibleGuide
        ? roomBackgroundTransform(
            props.roomVisibleGuide.referenceSize,
            { width: metadata.width, height: metadata.height },
            props.roomVisibleGuide.fit,
          ).visibleImageUv
        : null,
    [metadata, props.roomVisibleGuide],
  );
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
      {addingRectangle ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t('hotspots.addInstruction')}
        </p>
      ) : null}
      {!metadata ? <p className="text-sm text-destructive">{t('hotspots.invalidImage')}</p> : null}
      {metadata ? (
        <HotspotImageStage
          imageUrl={imageUrl}
          imageSize={{ width: metadata.width, height: metadata.height }}
          hotspots={props.hotspots.flatMap((item) =>
            item.shape
              ? [
                  {
                    id: item.id,
                    label: item.label,
                    inputOrder: item.inputOrder,
                    bounds: item.shape.bounds,
                  },
                ]
              : [],
          )}
          selectedHotspotId={props.selectedView.selectedHotspotId}
          tool={props.selectedView.tool}
          camera={{
            zoom: props.selectedView.zoom,
            pan: { x: props.selectedView.panX, y: props.selectedView.panY },
          }}
          alphaVisualization={props.alphaMode}
          visibleImageGuide={visibleImageGuide}
          onSelectionChange={(selectedHotspotId) => updateView({ selectedHotspotId })}
          onCameraChange={(camera) =>
            updateView({ zoom: camera.zoom, panX: camera.pan.x, panY: camera.pan.y })
          }
          onCreate={(bounds) => {
            const target = targetOptions[0]?.target;
            if (target) props.onAdd(bounds, target);
          }}
          onCancelCreate={() => updateView({ tool: 'select' })}
          onCommitBounds={(id, bounds) => props.onBounds(id, bounds)}
          onDelete={(id) => props.onDelete(id)}
        />
      ) : null}
      <CollectionMasterDetail
        items={props.hotspots}
        getKey={(item) => item.id}
        selectedKey={selected?.id ?? null}
        onSelectedKeyChange={(selectedHotspotId) => updateView({ selectedHotspotId })}
        listAriaLabel={props.title}
        emptyState={t('hotspots.selectPrompt')}
        layoutClassName="gap-3 @5xl:grid-cols-[14rem_1fr]"
        listAction={{
          label: addingRectangle ? t('hotspots.cancelAdd') : t('hotspots.add'),
          pressed: addingRectangle,
          disabled: !addingRectangle && targetOptions.length === 0,
          onClick: () => updateView({ tool: addingRectangle ? 'select' : 'draw-rect' }),
        }}
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
                            material: {
                              $ref: {
                                collection: 'materials',
                                id: materials[0]?.[0] ?? '',
                              },
                            },
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
                <Select
                  value={selected.highlight.material?.$ref.id ?? ''}
                  onValueChange={(id) =>
                    updateSelected({
                      highlight: {
                        kind: 'material',
                        material: { $ref: { collection: 'materials', id: String(id) } },
                      },
                    })
                  }
                >
                  {materials.map(([id, record]) => (
                    <SelectItem key={id} value={id}>
                      {record.label}
                    </SelectItem>
                  ))}
                </Select>
                <Button
                  className="mt-1"
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setMaterialSelectorOpen(true)}
                >
                  {t('hotspots.searchRecords')}
                </Button>
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
      <SearchSelectorDialog
        open={materialSelectorOpen}
        title={t('hotspots.selectMaterial')}
        placeholder={t('hotspots.searchRecords')}
        emptyMessage={t('hotspots.noMatchingRecords')}
        items={materialSelectorItems}
        selectedId={
          materialSelectorItems.find(
            (item) => item.entityId === selected?.highlight.material?.$ref.id,
          )?.id
        }
        onOpenChange={setMaterialSelectorOpen}
        onSelect={(item) => {
          if (!selected || !item.entityId) return;
          updateSelected({
            highlight: {
              kind: 'material',
              material: { $ref: { collection: 'materials', id: item.entityId } },
            },
          });
        }}
      />
    </section>
  );
}
