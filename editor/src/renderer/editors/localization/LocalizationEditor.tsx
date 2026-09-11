import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { useCurrentAuthoringDependencyGraphSnapshot } from '@/project/authoring-dependency-graph-runtime';
import { useProjectStore } from '@/project/project-store';
import { renameMessageValueReferencePatches } from '@/project/localization-message-operations';
import { recordSaveUnitId, SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import type { SaveUnitId } from '@/project/save-unit-types';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import {
  findAuthoringDependencyUsages,
  localizationMessageNodeKey,
} from '../../../shared/authoring-dependency-graph';
import {
  namedMessageKeySchema,
  type AuthoringMessage,
} from '../../../shared/project-schema/authoring-localization';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowViews,
  type LocalizationMessageWorkflowView,
} from '../../../shared/authoring-localization-workflow';
import {
  applyLocalizationReconciliation,
  planLocalizationReconciliation,
} from '../../../shared/authoring-localization-reconcile';

type Surface = 'overview' | 'translations' | 'languages' | 'messages' | 'reconciliation';

const surfaces: readonly { id: Surface; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'translations', label: 'Translations' },
  { id: 'languages', label: 'Languages' },
  { id: 'messages', label: 'Messages' },
  { id: 'reconciliation', label: 'Reconciliation' },
];

function escapeJsonPointerToken(value: string) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function translationRecordPath(locale: string, messageId: string) {
  const encodedLocale = escapeJsonPointerToken(locale);
  const encodedMessageId = escapeJsonPointerToken(messageId);
  return `/localization/translations/${encodedLocale}/${encodedMessageId}`;
}

