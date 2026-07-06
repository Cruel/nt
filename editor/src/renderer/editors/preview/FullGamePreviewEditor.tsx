import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Bug,
  Clipboard,
  Database,
  FastForward,
  MousePointer2,
  PackagePlus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  StepForward,
} from 'lucide-react';
import { EnginePreview, sanitizePreviewFpsCap, type EnginePreviewControlsContext } from '@/components/engine-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useProjectStore } from '@/project/project-store';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { isAuthoringProject, type AuthoringProject, type AuthoringRecordBase } from '../../../shared/project-schema/authoring-project';
import { parseVariableData } from '../../../shared/project-schema/authoring-variables';
import type { RuntimeDebugEntityRef, RuntimeDebugSnapshot, PreviewToEditorMessage } from '../../../shared/preview-protocol';

interface RuntimeLogEntry {
  id: string;
  label: string;
  detail?: string;
  severity: 'info' | 'warning' | 'error';
}

interface FullGamePreviewState {
  snapshot: RuntimeDebugSnapshot | null;
  eventLog: RuntimeLogEntry[];
}

function fallbackLabel(id: string | undefined, label: string | undefined) {
  return label || id || '—';
}

function recordFor(project: AuthoringProject | null, collection: keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'objects' | 'verbs' | 'actions' | 'maps' | 'dialogues' | 'scenes'>, id: string | undefined): AuthoringRecordBase | null {
  if (!project || !id) return null;
  return project[collection][id] ?? null;
}

function entityCollection(ref: RuntimeDebugEntityRef | undefined): keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'objects' | 'verbs' | 'actions' | 'maps' | 'dialogues' | 'scenes'> | null {
  if (!ref) return null;
  if (ref.collection === 'variables' || ref.collection === 'rooms' || ref.collection === 'objects' || ref.collection === 'verbs' || ref.collection === 'actions' || ref.collection === 'maps' || ref.collection === 'dialogues' || ref.collection === 'scenes') return ref.collection;
  if (ref.type === 'variable') return 'variables';
  if (ref.type === 'room') return 'rooms';
  if (ref.type === 'object') return 'objects';
  if (ref.type === 'verb') return 'verbs';
  if (ref.type === 'action') return 'actions';
  if (ref.type === 'map') return 'maps';
  if (ref.type === 'dialogue') return 'dialogues';
  if (ref.type === 'scene') return 'scenes';
  return null;
}

function labelEntity(project: AuthoringProject | null, ref: RuntimeDebugEntityRef | undefined) {
  const collection = entityCollection(ref);
  const record = collection ? recordFor(project, collection, ref?.id) : null;
  return fallbackLabel(ref?.id, record?.label ?? ref?.label);
}

function labelById(project: AuthoringProject | null, collection: keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'objects' | 'verbs' | 'actions'>, id: string) {
  return fallbackLabel(id, recordFor(project, collection, id)?.label);
}

function stringifyValue(value: unknown) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function addLogEntry(entries: RuntimeLogEntry[], entry: Omit<RuntimeLogEntry, 'id'>): RuntimeLogEntry[] {
  return [{ ...entry, id: `${Date.now()}-${entries.length}` }, ...entries].slice(0, 80);
}

function previewMessageLabel(message: PreviewToEditorMessage): Omit<RuntimeLogEntry, 'id'> | null {
  if (message.type === 'runtime-debug-snapshot') {
    return { label: 'Runtime snapshot refreshed', detail: message.snapshot.waiting.reason ?? message.snapshot.waiting.kind, severity: 'info' };
  }
  if (message.type === 'preview-diagnostic') {
    return { label: message.diagnostic.message, detail: message.diagnostic.path, severity: message.diagnostic.severity };
  }
  if (message.type === 'runtime-error') return { label: message.message, severity: 'error' };
  if (message.type === 'object-clicked') return { label: 'Object clicked', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-object-selected') return { label: 'Preview object selected', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-interacted') return { label: 'Preview interaction', detail: message.interaction, severity: 'info' };
  if (message.type === 'fps-counter') return null;
  if (message.type === 'command-result') return null;
  return null;
}

function InfoRow({ label, value }: { label: string; value: string | number | boolean | undefined | null }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-40 truncate text-right font-medium">{value === undefined || value === null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="rounded-none border-x-0 border-t-0 shadow-none">
      <CardHeader className="px-3 py-2">
        <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-3 pb-3 pt-0">{children}</CardContent>
    </Card>
  );
}

