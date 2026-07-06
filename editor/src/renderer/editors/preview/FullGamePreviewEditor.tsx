import { MousePointer2, Play, RefreshCw, RotateCcw, Square, StepForward } from 'lucide-react';
import { EnginePreview, sanitizePreviewFpsCap, type EnginePreviewControlsContext } from '@/components/engine-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

function FullGamePreviewTransportBar({ context }: { context: EnginePreviewControlsContext }) {
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const runtimeDisabled = context.connectionState !== 'ready';

  function setRuntimeRunning(running: boolean) {
    setPreviewRunning(running);
    setPrimaryRuntimeReplay({
      position: useWorkspaceStore.getState().previewPosition,
      running,
    });
  }

  function sendRuntimeCommand(command: Promise<void>, label: string, running?: boolean) {
    if (running !== undefined) setRuntimeRunning(running);
    context.sendRuntimeCommand(command, label);
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Button size="sm" variant="ghost" onClick={context.reload} aria-label="Reload engine preview">
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => sendRuntimeCommand(context.controller.runtimeReset(), 'Runtime reset')} disabled={runtimeDisabled} aria-label="Reset runtime">
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.startRuntime(), 'Runtime started', true)} disabled={runtimeDisabled} aria-label="Start runtime">
        <Play className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.stopRuntime(), 'Runtime stopped', false)} disabled={runtimeDisabled} aria-label="Stop runtime">
        <Square className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.stepRuntime(), 'Runtime stepped')} disabled={runtimeDisabled} aria-label="Step runtime">
        <StepForward className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.continueRuntime(), 'Continue input sent')} disabled={runtimeDisabled}>
        <StepForward className="h-4 w-4" />
        Continue
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.navigateRuntime(0), 'Navigate 0 sent')} disabled={runtimeDisabled}>Nav 0</Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.selectDialogueOption(0), 'Dialogue option 0 sent')} disabled={runtimeDisabled}>Choice 0</Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.selectRuntimeObject('lamp'), 'Object selection sent')} disabled={runtimeDisabled}>
        <MousePointer2 className="h-4 w-4" />
        Select
      </Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.clearRuntimeObjectSelection(), 'Object selection cleared')} disabled={runtimeDisabled}>Clear</Button>
      <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(context.controller.runRuntimeAction('look', []), 'Action input sent')} disabled={runtimeDisabled}>
        <MousePointer2 className="h-4 w-4" />
        Action
      </Button>
      <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        Cap
        <Input className="h-7 w-16" type="number" min="0" max="1000" step="1" value={context.fpsCap} onChange={(event) => context.setFpsCap(sanitizePreviewFpsCap(Number(event.target.value)))} />
      </label>
    </div>
  );
}

export function FullGamePreviewEditor() {
  return <EnginePreview renderControls={(context) => <FullGamePreviewTransportBar context={context} />} />;
}