function canonicalLocale(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

function displayLocale(locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function hasMeaningfulLocaleWork(translations: Record<string, Record<string, unknown>>) {
  return Object.values(translations).some((entries) => Object.keys(entries).length > 0);
}

function originLabel(origin: 'human' | 'ai' | 'imported' | 'unknown') {
  if (origin === 'ai') return 'AI';
  return origin[0]!.toUpperCase() + origin.slice(1);
}

function reviewLabel(review: 'needs-review' | 'reviewed') {
  return review === 'reviewed' ? 'Reviewed' : 'Needs review';
}

function fieldPatch(
  message: AuthoringMessage,
  field: 'key' | 'source' | 'context' | 'translatorNote',
  value: string,
) {
  if (field === 'key' && message.kind !== 'named') return null;
  if (field === 'context' || field === 'translatorNote') {
    if (!value && field in message) return { op: 'remove' as const };
    if (!value) return null;
    return { op: field in message ? ('replace' as const) : ('add' as const), value };
  }
  return { op: 'replace' as const, value };
}

interface MessageDraft {
  key: string;
  source: string;
  context: string;
  translatorNote: string;
}

const emptyDraft = (): MessageDraft => ({ key: '', source: '', context: '', translatorNote: '' });

function messageLabel(message: AuthoringMessage, messageId: string) {
  return message.kind === 'named' ? message.key : message.source || messageId;
}

interface MessageView extends LocalizationMessageWorkflowView {
  message: AuthoringMessage;
}

export function LocalizationEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const document = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const graphSnapshot = useCurrentAuthoringDependencyGraphSnapshot();
  const project = isAuthoringProject(document) ? document : null;
  const [surface, setSurface] = useState<Surface>('overview');
  const [newLocale, setNewLocale] = useState('');
  const [localeError, setLocaleError] = useState<string | null>(null);
  const [creatingMessage, setCreatingMessage] = useState(false);
  const [messageDraft, setMessageDraft] = useState<MessageDraft>(emptyDraft);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [reconciliationDecisions, setReconciliationDecisions] = useState<Record<string, string>>(
    {},
  );
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const targetLocales = project
    ? Object.keys(project.localization.locales)
        .filter((locale) => locale !== project.localization.sourceLocale)
        .sort((a, b) => a.localeCompare(b))
    : [];
  const [targetLocale, setTargetLocale] = useState<string>('');
  const effectiveTargetLocale = targetLocales.includes(targetLocale)
    ? targetLocale
    : (targetLocales[0] ?? '');

  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        schema: 'noveltea.editor.localization-tab-state',
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: 'noveltea.editor.localization-tab-state',
          payload: { surface, targetLocale: effectiveTargetLocale },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== 'noveltea.editor.localization-tab-state') return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const restored = payload as Record<string, unknown>;
          if (surfaces.some((entry) => entry.id === restored.surface))
            setSurface(restored.surface as Surface);
          if (typeof restored.targetLocale === 'string') setTargetLocale(restored.targetLocale);
        },
      }),
      [effectiveTargetLocale, surface],
    ),
  );

  if (!project)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open a project to manage localization.
      </div>
    );

  const localization = project.localization;
  const localeEntries = Object.entries(localization.locales).sort(([a], [b]) => a.localeCompare(b));
  const namedMessages = Object.entries(localization.messages)
    .filter(
      (entry): entry is [string, Extract<AuthoringMessage, { kind: 'named' }>] =>
        entry[1].kind === 'named',
    )
    .sort(([, a], [, b]) => a.key.localeCompare(b.key));
  const allMessages = localizationMessageWorkflowViews(project)
    .map(
      (workflow): MessageView => ({
        ...workflow,
        message: {
          kind: workflow.kind,
          ...(workflow.kind === 'named' ? { key: workflow.key! } : {}),
          source: workflow.source,
          ...(workflow.context === undefined ? {} : { context: workflow.context }),
          ...(workflow.translatorNote === undefined
            ? {}
            : { translatorNote: workflow.translatorNote }),
        } as AuthoringMessage,
      }),
    )
    .sort((left, right) =>
      messageLabel(left.message, left.id).localeCompare(messageLabel(right.message, right.id)),
    );
  const sourceChangeBlocked = hasMeaningfulLocaleWork(localization.translations);
  const reconciliationPlan = planLocalizationReconciliation(project);

  function run(
    label: string,
    patches: unknown[],
    originSaveUnitId: SaveUnitId = SAVE_UNIT_IDS.localization,
  ) {
    const result = executeCommand({
      type: 'project.applyPatch',
      label,
      payload: patches,
      originSaveUnitId,
      persistencePolicy: 'manual-save',
    });
    return (
      result.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? null
    );
  }

  function addLanguage() {
    const locale = canonicalLocale(newLocale);
    if (!locale) {
      setLocaleError('Enter a valid BCP 47 locale tag.');
      return;
    }
    if (Object.hasOwn(localization.locales, locale)) {
      setLocaleError(`${locale} already exists.`);
      return;
    }
    const error = run(`Add locale ${locale}`, [
      {
        op: 'add',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}`,
        value: { supported: false, parentLocale: null },
      },
    ]);
    setLocaleError(error);
    if (!error) {
      setNewLocale('');
      setTargetLocale(locale);
    }
  }

  function removeLanguage(locale: string) {
    if (locale === localization.sourceLocale || locale === localization.defaultLocale) return;
    const patches: unknown[] = [];
    if (Object.hasOwn(localization.translations, locale))
      patches.push({
        op: 'remove',
        path: `/localization/translations/${escapeJsonPointerToken(locale)}`,
      });
    patches.push({ op: 'remove', path: `/localization/locales/${escapeJsonPointerToken(locale)}` });
    for (const [childLocale, definition] of Object.entries(localization.locales)) {
      if (definition.parentLocale === locale)
        patches.unshift({
          op: 'replace',
          path: `/localization/locales/${escapeJsonPointerToken(childLocale)}/parentLocale`,
          value: null,
        });
    }
    run(`Remove locale ${locale}`, patches);
  }

  function setSupported(locale: string, supported: boolean) {
    if (!supported && locale === localization.defaultLocale) return;
    run(`${supported ? 'Support' : 'Un-support'} locale ${locale}`, [
      {
        op: 'replace',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}/supported`,
        value: supported,
      },
    ]);
  }

  function setDefaultLocale(locale: string) {
    if (!localization.locales[locale]?.supported) return;
    run(`Set default locale ${locale}`, [
      { op: 'replace', path: '/localization/defaultLocale', value: locale },
    ]);
  }

  function setSourceLocale(locale: string) {
    if (sourceChangeBlocked || locale === localization.sourceLocale) return;
    run(`Set source locale ${locale}`, [
      { op: 'replace', path: '/localization/sourceLocale', value: locale },
    ]);
  }

  function setParentLocale(locale: string, parentLocale: string | null) {
    run(`Set parent locale for ${locale}`, [
      {
        op: 'replace',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}/parentLocale`,
        value: parentLocale,
      },
    ]);
  }

  function updateMessageDraft(field: keyof MessageDraft, value: string) {
    setMessageDraft((draft) => ({ ...draft, [field]: value }));
  }

  function createNamedMessage() {
    const key = messageDraft.key.trim();
    const parsedKey = namedMessageKeySchema.safeParse(key);
    if (!parsedKey.success) {
      setMessageError(parsedKey.error.issues[0]?.message ?? 'Enter a valid semantic key.');
      return;
    }
    if (namedMessages.some(([, message]) => message.key === key)) {
      setMessageError(`${key} already exists.`);
      return;
    }
    const messageId = crypto.randomUUID();
    const value: Record<string, string> = {
      kind: 'named',
      key,
      source: messageDraft.source,
    };
    if (messageDraft.context) value.context = messageDraft.context;
    if (messageDraft.translatorNote) value.translatorNote = messageDraft.translatorNote;
    const error = run(`Create named Message ${key}`, [
      {
        op: 'add',
        path: `/localization/messages/${escapeJsonPointerToken(messageId)}`,
        value,
      },
    ]);
    setMessageError(error);
    if (!error) {
      setMessageDraft(emptyDraft());
      setCreatingMessage(false);
    }
  }

  function updateMessageField(
    messageId: string,
    message: AuthoringMessage,
    field: 'key' | 'source' | 'context' | 'translatorNote',
    value: string,
  ) {
    const trimmed = field === 'key' ? value.trim() : value;
    if (field === 'key') {
      const parsed = namedMessageKeySchema.safeParse(trimmed);
      if (!parsed.success) return;
      if (
        namedMessages.some(
          ([candidateId, candidate]) => candidateId !== messageId && candidate.key === trimmed,
        )
      )
        return;
    }
    const patch = fieldPatch(message, field, trimmed);
    if (!patch) return;
    const referencePatches =
      field === 'key' && message.kind === 'named'
        ? renameMessageValueReferencePatches(project!, message.key, trimmed)
        : [];
    run(`Update Message ${messageLabel(message, messageId)}`, [
      ...referencePatches,
      {
        ...patch,
        path: `/localization/messages/${escapeJsonPointerToken(messageId)}/${field}`,
      },
    ]);
  }

  function setSourceContent(view: MessageView, value: string) {
    if (!view.sourceEditPath) return;
    if (view.sourceEditPath.startsWith('/localization/messages/')) {
      updateMessageField(view.id, view.message, 'source', value);
      return;
    }
    const recordMatch = /^\/([^/]+)\/([^/]+)\//.exec(view.sourceEditPath);
    const originSaveUnitId = view.sourceEditPath.startsWith('/settings/')
      ? SAVE_UNIT_IDS.projectSettings
      : recordMatch
        ? recordSaveUnitId(recordMatch[1]!, recordMatch[2]!)
        : SAVE_UNIT_IDS.localization;
    run(
      `Update source Message ${messageLabel(view.message, view.id)}`,
      [{ op: 'replace', path: view.sourceEditPath, value }],
      originSaveUnitId,
    );
  }

  function setTranslation(view: MessageView, value: string) {
    const locale = effectiveTargetLocale;
    if (!locale) return;
    const localeTranslations = localization.translations[locale];
    const existing = localeTranslations?.[view.id];
    const localePath = `/localization/translations/${escapeJsonPointerToken(locale)}`;
    const messagePath = `${localePath}/${escapeJsonPointerToken(view.id)}`;
    if (!value) {
      if (existing === undefined) return;
      run(`Clear ${locale} translation`, [{ op: 'remove', path: messagePath }]);
      return;
    }
    if (existing?.text === value) return;
    const translation = createLocalizationTranslation(view, value, 'human');
    if (!localeTranslations) {
      run(`Translate Message to ${locale}`, [
        { op: 'add', path: localePath, value: { [view.id]: translation } },
      ]);
      return;
    }
    run(`Translate Message to ${locale}`, [
      { op: existing === undefined ? 'add' : 'replace', path: messagePath, value: translation },
    ]);
  }

  function acceptTranslation(view: MessageView) {
    const locale = effectiveTargetLocale;
    const existing = localization.translations[locale]?.[view.id];
    if (!locale || !existing) return;
    const path = translationRecordPath(locale, view.id);
    run(`Accept ${locale} translation`, [
      {
        op: 'replace',
        path: `${path}/sourceFingerprint`,
        value: view.sourceFingerprint,
      },
    ]);
  }

  function reviewTranslation(view: MessageView) {
    const locale = effectiveTargetLocale;
    const existing = localization.translations[locale]?.[view.id];
    if (!locale || !existing || existing.sourceFingerprint !== view.sourceFingerprint) return;
    const path = translationRecordPath(locale, view.id);
    run(`Review ${locale} translation`, [
      {
        op: 'replace',
        path: `${path}/review`,
        value: 'reviewed',
      },
    ]);
  }

  function applyReconciliation() {
    const result = applyLocalizationReconciliation(
      project!,
      reconciliationPlan,
      reconciliationDecisions,
    );
    if (result.status === 'stale') {
      setReconciliationError(t('localizationReconciliation.staleError'));
      setReconciliationDecisions({});
      return;
    }
    if (result.status === 'needs-decision') {
      setReconciliationError(t('localizationReconciliation.decisionError'));
      return;
    }
    const error = run(t('localizationReconciliation.commandLabel'), [
      {
        op: 'replace',
        path: '/localization/sourceMessageTracking',
        value: result.project.localization.sourceMessageTracking,
      },
      {
        op: 'replace',
        path: '/localization/orphanedMessages',
        value: result.project.localization.orphanedMessages,
      },
      {
        op: 'replace',
        path: '/localization/translations',
        value: result.project.localization.translations,
      },
    ]);
    setReconciliationError(error);
    if (!error) setReconciliationDecisions({});
  }

  function usagePaths(messageId: string) {
    if (!graphSnapshot) return [];
    return [
      ...new Set(
        Object.keys(localization.locales).flatMap((locale) =>
          findAuthoringDependencyUsages(
            graphSnapshot.graph,
            localizationMessageNodeKey(locale, messageId),
          ).map((edge) => edge.sourcePath),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b px-4 pt-4">
        <h2 className="text-lg font-semibold">Localization</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Manage languages, Messages, and target translations without editing raw localization keys
          or catalogs.
        </p>
        <div className="flex gap-1" role="navigation" aria-label="Localization surfaces">
          {surfaces.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              size="sm"
              variant={surface === entry.id ? 'secondary' : 'ghost'}
              onClick={() => setSurface(entry.id)}
            >
              {entry.id === 'reconciliation' ? t('localizationReconciliation.tab') : entry.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {surface === 'overview' && (
          <div className="grid gap-3 @3xl:grid-cols-3">
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">Source locale</div>
              <div className="mt-1 text-lg font-semibold">{localization.sourceLocale}</div>
            </section>
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">Default locale</div>
              <div className="mt-1 text-lg font-semibold">{localization.defaultLocale}</div>
            </section>
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">Translation progress</div>
              <div className="mt-1 text-lg font-semibold">
                {namedMessages.length} named · {targetLocales.length} targets
              </div>
            </section>
            <section className="rounded border p-4 @3xl:col-span-3">
              <h3 className="font-medium">Languages</h3>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                {localeEntries.map(([locale, definition]) => (
                  <span key={locale} className="rounded bg-muted px-2 py-1">
                    {locale} · {definition.supported ? 'Supported' : 'Work in progress'}
                  </span>
                ))}
              </div>
            </section>
          </div>
        )}

        {surface === 'reconciliation' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-medium">{t('localizationReconciliation.title')}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('localizationReconciliation.description')}
                </p>
              </div>
              <Button
                type="button"
                onClick={applyReconciliation}
                disabled={
                  !reconciliationPlan.deterministicChanged && reconciliationPlan.groups.length === 0
                }
              >
                {t('localizationReconciliation.apply')}
              </Button>
            </div>
            {reconciliationError && (
              <p className="text-sm text-destructive">{reconciliationError}</p>
            )}
            {reconciliationPlan.groups.length === 0 ? (
              <section className="rounded border p-4 text-sm text-muted-foreground">
                {t('localizationReconciliation.empty')}
              </section>
            ) : (
              reconciliationPlan.groups.map((group) => (
                <section key={group.id} className="space-y-3 rounded border p-4">
                  <div>
                    <div className="font-medium">
                      {group.requiresDecision
                        ? t('localizationReconciliation.decisionRequired')
                        : t('localizationReconciliation.safeDefault')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('localizationReconciliation.counts', {
                        current: group.currentOccurrences.length,
                        previous: group.previousOccurrences.length,
                      })}
                    </p>
                  </div>
                  {group.currentOccurrences.map((occurrence) => (
                    <div
                      key={occurrence.id}
                      className="grid gap-2 rounded bg-muted/40 p-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] @3xl:items-center"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {occurrence.sourceSnapshot}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {occurrence.sourcePath} ·{' '}
                          {t('localizationReconciliation.occurrence', {
                            ordinal: occurrence.ordinal,
                          })}
                        </div>
                      </div>
                      <Select
                        value={
                          reconciliationDecisions[occurrence.id] ??
                          (group.requiresDecision ? undefined : '__new__')
                        }
                        onValueChange={(value) => {
                          if (!value) return;
                          setReconciliationDecisions((current) => ({
                            ...current,
                            [occurrence.id]: value === '__new__' ? 'new' : value,
                          }));
                        }}
                      >
                        <SelectTrigger
                          aria-label={t('localizationReconciliation.resolutionAria', {
                            path: occurrence.sourcePath,
                            ordinal: occurrence.ordinal,
                          })}
                        >
                          <SelectValue
                            placeholder={t('localizationReconciliation.chooseResolution')}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__new__">
                            {t('localizationReconciliation.createNew')}
                          </SelectItem>
                          {group.previousOccurrences.map((previous) => (
                            <SelectItem key={previous.messageId} value={previous.messageId}>
                              {t(
                                previous.valuable
                                  ? 'localizationReconciliation.relinkPreservesWork'
                                  : 'localizationReconciliation.relink',
                                { source: previous.sourceSnapshot || previous.messageId },
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  {group.currentOccurrences.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t('localizationReconciliation.disappeared')}
                    </p>
                  )}
                </section>
              ))
            )}
          </div>
        )}

        {surface === 'languages' && (
          <div className="space-y-5">
            <section className="grid gap-4 rounded border p-4 @3xl:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="source-locale">Source locale</Label>
                <Select
                  value={localization.sourceLocale}
                  onValueChange={(value) => {
                    if (value) setSourceLocale(value);
                  }}
                  disabled={sourceChangeBlocked}
                >
                  <SelectTrigger id="source-locale" aria-label="Source locale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {localeEntries.map(([locale]) => (
                      <SelectItem key={locale} value={locale}>
                        {locale}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sourceChangeBlocked ? (
                  <p className="text-xs text-muted-foreground">
                    Source locale migration is outside v1 after target translation work exists.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Source may be changed during initial setup before target translation work
                    exists.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-locale">Default locale</Label>
                <Select
                  value={localization.defaultLocale}
                  onValueChange={(value) => {
                    if (value) setDefaultLocale(value);
                  }}
                >
                  <SelectTrigger id="default-locale" aria-label="Default locale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {localeEntries
                      .filter(([, definition]) => definition.supported)
                      .map(([locale]) => (
                        <SelectItem key={locale} value={locale}>
                          {locale}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Default must be a Supported locale.</p>
              </div>
            </section>

            <section className="rounded border p-4">
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-52 flex-1 space-y-1">
                  <Label htmlFor="new-locale">New locale</Label>
                  <Input
                    id="new-locale"
                    aria-label="New locale"
                    value={newLocale}
                    onChange={(event) => setNewLocale(event.currentTarget.value)}
                    placeholder="fr-CA"
                  />
                </div>
                <Button type="button" onClick={addLanguage}>
                  <Plus className="size-4" /> Add language
                </Button>
              </div>
              {localeError && <p className="mb-3 text-sm text-destructive">{localeError}</p>}
              <div className="divide-y rounded border">
                {localeEntries.map(([locale, definition]) => {
                  const roleLocked =
                    locale === localization.sourceLocale ||
                    locale === localization.defaultLocale ||
                    definition.supported;
                  return (
                    <div
                      key={locale}
                      data-testid={`locale-row-${locale}`}
                      className="grid gap-3 p-3 @3xl:grid-cols-[minmax(10rem,1fr)_9rem_minmax(10rem,1fr)_auto] @3xl:items-center"
                    >
                      <div>
                        <div className="font-medium">{displayLocale(locale)}</div>
                        <div className="font-mono text-xs text-muted-foreground">{locale}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label="Supported"
                          checked={definition.supported}
                          disabled={locale === localization.defaultLocale}
                          onCheckedChange={(checked) => setSupported(locale, checked)}
                        />
                        <span className="text-sm">Supported</span>
                      </div>
                      <Select
                        value={definition.parentLocale ?? '__none__'}
                        onValueChange={(value) =>
                          setParentLocale(locale, value === '__none__' ? null : value)
                        }
                      >
                        <SelectTrigger aria-label={`Parent locale for ${locale}`}>
                          <SelectValue placeholder="No parent" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No parent</SelectItem>
                          {localeEntries
                            .filter(([candidate]) => candidate !== locale)
                            .map(([candidate]) => (
                              <SelectItem key={candidate} value={candidate}>
                                {candidate}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={roleLocked}
                        onClick={() => removeLanguage(locale)}
                        aria-label={`Remove ${locale}`}
                      >
                        <Trash2 className="size-4" /> Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {surface === 'messages' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">Named Messages</h3>
                <p className="text-xs text-muted-foreground">
                  Reusable Messages have semantic keys; usage is derived from Project references.
                </p>
              </div>
              <Button type="button" onClick={() => setCreatingMessage(true)}>
                <Plus className="size-4" /> New named message
              </Button>
            </div>
            {creatingMessage && (
              <section className="grid gap-3 rounded border p-4 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="new-message-key">Semantic key</Label>
                  <Input
                    id="new-message-key"
                    aria-label="Semantic key"
                    value={messageDraft.key}
                    onChange={(event) => updateMessageDraft('key', event.currentTarget.value)}
                    placeholder="ui.menu.play"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-source">Source content</Label>
                  <Input
                    id="new-message-source"
                    aria-label="Source content"
                    value={messageDraft.source}
                    onChange={(event) => updateMessageDraft('source', event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-context">Context</Label>
                  <Input
                    id="new-message-context"
                    aria-label="Context"
                    value={messageDraft.context}
                    onChange={(event) => updateMessageDraft('context', event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-note">Translator note</Label>
                  <Input
                    id="new-message-note"
                    aria-label="Translator note"
                    value={messageDraft.translatorNote}
                    onChange={(event) =>
                      updateMessageDraft('translatorNote', event.currentTarget.value)
                    }
                  />
                </div>
                {messageError && (
                  <p className="text-sm text-destructive @3xl:col-span-2">{messageError}</p>
                )}
                <div className="flex gap-2 @3xl:col-span-2">
                  <Button type="button" onClick={createNamedMessage}>
                    Create message
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setCreatingMessage(false);
                      setMessageError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            )}
            <div className="space-y-3">
              {namedMessages.length === 0 && !creatingMessage && (
                <div className="rounded border p-4 text-sm text-muted-foreground">
                  No named Messages yet.
                </div>
              )}
              {namedMessages.map(([messageId, message]) => {
                const usages = usagePaths(messageId);
                return (
                  <section
                    key={messageId}
                    className="grid gap-3 rounded border p-4 @3xl:grid-cols-2"
                  >
                    <div className="space-y-1">
                      <Label htmlFor={`message-key-${messageId}`}>Semantic key</Label>
                      <Input
                        id={`message-key-${messageId}`}
                        defaultValue={message.key}
                        onBlur={(event) =>
                          updateMessageField(messageId, message, 'key', event.currentTarget.value)
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`message-source-${messageId}`}>Source content</Label>
                      <Input
                        id={`message-source-${messageId}`}
                        defaultValue={message.source}
                        onBlur={(event) =>
                          updateMessageField(
                            messageId,
                            message,
                            'source',
                            event.currentTarget.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`message-context-${messageId}`}>Context</Label>
                      <Input
                        id={`message-context-${messageId}`}
                        defaultValue={message.context ?? ''}
                        onBlur={(event) =>
                          updateMessageField(
                            messageId,
                            message,
                            'context',
                            event.currentTarget.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`message-note-${messageId}`}>Translator note</Label>
                      <Input
                        id={`message-note-${messageId}`}
                        defaultValue={message.translatorNote ?? ''}
                        onBlur={(event) =>
                          updateMessageField(
                            messageId,
                            message,
                            'translatorNote',
                            event.currentTarget.value,
                          )
                        }
                      />
                    </div>
                    <div className="@3xl:col-span-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        Used in · {usages.length}
                      </div>
                      {usages.length > 0 ? (
                        <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                          {usages.slice(0, 5).map((path) => (
                            <div key={path}>{path}</div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-muted-foreground">No derived usages.</div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {surface === 'translations' && (
          <div className="space-y-4">
            <div className="max-w-sm space-y-1">
              <Label htmlFor="target-locale">Target locale</Label>
              <Select
                value={effectiveTargetLocale}
                onValueChange={(value) => {
                  if (value) setTargetLocale(value);
                }}
                disabled={targetLocales.length === 0}
              >
                <SelectTrigger id="target-locale" aria-label="Target locale">
                  <SelectValue placeholder="Add a target language first" />
                </SelectTrigger>
                <SelectContent>
                  {targetLocales.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {locale} · {displayLocale(locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!effectiveTargetLocale ? (
              <div className="rounded border p-4 text-sm text-muted-foreground">
                Add a target language on Languages to begin translating.
              </div>
            ) : allMessages.length === 0 ? (
              <div className="rounded border p-4 text-sm text-muted-foreground">
                No Messages are available yet.
              </div>
            ) : (
              <div className="space-y-3">
                {allMessages.map((view) => {
                  const { id: messageId, message } = view;
                  const label = messageLabel(message, messageId);
                  const translation =
                    localization.translations[effectiveTargetLocale]?.[messageId] ?? null;
                  const translated = translation?.text ?? '';
                  const freshness = !translation
                    ? 'Missing'
                    : translation.sourceFingerprint === view.sourceFingerprint
                      ? 'Current'
                      : 'Outdated';
                  const attention = translation
                    ? [
                        translation.acknowledgedPresentationFingerprint !== undefined &&
                        translation.acknowledgedPresentationFingerprint !==
                          view.presentationFingerprint
                          ? 'Presentation changed'
                          : null,
                        translation.acknowledgedGuidanceFingerprint !== undefined &&
                        translation.acknowledgedGuidanceFingerprint !== view.guidanceFingerprint
                          ? 'Guidance changed'
                          : null,
                      ].filter((value): value is string => value !== null)
                    : [];
                  return (
                    <section key={messageId} className="rounded border p-4">
                      <div className="mb-2 flex items-baseline justify-between gap-3">
                        <div className="font-medium">{label}</div>
                        <div className="text-right text-xs text-muted-foreground">
                          {freshness}
                          {translation
                            ? ` · ${originLabel(translation.origin)} · ${reviewLabel(translation.review)}`
                            : ''}
                          {attention.length > 0 ? ` · ${attention.join(', ')}` : ''}
                        </div>
                      </div>
                      {(message.context || message.translatorNote || view.usageNote) && (
                        <div className="mb-3 text-xs text-muted-foreground">
                          {message.context ? `Context: ${message.context}` : ''}
                          {message.context && (message.translatorNote || view.usageNote)
                            ? ' · '
                            : ''}
                          {message.translatorNote
                            ? `Translator note: ${message.translatorNote}`
                            : ''}
                          {message.translatorNote && view.usageNote ? ' · ' : ''}
                          {view.usageNote ? `Used in: ${view.usageNote}` : ''}
                        </div>
                      )}
                      <div className="grid gap-3 @3xl:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`source-${messageId}`}>
                            {localization.sourceLocale} source
                          </Label>
                          <Input
                            id={`source-${messageId}`}
                            key={`source:${messageId}:${message.source}`}
                            defaultValue={message.source}
                            disabled={!view.sourceEditPath}
                            onBlur={(event) => setSourceContent(view, event.currentTarget.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`target-${messageId}`}>
                            {effectiveTargetLocale} target
                          </Label>
                          <Input
                            id={`target-${messageId}`}
                            aria-label={`Target content for ${label}`}
                            key={`${effectiveTargetLocale}:${messageId}:${translated}`}
                            defaultValue={translated}
                            placeholder="Missing"
                            onBlur={(event) => setTranslation(view, event.currentTarget.value)}
                          />
                          {translation && (
                            <div className="flex gap-2 pt-1">
                              {translation.sourceFingerprint !== view.sourceFingerprint && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => acceptTranslation(view)}
                                >
                                  Accept current source
                                </Button>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={
                                  translation.sourceFingerprint !== view.sourceFingerprint ||
                                  translation.review === 'reviewed'
                                }
                                onClick={() => reviewTranslation(view)}
                              >
                                Mark reviewed
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
