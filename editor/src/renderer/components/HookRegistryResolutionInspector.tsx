import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type {
  HookRegistryAnalysis,
  HookRegistryRegistration,
  RoomHookKind,
} from '../../shared/hook-registry-analysis';

interface HookRegistryResolutionInspectorProps {
  analysis: HookRegistryAnalysis;
  hook: RoomHookKind;
  target: string;
}

function RegistrationDetails({
  registration,
  testId,
}: {
  registration: HookRegistryRegistration;
  testId?: string;
}) {
  const { t } = useTranslation('workspace');
  return (
    <div
      className="space-y-1 rounded-md border bg-background/50 px-3 py-2 text-xs"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-foreground">{registration.selector.authored}</code>
        <span className="text-muted-foreground">→</span>
        <code className="font-mono text-foreground">
          {registration.moduleId}.{registration.exportName}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant="outline">
          {registration.source === 'direct-definition'
            ? t('hookRegistryResolution.source.direct')
            : t('hookRegistryResolution.source.bootstrap')}
        </Badge>
        <Badge variant="outline">{registration.capabilityProfile}</Badge>
        <span className="font-mono text-[11px]">{registration.sourcePath}</span>
      </div>
    </div>
  );
}

export function HookRegistryResolutionInspector({
  analysis,
  hook,
  target,
}: HookRegistryResolutionInspectorProps) {
  const { t } = useTranslation('workspace');
  const explanation = analysis.explain(hook, target);
  const conflictPaths = new Set(
    explanation.conflicts.map((registration) => registration.sourcePath),
  );
  const fallbacks = explanation.fallbacks.filter(
    (registration) => !conflictPaths.has(registration.sourcePath),
  );
  const summary = explanation.conflicts.length
    ? t('hookRegistryResolution.summary.ambiguous')
    : explanation.winner
      ? t('hookRegistryResolution.summary.resolved', {
          handler: `${explanation.winner.moduleId}.${explanation.winner.exportName}`,
        })
      : explanation.dynamicUncertainty
        ? t('hookRegistryResolution.summary.incomplete')
        : t('hookRegistryResolution.summary.none');

  return (
    <details className="md:col-span-3 rounded-md border bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-foreground">
        {summary}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="text-xs text-muted-foreground">
          {t('hookRegistryResolution.target')}{' '}
          <code className="font-mono text-foreground">{target}</code>
        </div>

        {explanation.dynamicUncertainty ? (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-0.5">
              <div className="text-xs font-medium">{t('hookRegistryResolution.dynamic.title')}</div>
              <div className="text-xs text-muted-foreground">
                {t('hookRegistryResolution.dynamic.description')}
              </div>
            </div>
          </div>
        ) : null}

        {explanation.winner ? (
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium">{t('hookRegistryResolution.winner')}</h4>
            <RegistrationDetails registration={explanation.winner} />
          </section>
        ) : null}

        {explanation.conflicts.length ? (
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium">{t('hookRegistryResolution.conflicts')}</h4>
            <div className="space-y-1.5">
              {explanation.conflicts.map((registration) => (
                <RegistrationDetails
                  key={registration.sourcePath}
                  registration={registration}
                  testId="hook-registry-conflict"
                />
              ))}
            </div>
          </section>
        ) : null}

        {fallbacks.length ? (
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium">{t('hookRegistryResolution.fallbacks')}</h4>
            <div className="space-y-1.5">
              {fallbacks.map((registration) => (
                <RegistrationDetails
                  key={`fallback:${registration.sourcePath}`}
                  registration={registration}
                  testId="hook-registry-fallback"
                />
              ))}
            </div>
          </section>
        ) : null}

        {!explanation.winner && !explanation.conflicts.length ? (
          <div className="text-xs text-muted-foreground">
            {explanation.dynamicUncertainty
              ? t('hookRegistryResolution.noStaticWinner')
              : t('hookRegistryResolution.noMatch')}
          </div>
        ) : null}
      </div>
    </details>
  );
}
