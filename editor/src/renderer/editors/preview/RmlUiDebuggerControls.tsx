import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DevtoolsSnapshot } from '../../../shared/preview-protocol';
import type { EnginePreviewControlsContext } from '@/components/engine-preview';
import { Switch } from '@/components/ui/switch';
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
  if (!supported) return null;
  const debuggerState = snapshot?.rmluiDebugger;
  const disabled = !controller || !debuggerState?.available;
  const update = (visible: boolean, context: string) => {
    if (!controller) return;
    controls?.sendRuntimeCommand(
      controller.setRmlUiDebugger(visible, context),
      t('rmluiDebugger.title'),
    );
  };
  return (
    <section className="space-y-2 border-b p-3">
      <label className="flex items-center justify-between gap-2 text-xs font-medium">
        {t('rmluiDebugger.title')}
        <Switch
          disabled={disabled}
          checked={debuggerState?.visible ?? false}
          onCheckedChange={(visible) => update(visible, debuggerState?.context ?? '')}
        />
      </label>
      <Select
        value={debuggerState?.context ?? ''}
        disabled={disabled}
        onValueChange={(context) => {
          if (context) update(debuggerState?.visible ?? false, context);
        }}
      >
        <SelectTrigger className="w-full" aria-label={t('rmluiDebugger.context')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {snapshot?.rmlui.map((context) => (
            <SelectItem key={context.name} value={context.name}>
              {context.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
