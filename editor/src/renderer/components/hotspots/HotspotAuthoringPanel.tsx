import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import type { HotspotEditorViewStateV1 } from '@/components/image-stage/hotspot-view-state';
import {
  roomBackgroundTransform,
  type RoomBackgroundFit,
  type StageSize,
} from '@/components/image-stage/image-stage-transforms';
import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { parseMaterialData } from '../../../shared/project-schema/authoring-materials';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import type { Condition } from '../../../shared/project-schema/authoring-flow';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';

export interface EditableHotspot {
  id: string;
  label: string;
  condition: Condition;
  inputOrder: number;
  highlight: {
    kind: 'default' | 'none' | 'material';
    material?: { $ref: { collection: 'materials'; id: string } };
  };
  activation:
    | { kind: 'verb'; verb: { $ref: { collection: 'verbs'; id: string } } | null }
    | { kind: 'exit'; exitId: string };
  shape?: { kind: 'rect'; bounds: ImageNormalizedRect };
}

interface Props {
  project: AuthoringProject;
  title: string;
  projectFilePath: string | null;
  assetId: string | null;
  hotspots: readonly EditableHotspot[];
  selectedView: HotspotEditorViewStateV1;
  arity: 0 | 1;
  exits?: readonly { id: string; label: string }[];
  alphaMode?: boolean;
  roomVisibleGuide?: { referenceSize: StageSize; fit: RoomBackgroundFit };
  anchorPrefix: 'room' | 'interactable';
  onViewChange(next: HotspotEditorViewStateV1): void;
  onAdd(bounds: ImageNormalizedRect): void;
  onDelete(id: string): void;
  onRename(id: string, nextId: string): void;
  onUpdate(id: string, next: Omit<EditableHotspot, 'id' | 'shape'>): void;
  onBounds(id: string, bounds: ImageNormalizedRect): void;
}

