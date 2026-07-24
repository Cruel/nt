import { useCallback, useEffect, useRef } from 'react';
import type { EnginePreviewControlsContext } from '@/components/engine-preview';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { AssetProfilerPollingController } from './asset-profiler-controller';

export function useAssetProfilerPolling({
  controls,
  supported,
}: {
  controls: EnginePreviewControlsContext | null;
  supported: boolean;
}) {
  const bottomPanelVisible = useBottomPanelStore((state) => state.visible);
  const activePanelId = useBottomPanelStore((state) => state.activePanelId);
  const controllerRef = useRef<AssetProfilerPollingController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new AssetProfilerPollingController();

  useEffect(() => {
    controllerRef.current!.setTransport({
      key: controls?.controller.session?.sessionToken ?? controls?.controller ?? null,
      request: controls?.controller.requestAssetProfiler ?? null,
      connected: controls?.connectionState === 'ready',
      supported,
    });
  }, [controls, supported]);

  useEffect(() => {
    controllerRef.current!.setPanelVisible(
      bottomPanelVisible && activePanelId === 'asset-performance',
    );
  }, [activePanelId, bottomPanelVisible]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  return {
    notifyProjectReplaced: useCallback(() => controllerRef.current?.notifyProjectReplaced(), []),
  };
}
