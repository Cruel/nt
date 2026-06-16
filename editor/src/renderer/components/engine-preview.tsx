import { useCallback, useEffect } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEnginePreview } from '@/hooks/use-engine-preview';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

const BUILD_COMMAND = 'pnpm engine:preview:build';

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function EnginePreview() {
  const previewPosition = useWorkspaceStore((s) => s.previewPosition);
  const connectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setPreviewPosition = useWorkspaceStore((s) => s.setPreviewPosition);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const setConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const setSelectedRuntimeObjectId = useWorkspaceStore((s) => s.setSelectedRuntimeObjectId);
  const setLastPreviewEvent = useWorkspaceStore((s) => s.setLastPreviewEvent);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    setLastPreviewEvent(message);
    if (message.type === 'object-clicked' && message.objectId === 'demo-triangle') {
      setSelectedRuntimeObjectId(message.objectId);
      setStatusMessage('Selected demo-triangle from engine preview');
    } else if (message.type === 'runtime-error') {
      setConnectionState('error');
      setStatusMessage(message.message);
    }
  }, [setConnectionState, setLastPreviewEvent, setSelectedRuntimeObjectId, setStatusMessage]);

  const controller = useEnginePreview({
    onReady: () => {
      setConnectionState('ready');
      setStatusMessage('Engine preview ready');
      void controller.setPosition(useWorkspaceStore.getState().previewPosition).catch(() => undefined);
      void (useWorkspaceStore.getState().previewRunning ? controller.play() : controller.stop()).catch(() => undefined);
    },
    onMessage: handlePreviewMessage,
    onError: (message) => {
      setConnectionState('error');
      setStatusMessage(message);
    },
  });
  const {
    iframeRef,
    iframeKey,
    session,
    loadSession,
    setPosition,
    play: sendPlay,
    stop: sendStop,
  } = controller;

  useEffect(() => {
    setConnectionState('loading');
    loadSession().catch((error: unknown) => {
      setConnectionState('missing');
      setStatusMessage(error instanceof Error ? error.message : 'Engine preview build not found.');
    });
  }, [loadSession, setConnectionState, setStatusMessage]);

  useEffect(() => {
    const handlePlay = () => {
      setPreviewRunning(true);
      void sendPlay().catch((error: Error) => {
        setConnectionState('error');
        setStatusMessage(error.message);
      });
    };
    const handleStop = () => {
      setPreviewRunning(false);
      void sendStop().catch((error: Error) => {
        setConnectionState('error');
        setStatusMessage(error.message);
      });
    };
    window.addEventListener('noveltea-preview-toolbar-play', handlePlay);
    window.addEventListener('noveltea-preview-toolbar-stop', handleStop);
    return () => {
      window.removeEventListener('noveltea-preview-toolbar-play', handlePlay);
      window.removeEventListener('noveltea-preview-toolbar-stop', handleStop);
    };
  }, [sendPlay, sendStop, setConnectionState, setPreviewRunning, setStatusMessage]);

  const updatePosition = useCallback((position: PreviewPosition) => {
    const next = { x: clamp01(position.x), y: clamp01(position.y) };
    setPreviewPosition(next);
    void setPosition(next).catch((error: Error) => {
      setConnectionState('error');
      setStatusMessage(error.message);
    });
  }, [setConnectionState, setPosition, setPreviewPosition, setStatusMessage]);

  const reload = () => {
    setConnectionState('loading');
    void loadSession(true).catch((error: unknown) => {
      setConnectionState('missing');
      setStatusMessage(error instanceof Error ? error.message : 'Engine preview build not found.');
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Button size="sm" variant="ghost" onClick={reload} aria-label="Reload engine preview">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => updatePosition({ x: previewPosition.x - 0.05, y: previewPosition.y })}>Left</Button>
        <Button size="sm" variant="outline" onClick={() => updatePosition({ x: previewPosition.x + 0.05, y: previewPosition.y })}>Right</Button>
        <Button size="sm" variant="outline" onClick={() => updatePosition({ x: previewPosition.x, y: previewPosition.y - 0.05 })}>Up</Button>
        <Button size="sm" variant="outline" onClick={() => updatePosition({ x: previewPosition.x, y: previewPosition.y + 0.05 })}>Down</Button>
        <Button size="sm" variant="ghost" onClick={() => updatePosition({ x: 0.5, y: 0.5 })} aria-label="Reset demo position">
          <RotateCcw className="h-4 w-4" />
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          X
          <Input className="h-7 w-20" type="number" min="0" max="1" step="0.01" value={previewPosition.x.toFixed(2)} onChange={(event) => updatePosition({ x: Number(event.target.value), y: previewPosition.y })} />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Y
          <Input className="h-7 w-20" type="number" min="0" max="1" step="0.01" value={previewPosition.y.toFixed(2)} onChange={(event) => updatePosition({ x: previewPosition.x, y: Number(event.target.value) })} />
        </label>
      </div>
      <div className="relative min-h-0 flex-1 bg-zinc-950">
        {session ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="NovelTea engine preview"
            src={session.url}
            sandbox="allow-scripts allow-same-origin"
            className="h-full w-full border-0"
            onLoad={() => setConnectionState('connecting')}
            onError={() => {
              setConnectionState('error');
              setStatusMessage('Engine preview iframe failed to load.');
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium">Engine preview build not found</div>
              <div className="mt-1 font-mono text-xs">{BUILD_COMMAND}</div>
            </div>
          </div>
        )}
        {connectionState !== 'ready' ? (
          <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {connectionState}
          </div>
        ) : null}
      </div>
    </div>
  );
}