export function HotspotAuthoringPanel(props: Props) {
  const { t } = useTranslation('workspace');
  const [recordSelector, setRecordSelector] = useState<'verb' | 'material' | null>(null);
  const asset = props.assetId ? props.project.assets[props.assetId] : null;
  const assetData = parseAssetData(asset?.data);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    setImageUrl(null);
    if (!props.projectFilePath || !assetData?.source.path) return;
    Promise.resolve(props.projectFilePath)
      .then((resolved) => window.noveltea.resolveProjectAssetUrl(resolved, assetData.source.path))
      .then((result) => {
        if (!canceled) setImageUrl(result?.url ?? null);
      })
      .catch(() => {
        if (!canceled) setImageUrl(null);
      });
    return () => {
      canceled = true;
    };
  }, [assetData?.source.path, props.projectFilePath]);
  const selected =
    props.hotspots.find((item) => item.id === props.selectedView.selectedHotspotId) ?? null;
  const selectedCondition = selected?.condition ?? null;
  const verbs = Object.entries(props.project.verbs).filter(
    ([, record]) => parseVerbData(record.data)?.arity === props.arity,
  );
  const materials = Object.entries(props.project.materials).filter(
    ([, record]) => parseMaterialData(record.data)?.role === 'hotspot-overlay',
  );
  const selectorItems = useMemo(
    () => buildCommandPaletteItems(props.project, t),
    [props.project, t],
  );
  const verbSelectorItems = useMemo(() => {
    const allowed = new Set(verbs.map(([id]) => id));
    return filterSelectorItems(selectorItems, {
      collections: ['verbs'],
      includeActions: false,
    }).filter((item) => item.entityId && allowed.has(item.entityId));
  }, [selectorItems, verbs]);
  const materialSelectorItems = useMemo(() => {
    const allowed = new Set(materials.map(([id]) => id));
    return filterSelectorItems(selectorItems, {
      collections: ['materials'],
      includeActions: false,
    }).filter((item) => item.entityId && allowed.has(item.entityId));
  }, [materials, selectorItems]);
  const variables = Object.entries(props.project.variables);
  const updateView = (patch: Partial<HotspotEditorViewStateV1>) =>
    props.onViewChange({ ...props.selectedView, ...patch });
  const updateSelected = (patch: Partial<Omit<EditableHotspot, 'id' | 'shape'>>) => {
    if (!selected) return;
    // Interactable hotspot updates use the behavior schema, which intentionally
    // excludes the editor-only geometry shape.
    props.onUpdate(selected.id, {
      label: selected.label,
      condition: selected.condition,
      inputOrder: selected.inputOrder,
      highlight: selected.highlight,
      activation: selected.activation,
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
  return (
    <section
      className="space-y-3 rounded-lg border bg-card/30 p-3"
      data-workbench-anchor={`${props.anchorPrefix}.hotspots`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">{props.title}</h3>
          <p className="text-xs text-muted-foreground">{t('hotspots.subtitle')}</p>
        </div>
        <Button
          size="sm"
          variant={addingRectangle ? 'secondary' : 'outline'}
          aria-pressed={addingRectangle}
          onClick={() => updateView({ tool: addingRectangle ? 'select' : 'draw-rect' })}
        >
          {addingRectangle ? t('hotspots.cancelAdd') : t('hotspots.add')}
        </Button>
      </div>
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
          onCreate={(bounds) => props.onAdd(bounds)}
          onCancelCreate={() => updateView({ tool: 'select' })}
          onCommitBounds={(id, bounds) => props.onBounds(id, bounds)}
          onDelete={(id) => props.onDelete(id)}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-[14rem_1fr]">
        <div className="space-y-1">
          {props.hotspots.map((item) => (
            <Button
              key={item.id}
              data-workbench-anchor={`${props.anchorPrefix}.hotspot.${item.id}`}
              className="w-full justify-start"
              variant={selected?.id === item.id ? 'secondary' : 'ghost'}
              onClick={() => updateView({ selectedHotspotId: item.id })}
            >
              {item.label} <span className="ml-auto font-mono text-xs">{item.id}</span>
            </Button>
          ))}
        </div>
        {selected ? (
          <div className="grid gap-3 md:grid-cols-2">
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
                  onClick={() => setRecordSelector('material')}
                >
                  {t('hotspots.searchRecords')}
                </Button>
              </div>
            ) : null}
            <div>
              <Label>{t('hotspots.fields.activation')}</Label>
              <Select
                value={selected.activation.kind}
                onValueChange={(kind) =>
                  updateSelected({
                    activation:
                      kind === 'exit'
                        ? { kind: 'exit', exitId: props.exits?.[0]?.id ?? '' }
                        : { kind: 'verb', verb: null },
                  })
                }
              >
                <SelectItem value="verb">{t('hotspots.activation.verb')}</SelectItem>
                {props.exits?.length ? (
                  <SelectItem value="exit">{t('hotspots.activation.exit')}</SelectItem>
                ) : null}
              </Select>
            </div>
            {selected.activation.kind === 'verb' ? (
              <div>
                <Label>{t('hotspots.fields.verb', { count: props.arity })}</Label>
                <Select
                  value={selected.activation.verb?.$ref.id ?? '__none__'}
                  onValueChange={(id) =>
                    updateSelected({
                      activation: {
                        kind: 'verb',
                        verb:
                          id === '__none__'
                            ? null
                            : { $ref: { collection: 'verbs', id: String(id) } },
                      },
                    })
                  }
                >
                  <SelectItem value="__none__">{t('hotspots.unbound')}</SelectItem>
                  {verbs.map(([id, record]) => (
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
                  onClick={() => setRecordSelector('verb')}
                >
                  {t('hotspots.searchRecords')}
                </Button>
              </div>
            ) : (
              <div>
                <Label>{t('hotspots.fields.exit')}</Label>
                <Select
                  value={selected.activation.exitId}
                  onValueChange={(exitId) =>
                    updateSelected({ activation: { kind: 'exit', exitId: String(exitId) } })
                  }
                >
                  {props.exits?.map((exit) => (
                    <SelectItem key={exit.id} value={exit.id}>
                      {exit.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            )}
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
              <div className="md:col-span-2">
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
            <Button variant="destructive" onClick={() => props.onDelete(selected.id)}>
              {t('hotspots.delete')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('hotspots.selectPrompt')}</p>
        )}
      </div>
      <SearchSelectorDialog
        open={recordSelector !== null}
        title={
          recordSelector === 'material' ? t('hotspots.selectMaterial') : t('hotspots.selectVerb')
        }
        placeholder={t('hotspots.searchRecords')}
        emptyMessage={t('hotspots.noMatchingRecords')}
        items={recordSelector === 'material' ? materialSelectorItems : verbSelectorItems}
        selectedId={
          recordSelector === 'material'
            ? materialSelectorItems.find(
                (item) => item.entityId === selected?.highlight.material?.$ref.id,
              )?.id
            : verbSelectorItems.find(
                (item) =>
                  item.entityId ===
                  (selected?.activation.kind === 'verb' ? selected.activation.verb?.$ref.id : null),
              )?.id
        }
        onOpenChange={(open) => !open && setRecordSelector(null)}
        onSelect={(item) => {
          if (!selected || !item.entityId) return;
          if (recordSelector === 'material')
            updateSelected({
              highlight: {
                kind: 'material',
                material: { $ref: { collection: 'materials', id: item.entityId } },
              },
            });
          else
            updateSelected({
              activation: {
                kind: 'verb',
                verb: { $ref: { collection: 'verbs', id: item.entityId } },
              },
            });
        }}
      />
    </section>
  );
}
