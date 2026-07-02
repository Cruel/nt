import { useComfyUiStore } from './comfyui-store';

function dotClass(state: ReturnType<typeof useComfyUiStore.getState>['status']['state']) {
  switch (state) {
    case 'ready': return 'bg-emerald-500';
    case 'error': return 'bg-red-500';
    case 'checking': return 'bg-yellow-500';
    case 'disabled':
    default: return 'bg-muted-foreground/40';
  }
}

function labelForState(state: ReturnType<typeof useComfyUiStore.getState>['status']['state']) {
  switch (state) {
    case 'ready': return 'ComfyUI ready';
    case 'error': return 'ComfyUI error';
    case 'checking': return 'ComfyUI checking';
    case 'disabled':
    default: return 'ComfyUI disabled';
  }
}

export function ComfyUiStatusIndicator() {
  const status = useComfyUiStore((state) => state.status);
  const progress = useComfyUiStore((state) => state.progress);
  const queueText = status.queueRemaining && status.queueRemaining > 0 ? ` • ${status.queueRemaining} queued` : '';
  const progressText = progress.progressValue !== null && progress.progressMax !== null
    ? ` • ${progress.progressValue}/${progress.progressMax}`
    : '';
  const title = [status.message, status.serverUrl, progress.message].filter(Boolean).join(' • ');
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground" title={title || undefined}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass(status.state)}`} />
      <span className="truncate">{labelForState(status.state)}{queueText}{progressText}</span>
    </span>
  );
}
