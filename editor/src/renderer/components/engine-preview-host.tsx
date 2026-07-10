import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PreviewConnectionState } from '../../shared/preview-protocol';
import { fitPreviewRect, referencePreviewSize, type PreviewScalingMode } from '../../shared/preview-display';
import type { ProjectDisplaySettings } from '../../shared/project-schema/authoring-project-settings';

const BUILD_COMMAND = 'pnpm engine:preview:build';

interface EnginePreviewHostProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  iframeKey: number;
  iframeSrc: string | null;
  embedded: boolean;
  connectionState: PreviewConnectionState;
  onActivateContainingGroup: (groupId?: string) => void;
  onConnecting: () => void;
  onError: (message: string) => void;
  className?: string;
  iframeClassName?: string;
  showConnectionOverlay?: boolean;
  displayProfile?: ProjectDisplaySettings;
  scalingMode?: PreviewScalingMode;
  referenceLongAxis?: number;
}

export function EnginePreviewHost({
  iframeRef,
  iframeKey,
  iframeSrc,
  embedded,
  connectionState,
  onActivateContainingGroup,
  onConnecting,
  onError,
  className = 'relative min-h-0 flex-1 bg-zinc-950',
  iframeClassName = 'h-full w-full border-0',
  showConnectionOverlay = !embedded,
  displayProfile,
  scalingMode = 'responsive',
  referenceLongAxis = 1280,
}: EnginePreviewHostProps) {
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = previewHostRef.current;
    if (!element) return undefined;
    const update = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (!window.ResizeObserver) {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new window.ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function handleWindowBlur() {
      window.setTimeout(() => {
        // Parent window blur is the browser-level signal for focus moving into the iframe.
        if (document.activeElement === iframeRef.current) {
          const groupElement = previewHostRef.current?.closest<HTMLElement>('[data-workbench-group-id]');
          onActivateContainingGroup(groupElement?.dataset.workbenchGroupId);
        }
      }, 0);
    }
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, [iframeRef, onActivateContainingGroup]);

  function scheduleContainingWorkbenchGroupActivation() {
    window.setTimeout(() => {
      const groupElement = previewHostRef.current?.closest<HTMLElement>('[data-workbench-group-id]');
      const groupId = groupElement?.dataset.workbenchGroupId;
      if (groupId) onActivateContainingGroup(groupId);
    }, 0);
  }

  return (
    <div ref={previewHostRef} className={className} style={displayProfile ? { backgroundColor: displayProfile.barColor } : undefined}>
      {iframeSrc ? (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          title="NovelTea engine preview"
          src={iframeSrc}
          sandbox="allow-scripts allow-same-origin"
          className={iframeClassName}
          style={displayProfile && bounds.width > 0 && bounds.height > 0 ? (() => {
            const rect = fitPreviewRect(bounds.width, bounds.height, displayProfile);
            if (scalingMode === 'reference') {
              const size = referencePreviewSize(displayProfile, referenceLongAxis);
              return { position: 'absolute', left: rect.x, top: rect.y, width: size.width, height: size.height, transformOrigin: 'top left', transform: `scale(${Math.min(rect.width / size.width, rect.height / size.height)})` };
            }
            return { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height };
          })() : undefined}
          onPointerDown={scheduleContainingWorkbenchGroupActivation}
          onFocus={scheduleContainingWorkbenchGroupActivation}
          onLoad={onConnecting}
          onError={() => onError('Engine preview iframe failed to load.')}
        />
      ) : connectionState === 'missing' || connectionState === 'error' ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          <div>
            <div className="font-medium">Engine preview build not found</div>
            <div className="mt-1 font-mono text-xs">{BUILD_COMMAND}</div>
          </div>
        </div>
      ) : null}
      {showConnectionOverlay && connectionState !== 'ready' ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {connectionState}
        </div>
      ) : null}
    </div>
  );
}