function RuntimeSummaryPanel({ snapshot, project }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null }) {
  return (
    <Panel title="Runtime summary" icon={<Bug className="h-3.5 w-3.5" />}>
      <div className="flex flex-wrap gap-1">
        <Badge variant={snapshot?.loaded ? 'default' : 'secondary'}>{snapshot?.loaded ? 'Loaded' : 'Unloaded'}</Badge>
        <Badge variant={snapshot?.running ? 'default' : 'secondary'}>{snapshot?.running ? 'Running' : 'Stopped'}</Badge>
        <Badge variant={snapshot?.waiting.kind === 'error' ? 'destructive' : 'outline'}>{snapshot?.waiting.kind ?? 'No snapshot'}</Badge>
      </div>
      <div className="space-y-1">
        <InfoRow label="Shell mode" value={snapshot?.shellMode} />
        <InfoRow label="Runtime mode" value={snapshot?.runtimeMode} />
        <InfoRow label="Entrypoint" value={labelEntity(project, snapshot?.entrypoint)} />
        <InfoRow label="Current entity" value={labelEntity(project, snapshot?.currentEntity)} />
        <InfoRow label="Room" value={snapshot?.currentRoomId ? labelById(project, 'rooms', snapshot.currentRoomId) : undefined} />
        <InfoRow label="Dialogue" value={snapshot?.currentDialogueId ? fallbackLabel(snapshot.currentDialogueId, project?.dialogues[snapshot.currentDialogueId]?.label) : undefined} />
        <InfoRow label="Waiting reason" value={snapshot?.waiting.reason} />
      </div>
    </Panel>
  );
}

function InputAvailabilityPanel({ snapshot, project, controlsContext, onCommand }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; onCommand: (command: Promise<void>, label: string) => void }) {
  const controller = controlsContext?.controller ?? null;
  const inputs = snapshot?.availableInputs;
  return (
    <Panel title="Available inputs" icon={<StepForward className="h-3.5 w-3.5" />}>
      <div className="flex flex-wrap gap-1">
        <Badge variant={inputs?.continue ? 'default' : 'secondary'}>Continue {inputs?.continue ? 'yes' : 'no'}</Badge>
        <Badge variant="outline">Choices {inputs?.dialogueOptions.length ?? 0}</Badge>
        <Badge variant="outline">Navigation {inputs?.navigation.length ?? 0}</Badge>
        <Badge variant="outline">Actions {inputs?.actions.length ?? 0}</Badge>
      </div>
      {inputs?.dialogueOptions.slice(0, 4).map((option) => (
        <Button key={option.index} size="sm" variant="outline" className="w-full justify-start" disabled={!option.enabled || !controller} onClick={() => controller && onCommand(controller.selectDialogueOption(option.index), `Dialogue option ${option.index} sent`)}>
          Choice {option.index}: {option.label}
        </Button>
      ))}
      {inputs?.navigation.slice(0, 4).map((direction) => (
        <Button key={direction.index} size="sm" variant="outline" className="w-full justify-start" disabled={!direction.enabled || !controller} onClick={() => controller && onCommand(controller.navigateRuntime(direction.index), `Navigate ${direction.index} sent`)}>
          Navigate {direction.index}: {direction.label}
        </Button>
      ))}
      {inputs?.actions.slice(0, 4).map((action) => (
        <Button key={action.verbId} size="sm" variant="outline" className="w-full justify-start" disabled={!action.enabled || !controller} onClick={() => controller && onCommand(controller.runRuntimeAction(action.verbId, inputs.selectedObjects), `Action ${action.verbId} sent`)}>
          {labelById(project, 'verbs', action.verbId)} ({action.selectedCount}/{action.objectCount})
        </Button>
      ))}
    </Panel>
  );
}

