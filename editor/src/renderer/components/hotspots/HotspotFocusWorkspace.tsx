import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import { fitImageStageZoom, type StageSize } from '@/components/image-stage/image-stage-transforms';
import { Button } from '@/components/ui/button';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { useProjectStore } from '@/project/project-store';
import { useHotspotFocusStore } from './hotspot-focus-store';
import type { EditableHotspot } from './hotspot-types';

interface Props {
  tabId: string;
  projectAssets: Record<string, { data: unknown }>;
  createHotspot: (
    id: string,
    inputOrder: number,
    bounds: { x: number; y: number; width: number; height: number },
  ) => EditableHotspot;
}

export function HotspotFocusWorkspace({ tabId, projectAssets, createHotspot }: Props) {
  const { t } = useTranslation('workspace');
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const session = useHotspotFocusStore((state) => state.sessionsByTabId[tabId]);
  const setSelection = useHotspotFocusStore((state) => state.setSelection);
  const setTool = useHotspotFocusStore((state) => state.setTool);
  const setCamera = useHotspotFocusStore((state) => state.setCamera);
  const initializeCamera = useHotspotFocusStore((state) => state.initializeCamera);
  const add = useHotspotFocusStore((state) => state.add);
  const setBounds = useHotspotFocusStore((state) => state.setBounds);
  const remove = useHotspotFocusStore((state) => state.delete);
  const undo = useHotspotFocusStore((state) => state.undo);
  const redo = useHotspotFocusStore((state) => state.redo);
  const commit = useHotspotFocusStore((state) => state.commit);
  const discard = useHotspotFocusStore((state) => state.discard);
  const [viewport, setViewport] = useState<StageSize>({ width: 0, height: 0 });
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const assetData = useMemo(() => {
    if (!session?.assetId) return null;
    return parseAssetData(projectAssets[session.assetId]?.data);
  }, [projectAssets, session?.assetId]);
  const imageSize = useMemo(
    () =>
      assetData?.kind === 'image' && assetData.imageMetadata
        ? { width: assetData.imageMetadata.width, height: assetData.imageMetadata.height }
        : null,
    [assetData],
  );

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    if (!projectSessionId || !session?.assetId || assetData?.kind !== 'image') return undefined;
    void window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, session.assetId)
      .then((result) => {
        if (!cancelled) setImageUrl(result.ok ? result.url : null);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [assetData?.kind, assetData?.source.path, projectSessionId, session?.assetId]);

  useEffect(() => {
    if (
      !session ||
      session.cameraInitialized ||
      !imageSize ||
      viewport.width <= 0 ||
      viewport.height <= 0
    )
      return;
    initializeCamera(tabId, {
      zoom: fitImageStageZoom(viewport, imageSize, 'native'),
      pan: { x: 0, y: 0 },
    });
  }, [imageSize, initializeCamera, session, tabId, viewport]);

  if (!session) return null;
  const hotspots = session.history.present;
  const canDraw = session.mode === 'rectangles';
  const nextId = () => {
    const ids = new Set(hotspots.map((item) => item.id));
    for (let index = 1; ; index += 1) {
      const id = index === 1 ? 'hotspot' : `hotspot-${index}`;
      if (!ids.has(id)) return id;
    }
  };
  const nextInputOrder = () =>
    Math.min(
      2147483647,
      hotspots.reduce((maximum, item) => Math.max(maximum, item.inputOrder), -1) + 1,
    );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-hotspot-focus=""
      tabIndex={-1}
      onKeyDown={(event) => {
        const modifier = event.ctrlKey || event.metaKey;
        if (!modifier) return;
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) {
          event.preventDefault();
          undo(tabId);
        } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
          event.preventDefault();
          redo(tabId);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-auto min-w-0">
          <div className="truncate text-sm font-medium">{t('hotspots.focus.title')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {canDraw ? t('hotspots.focus.rectangleHelp') : t('hotspots.focus.alphaHelp')}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={session.tool === 'select' ? 'default' : 'outline'}
          aria-pressed={session.tool === 'select'}
          onClick={() => setTool(tabId, 'select')}
        >
          {t('hotspots.focus.select')}
        </Button>
        {canDraw ? (
          <Button
            type="button"
            size="sm"
            variant={session.tool === 'draw-rect' ? 'default' : 'outline'}
            aria-pressed={session.tool === 'draw-rect'}
            onClick={() => setTool(tabId, 'draw-rect')}
          >
            {t('hotspots.focus.rectangle')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={session.tool === 'pan' ? 'default' : 'outline'}
          aria-pressed={session.tool === 'pan'}
          onClick={() => setTool(tabId, 'pan')}
        >
          {t('hotspots.focus.pan')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!imageSize || viewport.width <= 0 || viewport.height <= 0}
          onClick={() =>
            imageSize &&
            setCamera(tabId, {
              zoom: fitImageStageZoom(viewport, imageSize, 'native'),
              pan: { x: 0, y: 0 },
            })
          }
        >
          {t('hotspots.focus.fit')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCamera(tabId, { zoom: 1, pan: { x: 0, y: 0 } })}
        >
          {t('hotspots.focus.native')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={session.history.past.length === 0}
          onClick={() => undo(tabId)}
        >
          {t('hotspots.focus.undo')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={session.history.future.length === 0}
          onClick={() => redo(tabId)}
        >
          {t('hotspots.focus.redo')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => discard(tabId)}>
          {t('hotspots.focus.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => commit(tabId)}>
          {t('hotspots.focus.done')}
        </Button>
      </div>
      {!imageSize ? (
        <div className="p-4 text-sm text-destructive">{t('hotspots.invalidImage')}</div>
      ) : (
        <HotspotImageStage
          className="min-h-0 flex-1"
          imageUrl={imageUrl}
          imageSize={imageSize}
          zoomBasis="native"
          hotspots={hotspots.flatMap((item) =>
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
          selectedHotspotId={session.selectedHotspotId}
          tool={session.tool}
          camera={session.camera}
          alphaVisualization={session.mode === 'sprite-alpha'}
          onViewportChange={setViewport}
          onSelectionChange={(selectedHotspotId) => setSelection(tabId, selectedHotspotId)}
          onCameraChange={(camera) => setCamera(tabId, camera)}
          onCreate={(bounds) => {
            if (!canDraw) return;
            add(tabId, createHotspot(nextId(), nextInputOrder(), bounds));
          }}
          onCancelCreate={() => setTool(tabId, 'select')}
          onCommitBounds={(id, bounds) => setBounds(tabId, id, bounds)}
          onDelete={(id) => remove(tabId, id)}
        />
      )}
    </div>
  );
}
