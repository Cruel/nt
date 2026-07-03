import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { useComfyUiQueueStore } from './comfyui-queue-store';
import { cancelComfyUiJob } from './comfyui-service';
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

function progressPercent(value: number | null, max: number | null) {
  return value !== null && max !== null && max > 0 ? Math.round((value / max) * 100) : null;
}

export function ComfyUiStatusIndicator() {
  const status = useComfyUiStore((state) => state.status);
  const progress = useComfyUiStore((state) => state.progress);
  const config = useComfyUiStore((state) => state.config);
  const jobsByPromptId = useComfyUiQueueStore((state) => state.jobsByPromptId);
  const order = useComfyUiQueueStore((state) => state.order);
  const markInterrupted = useComfyUiQueueStore((state) => state.markInterrupted);
  const removeJob = useComfyUiQueueStore((state) => state.removeJob);
  const clearFinished = useComfyUiQueueStore((state) => state.clearFinished);
  const jobs = order.map((promptId) => jobsByPromptId[promptId]).filter(Boolean);
  const activeJobs = jobs.filter((job) => canCancel(job.state));
  const finishedJobs = jobs.filter((job) => !canCancel(job.state));
  const queueCount = activeJobs.length;
  const queueText = queueCount > 0 ? ` • ${queueCount} active` : status.queueRemaining && status.queueRemaining > 0 ? ` • ${status.queueRemaining} queued` : '';
  const progressText = progress.progressValue !== null && progress.progressMax !== null
    ? ` • ${progress.progressValue}/${progress.progressMax}`
    : '';
  const title = [status.message, status.serverUrl, progress.message].filter(Boolean).join(' • ');

  async function cancel(promptId: string) {
    const job = useComfyUiQueueStore.getState().jobsByPromptId[promptId];
    if (job?.state === 'queued') {
      removeJob(promptId);
      return;
    }
    markInterrupted(promptId);
    await cancelComfyUiJob(config);
  }

  function displayState(state: string) {
    if (state === 'interrupted') return 'Canceled';
    return state;
  }

  function canCancel(state: string) {
    return state === 'queued' || state === 'running' || state === 'finalizing';
  }

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title={title || undefined}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass(status.state)}`} />
        <span className="truncate">{labelForState(status.state)}{queueText}{progressText}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-96 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <PopoverTitle className="text-xs">ComfyUI Queue</PopoverTitle>
          {finishedJobs.length > 0 ? <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => clearFinished()}>Clear</Button> : null}
        </div>
        {jobs.length === 0 ? <div className="text-xs text-muted-foreground">No active or queued ComfyUI jobs.</div> : null}
        {activeJobs.length === 0 && finishedJobs.length > 0 ? <div className="mb-2 text-xs text-muted-foreground">No active jobs. Finished/canceled items are retained for review.</div> : null}
        <div className="space-y-2">
          {jobs.map((job) => {
            const percent = progressPercent(job.progressValue, job.progressMax);
            return (
              <div key={job.promptId} className="rounded border p-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{job.workflowLabel}</div>
                    <div className="truncate text-muted-foreground">{job.promptSummary}</div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">{displayState(job.state)}{job.currentNode ? ` • node ${job.currentNode}` : ''}</div>
                  </div>
                  {canCancel(job.state) ? <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => void cancel(job.promptId)}>Cancel</Button> : null}
                </div>
                {percent !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-foreground" style={{ width: `${percent}%` }} /></div> : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