function VariablesPanel({ snapshot, project }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null }) {
  const variables = snapshot?.variables ?? [];
  return (
    <Panel title="Variables" icon={<Database className="h-3.5 w-3.5" />}>
      {variables.length === 0 ? <div className="text-xs text-muted-foreground">No runtime variables in the latest snapshot.</div> : null}
      {variables.map((variable) => {
        const record = recordFor(project, 'variables', variable.id);
        const data = record ? parseVariableData(record.data) : null;
        return (
          <div key={variable.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{fallbackLabel(variable.id, record?.label ?? variable.label)}</span>
              <Badge variant={variable.dirty || variable.overridden ? 'default' : 'secondary'}>{variable.dirty || variable.overridden ? 'changed' : 'clean'}</Badge>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">{variable.id}</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <InfoRow label="Type" value={data?.type ?? variable.type} />
              <InfoRow label="Default" value={stringifyValue(data?.defaultValue ?? variable.defaultValue)} />
            </div>
            <Input className="mt-2 h-7 font-mono text-xs" readOnly value={stringifyValue(variable.value)} aria-label={`Variable ${variable.id} value`} />
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" disabled>Set value</Button>
              <Button size="sm" variant="ghost" disabled>Reset</Button>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

function InventoryPanel({ snapshot, project }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null }) {
  const inventory = snapshot?.inventory ?? [];
  return (
    <Panel title="Inventory" icon={<PackagePlus className="h-3.5 w-3.5" />}>
      <div className="flex gap-2">
        <Input className="h-7 text-xs" placeholder="Filter objects" readOnly />
        <Button size="sm" variant="secondary" disabled>Add</Button>
      </div>
      {inventory.length === 0 ? <div className="text-xs text-muted-foreground">Inventory is empty in the latest snapshot.</div> : null}
      {inventory.map((item) => (
        <div key={item.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{labelById(project, 'objects', item.id)}</span>
            {item.selected ? <Badge>selected</Badge> : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.id}</div>
          <InfoRow label="Location" value={labelEntity(project, item.location)} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" disabled>Remove</Button>
            <Button size="sm" variant="ghost" disabled>Move</Button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function RoomObjectToolsPanel({ snapshot, project }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null }) {
  const rooms = project ? Object.entries(project.rooms).slice(0, 6) : [];
  const objects = project ? Object.entries(project.objects).slice(0, 6) : [];
  return (
    <Panel title="Room and object tools" icon={<MousePointer2 className="h-3.5 w-3.5" />}>
      <InfoRow label="Current room" value={snapshot?.currentRoomId ? labelById(project, 'rooms', snapshot.currentRoomId) : undefined} />
      <div className="text-xs font-medium">Teleport placeholders</div>
      <div className="grid grid-cols-2 gap-1">
        {rooms.map(([id, room]) => <Button key={id} size="sm" variant="outline" disabled>{room.label || id}</Button>)}
      </div>
      <div className="text-xs font-medium">Object giver placeholders</div>
      <div className="grid grid-cols-2 gap-1">
        {objects.map(([id, object]) => <Button key={id} size="sm" variant="outline" disabled>{object.label || id}</Button>)}
      </div>
      <div className="text-[11px] text-muted-foreground">Mutation controls are placeholders until typed debug mutation commands land in the bridge.</div>
    </Panel>
  );
}

function SaveSnapshotPanel({ snapshot }: { snapshot: RuntimeDebugSnapshot | null }) {
  const json = snapshot ? stringifyValue(snapshot.saveSnapshot) : '{}';
  return (
    <Panel title="Save snapshot" icon={<Save className="h-3.5 w-3.5" />}>
      <Button size="sm" variant="outline" disabled={!snapshot} onClick={() => void navigator.clipboard?.writeText(json)}>
        <Clipboard className="h-3.5 w-3.5" />
        Copy JSON
      </Button>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">{json}</pre>
    </Panel>
  );
}

function EventLogPanel({ entries, diagnostics }: { entries: RuntimeLogEntry[]; diagnostics: RuntimeDebugSnapshot['diagnostics'] }) {
  return (
    <Panel title="Runtime event log">
      {diagnostics.slice(0, 8).map((diagnostic, index) => (
        <div key={`${diagnostic.message}-${index}`} className="rounded-md border p-2 text-xs">
          <Badge variant={diagnostic.severity === 'error' ? 'destructive' : diagnostic.severity === 'warning' ? 'secondary' : 'outline'}>{diagnostic.severity}</Badge>
          <div className="mt-1">{diagnostic.message}</div>
          {diagnostic.path ? <div className="font-mono text-[11px] text-muted-foreground">{diagnostic.path}</div> : null}
        </div>
      ))}
      {entries.length === 0 ? <div className="text-xs text-muted-foreground">No runtime events captured yet.</div> : null}
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant={entry.severity === 'error' ? 'destructive' : entry.severity === 'warning' ? 'secondary' : 'outline'}>{entry.severity}</Badge>
            <span>{entry.label}</span>
          </div>
          {entry.detail ? <div className="mt-1 font-mono text-[11px] text-muted-foreground">{entry.detail}</div> : null}
        </div>
      ))}
    </Panel>
  );
}

function RuntimeInspector({ state, project, controlsContext, onCommand }: { state: FullGamePreviewState; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; onCommand: (command: Promise<void>, label: string) => void }) {
  return (
    <aside className="flex w-[360px] min-w-[320px] max-w-[420px] shrink-0 flex-col overflow-auto border-l bg-background">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <div className="text-sm font-semibold">Runtime Inspector</div>
        <Badge variant="outline">Debug</Badge>
      </div>
      <RuntimeSummaryPanel snapshot={state.snapshot} project={project} />
      <InputAvailabilityPanel snapshot={state.snapshot} project={project} controlsContext={controlsContext} onCommand={onCommand} />
      <VariablesPanel snapshot={state.snapshot} project={project} />
      <InventoryPanel snapshot={state.snapshot} project={project} />
      <RoomObjectToolsPanel snapshot={state.snapshot} project={project} />
      <SaveSnapshotPanel snapshot={state.snapshot} />
      <EventLogPanel entries={state.eventLog} diagnostics={state.snapshot?.diagnostics ?? []} />
    </aside>
  );
}

function FullGamePreviewTransportBar({ context, onRuntimeCommand }: { context: EnginePreviewControlsContext; onRuntimeCommand: (command: Promise<void>, label: string, running?: boolean) => void }) {
  const runtimeDisabled = context.connectionState !== 'ready';

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Button size="sm" variant="ghost" onClick={context.reload} aria-label="Reload engine preview">
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onRuntimeCommand(context.controller.runtimeReset(), 'Runtime reset')} disabled={runtimeDisabled} aria-label="Reset runtime">
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.startRuntime(), 'Runtime started', true)} disabled={runtimeDisabled} aria-label="Start runtime">
        <Play className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.stopRuntime(), 'Runtime stopped', false)} disabled={runtimeDisabled} aria-label="Stop runtime">
        <Square className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.stepRuntime(), 'Runtime stepped')} disabled={runtimeDisabled} aria-label="Step runtime">
        <StepForward className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.continueRuntime(), 'Continue input sent')} disabled={runtimeDisabled}>
        <StepForward className="h-4 w-4" />
        Continue
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.continueRuntime(), 'Fast-forward requested')} disabled={runtimeDisabled}>
        <FastForward className="h-4 w-4" />
        Fast-forward
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.navigateRuntime(0), 'Navigate 0 sent')} disabled={runtimeDisabled}>Nav 0</Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.selectDialogueOption(0), 'Dialogue option 0 sent')} disabled={runtimeDisabled}>Choice 0</Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.selectRuntimeObject('lamp'), 'Object selection sent')} disabled={runtimeDisabled}>
        <MousePointer2 className="h-4 w-4" />
        Select
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.clearRuntimeObjectSelection(), 'Object selection cleared')} disabled={runtimeDisabled}>Clear</Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(context.controller.runRuntimeAction('look', []), 'Action input sent')} disabled={runtimeDisabled}>
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
  const projectDocument = useProjectStore((state) => state.document);
  const project = useMemo(() => isAuthoringProject(projectDocument) ? projectDocument : null, [projectDocument]);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const [state, setState] = useState<FullGamePreviewState>({ snapshot: null, eventLog: [] });
  const controlsRef = useRef<EnginePreviewControlsContext | null>(null);

  const requestDebugSnapshot = useCallback((context: EnginePreviewControlsContext | null) => {
    if (!context) return;
    void context.controller.requestRuntimeDebugSnapshot().catch((error: Error) => {
      setState((current) => ({
        ...current,
        eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }),
      }));
    });
  }, []);

  const handleRuntimeCommand = useCallback((command: Promise<void>, label: string, running?: boolean) => {
    if (running !== undefined) {
      setPreviewRunning(running);
      setPrimaryRuntimeReplay({
        position: useWorkspaceStore.getState().previewPosition,
        running,
      });
    }
    setState((current) => ({ ...current, eventLog: addLogEntry(current.eventLog, { label, severity: 'info' }) }));
    controlsRef.current?.sendRuntimeCommand(
      command.then(() => requestDebugSnapshot(controlsRef.current)),
      label,
    );
  }, [requestDebugSnapshot, setPreviewRunning, setPrimaryRuntimeReplay]);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    const logEntry = previewMessageLabel(message);
    setState((current) => ({
      snapshot: message.type === 'runtime-debug-snapshot' ? message.snapshot : current.snapshot,
      eventLog: logEntry ? addLogEntry(current.eventLog, logEntry) : current.eventLog,
    }));
    if (message.type === 'ready' || message.type === 'preview-interacted' || message.type === 'object-clicked' || message.type === 'preview-object-selected') {
      requestDebugSnapshot(controlsRef.current);
    }
  }, [requestDebugSnapshot]);

  return (
    <div className="flex h-full min-h-0 bg-background">
      <div className="min-w-0 flex-1">
        <EnginePreview
          onPreviewMessage={handlePreviewMessage}
          renderControls={(context) => {
            controlsRef.current = context;
            return <FullGamePreviewTransportBar context={context} onRuntimeCommand={handleRuntimeCommand} />;
          }}
        />
      </div>
      <RuntimeInspector state={state} project={project} controlsContext={controlsRef.current} onCommand={handleRuntimeCommand} />
    </div>
  );
}
