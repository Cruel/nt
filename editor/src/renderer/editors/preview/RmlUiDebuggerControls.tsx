import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DevtoolsSnapshot } from '../../../shared/preview-protocol';
import type { EnginePreviewControlsContext } from '@/components/engine-preview';
import { Switch } from '@/components/ui/switch';
import { usePreferencesStore } from '@/stores/preferences-store';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function RmlUiDebuggerControls({
  snapshot,
  controls,
  supported,
}: {
  snapshot: DevtoolsSnapshot | null;
  controls: EnginePreviewControlsContext | null;
  supported: boolean;
}) {
  const { t } = useTranslation('workspace');
  const showEmptyContexts = usePreferencesStore((state) => state.showEmptyRmlUiContexts);
  const controller = controls?.connectionState === 'ready' ? controls.controller : null;
  useEffect(() => {
    if (!supported || !controller) return;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        await controller.requestDevtoolsSnapshot();
      } catch {
        /* Transport owns disconnect diagnostics. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [controller, supported]);
  const debuggerState = snapshot?.rmluiDebugger;
  const availableContexts =
    snapshot?.rmlui.filter((context) => showEmptyContexts || context.hasInspectableDocuments) ?? [];
  const selectedContext =
    availableContexts.find((context) => context.name === debuggerState?.context) ??
    availableContexts[0];
  const disabled = !controller || !debuggerState?.available || !selectedContext;
  const update = (visible: boolean, context: string) => {
    if (!controller) return;
    controls?.sendRuntimeCommand(
      controller.setRmlUiDebugger(visible, context),
      t('rmluiDebugger.title'),
    );
  };
  useEffect(() => {
    if (
      !showEmptyContexts &&
      debuggerState?.visible &&
      selectedContext &&
      selectedContext.name !== debuggerState.context &&
      controller
    ) {
      controls?.sendRuntimeCommand(
        controller.setRmlUiDebugger(true, selectedContext.name),
        t('rmluiDebugger.title'),
      );
    }
  }, [
    controller,
    controls,
    debuggerState?.context,
    debuggerState?.visible,
    selectedContext,
    showEmptyContexts,
    t,
  ]);
  if (!supported) return null;
  return (
    <section className="space-y-2 border-b p-3">
      <label className="flex items-center justify-between gap-2 text-xs font-medium">
        {t('rmluiDebugger.title')}
        <Switch
          disabled={disabled}
          checked={debuggerState?.visible ?? false}
          onCheckedChange={(visible) => update(visible, selectedContext?.name ?? '')}
        />
      </label>
      <Select
        items={availableContexts.map((context) => ({ value: context.name, label: context.label }))}
        value={selectedContext?.name ?? null}
        disabled={disabled}
        onValueChange={(context) => {
          if (context) update(debuggerState?.visible ?? false, context);
        }}
      >
        <SelectTrigger className="w-full" aria-label={t('rmluiDebugger.context')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {availableContexts.map((context) => (
            <SelectItem key={context.name} value={context.name}>
              {context.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
