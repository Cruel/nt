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
import {
  canPromoteLocalMessage,
  demoteNamedMessageUsage,
  identicalSourceReuseCandidates,
  mergeMessageIntoNamed,
  namedMessageUsages,
  promoteAndLinkLocalMessages,
  renameMessageValueReferencePatches,
} from '@/project/localization-message-operations';
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
  hasSubstantiveLocalizationWork,
  namedMessageKeySchema,
  type AuthoringMessage,
  type LocalizationAssetTarget,
  type LocalizationTranslation,
} from '../../../shared/project-schema/authoring-localization';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../../shared/project-schema/authoring-validation';
import {
  createLocalizationTranslation,
  createUseSourceLocalizationTarget,
  effectiveLocalizationTarget,
  localizationMessageWorkflowViews,
  localizationTargetWorkflowView,
  type LocalizationMessageWorkflowView,
} from '../../../shared/authoring-localization-workflow';
import {
  createLocalizedAssetVariant,
  isLocalizableAssetKind,
  localizationAssetWorkflowView,
} from '../../../shared/authoring-localized-assets';
import {
  applyLocalizationReconciliation,
  planLocalizationReconciliation,
} from '../../../shared/authoring-localization-reconcile';
import { PSEUDO_PREVIEW_LOCALE } from '../../../shared/pseudo-localization';

type Surface = 'overview' | 'translations' | 'assets' | 'languages' | 'messages' | 'reconciliation';
type TranslationFilter =
  | 'all'
  | 'missing'
  | 'outdated'
  | 'needs-review'
  | 'ai'
  | 'reviewed'
  | 'current'
  | 'attention';

const translationFilters: readonly TranslationFilter[] = [
  'all',
  'missing',
  'outdated',
  'needs-review',
  'ai',
  'reviewed',
  'current',
  'attention',
];

const surfaces: readonly Surface[] = [
  'overview',
  'translations',
  'assets',
  'languages',
  'messages',
  'reconciliation',
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

function localeDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const script = new Intl.Locale(locale).maximize().script;
    return script && ['Adlm', 'Arab', 'Hebr', 'Nkoo', 'Rohg', 'Syrc', 'Thaa'].includes(script)
      ? 'rtl'
      : 'ltr';
  } catch {
    return 'ltr';
  }
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
  const [promotionDraft, setPromotionDraft] = useState<{
    messageId: string;
    key: string;
    selectedIds: string[];
  } | null>(null);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [demotionDraft, setDemotionDraft] = useState<{
    messageId: string;
    usageId: string;
    copyDraftLocales: string[];
  } | null>(null);
  const [demotionError, setDemotionError] = useState<string | null>(null);
  const [mergeDraft, setMergeDraft] = useState<{
    sourceMessageId: string;
    targetMessageId: string;
    resolutions: Record<string, 'target' | 'source'>;
  } | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
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
  const [translationFilter, setTranslationFilter] = useState<TranslationFilter>('all');
  const effectiveTargetLocale = targetLocales.includes(targetLocale)
    ? targetLocale
    : (targetLocales[0] ?? '');
  const previewLocales = project
    ? Object.keys(project.localization.locales).sort((a, b) => a.localeCompare(b))
    : [];

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
          if (surfaces.some((entry) => entry === restored.surface))
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
        {t('localizationEditor.errors.openProject')}
      </div>
    );

  const localization = project.localization;
  const localeEntries = Object.entries(localization.locales).sort(([a], [b]) => a.localeCompare(b));
  const fontAssets = Object.values(project.assets)
    .filter((asset) => parseAssetData(asset.data)?.kind === 'font')
    .sort((a, b) => a.label.localeCompare(b.label));
  const localizableAssets = Object.entries(project.assets)
    .flatMap(([id, record]) => {
      const data = parseAssetData(record.data);
      return data && isLocalizableAssetKind(data.kind) ? [{ id, record, data }] : [];
    })
    .sort((left, right) => left.record.label.localeCompare(right.record.label));
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
  const filteredMessages = allMessages.filter((view) => {
    if (translationFilter === 'all' || !effectiveTargetLocale) return true;
    const target = localizationTargetWorkflowView(project, effectiveTargetLocale, view);
    if (translationFilter === 'attention') return target.attention.length > 0;
    if (translationFilter === target.freshness) return true;
    if (!target.translation) return false;
    return (
      translationFilter === target.translation.review ||
      translationFilter === target.translation.origin
    );
  });
  const sourceChangeBlocked =
    localization.sourceLocaleLock !== null || hasSubstantiveLocalizationWork(localization);
  const reconciliationPlan = planLocalizationReconciliation(project);
  const localizationValidationDiagnostics = validateAuthoringProject(project);

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

  function setPreviewLocale(locale: string | null) {
    executeCommand({
      type: 'project.applyPatch',
      label: t('localizationEditor.commands.setPreviewLocale'),
      payload: [
        {
          op: 'replace',
          path: '/editor/previewLocale',
          value: locale,
        },
      ],
      originSaveUnitId: 'editor-local:preview-locale',
      persistencePolicy: 'auto-commit',
    });
  }

  function addLanguage() {
    const locale = canonicalLocale(newLocale);
    if (!locale) {
      setLocaleError(t('localizationEditor.errors.invalidLocale'));
      return;
    }
    if (Object.hasOwn(localization.locales, locale)) {
      setLocaleError(t('localizationEditor.errors.localeExists', { locale }));
      return;
    }
    const error = run(t('localizationEditor.commands.addLocale', { locale }), [
      {
        op: 'add',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}`,
        value: { supported: false, parentLocale: null, fontStack: null },
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
    if (Object.hasOwn(localization.assets, locale))
      patches.push({
        op: 'remove',
        path: `/localization/assets/${escapeJsonPointerToken(locale)}`,
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
    run(t('localizationEditor.commands.removeLocale', { locale }), patches);
  }

  function setSupported(locale: string, supported: boolean) {
    if (!supported && locale === localization.defaultLocale) return;
    run(
      t(
        supported
          ? 'localizationEditor.commands.supportLocale'
          : 'localizationEditor.commands.unsupportLocale',
        { locale },
      ),
      [
        {
          op: 'replace',
          path: `/localization/locales/${escapeJsonPointerToken(locale)}/supported`,
          value: supported,
        },
      ],
    );
  }

  function setDefaultLocale(locale: string) {
    if (!localization.locales[locale]?.supported) return;
    run(t('localizationEditor.commands.setDefaultLocale', { locale }), [
      { op: 'replace', path: '/localization/defaultLocale', value: locale },
    ]);
  }

  function setSourceLocale(locale: string) {
    if (sourceChangeBlocked || locale === localization.sourceLocale) return;
    run(t('localizationEditor.commands.setSourceLocale', { locale }), [
      { op: 'replace', path: '/localization/sourceLocale', value: locale },
    ]);
  }

  function setParentLocale(locale: string, parentLocale: string | null) {
    run(t('localizationEditor.commands.setParentLocale', { locale }), [
      {
        op: 'replace',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}/parentLocale`,
        value: parentLocale,
      },
    ]);
  }

  function setLocaleFontStack(locale: string, assetIds: readonly string[] | null) {
    run(t('localizationEditor.commands.setFontStack', { locale }), [
      {
        op: 'replace',
        path: `/localization/locales/${escapeJsonPointerToken(locale)}/fontStack`,
        value:
          assetIds === null ? null : assetIds.map((id) => ({ $ref: { collection: 'assets', id } })),
      },
    ]);
  }

  function addLocaleFont(locale: string, assetId: string) {
    if (!assetId) return;
    const stack = localization.locales[locale]?.fontStack ?? [];
    const ids = stack.map((ref) => ref.$ref.id);
    if (!ids.includes(assetId)) setLocaleFontStack(locale, [...ids, assetId]);
  }

  function removeLocaleFont(locale: string, assetId: string) {
    const stack = localization.locales[locale]?.fontStack;
    if (!stack) return;
    setLocaleFontStack(
      locale,
      stack.map((ref) => ref.$ref.id).filter((id) => id !== assetId),
    );
  }

  function setLocalizedAssetTarget(
    locale: string,
    baseAssetId: string,
    target: LocalizationAssetTarget | null,
  ) {
    const encodedLocale = escapeJsonPointerToken(locale);
    const encodedAsset = escapeJsonPointerToken(baseAssetId);
    const localeTargets = localization.assets[locale];
    const existing = localeTargets?.[baseAssetId];
    if (target === null) {
      if (!existing) return;
      run(t('localizationEditor.commands.clearLocalizedAsset', { asset: baseAssetId, locale }), [
        { op: 'remove', path: `/localization/assets/${encodedLocale}/${encodedAsset}` },
      ]);
      return;
    }
    if (!localeTargets) {
      run(t('localizationEditor.commands.setLocalizedAsset', { asset: baseAssetId, locale }), [
        {
          op: 'add',
          path: `/localization/assets/${encodedLocale}`,
          value: { [baseAssetId]: target },
        },
      ]);
      return;
    }
    run(t('localizationEditor.commands.setLocalizedAsset', { asset: baseAssetId, locale }), [
      {
        op: existing ? 'replace' : 'add',
        path: `/localization/assets/${encodedLocale}/${encodedAsset}`,
        value: target,
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
      setMessageError(
        parsedKey.error.issues[0]?.message ?? t('localizationEditor.errors.invalidSemanticKey'),
      );
      return;
    }
    if (namedMessages.some(([, message]) => message.key === key)) {
      setMessageError(t('localizationEditor.errors.semanticKeyExists', { key }));
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
    const error = run(t('localizationEditor.commands.createNamedMessage', { key }), [
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
    run(
      t('localizationEditor.commands.updateMessage', { label: messageLabel(message, messageId) }),
      [
        ...referencePatches,
        {
          ...patch,
          path: `/localization/messages/${escapeJsonPointerToken(messageId)}/${field}`,
        },
      ],
    );
  }

  function promoteMessage() {
    if (!promotionDraft) return;
    const key = promotionDraft.key.trim();
    const parsed = namedMessageKeySchema.safeParse(key);
    if (!parsed.success) {
      setPromotionError(t('localizationMessageReuse.invalidKey'));
      return;
    }
    const result = promoteAndLinkLocalMessages(
      project!,
      promotionDraft.messageId,
      key,
      promotionDraft.selectedIds,
    );
    if (!result.ok) {
      setPromotionError(result.message);
      return;
    }
    const error = run(t('localizationMessageReuse.commandLabel', { key }), [...result.patches]);
    setPromotionError(error);
    if (!error) setPromotionDraft(null);
  }

  function demoteMessageUsage() {
    if (!demotionDraft) return;
    const usages = namedMessageUsages(project!, demotionDraft.messageId);
    const result = demoteNamedMessageUsage(
      project!,
      demotionDraft.messageId,
      demotionDraft.usageId,
      {
        ...(usages.length > 1 ? { newMessageId: crypto.randomUUID() } : {}),
        copyDraftLocales: demotionDraft.copyDraftLocales,
      },
    );
    if (!result.ok) {
      setDemotionError(result.message);
      return;
    }
    const error = run(t('localizationMessageReuse.demoteCommandLabel'), [...result.patches]);
    setDemotionError(error);
    if (!error) setDemotionDraft(null);
  }

  function mergeMessage() {
    if (!mergeDraft?.targetMessageId) return;
    const result = mergeMessageIntoNamed(
      project!,
      mergeDraft.sourceMessageId,
      mergeDraft.targetMessageId,
      mergeDraft.resolutions,
    );
    if (!result.ok) {
      setMergeError(result.message);
      return;
    }
    const error = run(t('localizationMessageReuse.mergeCommandLabel'), [...result.patches]);
    setMergeError(error);
    if (!error) setMergeDraft(null);
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
      t('localizationEditor.commands.updateSourceMessage', {
        label: messageLabel(view.message, view.id),
      }),
      [{ op: 'replace', path: view.sourceEditPath, value }],
      originSaveUnitId,
    );
  }

  function setUseSource(view: MessageView) {
    const locale = effectiveTargetLocale;
    if (!locale) return;
    const localeTranslations = localization.translations[locale];
    const existing = localeTranslations?.[view.id];
    const localePath = `/localization/translations/${escapeJsonPointerToken(locale)}`;
    const messagePath = `${localePath}/${escapeJsonPointerToken(view.id)}`;
    const target = createUseSourceLocalizationTarget(view);
    if (!localeTranslations) {
      run(t('localizationEditor.commands.useSource', { locale }), [
        { op: 'add', path: localePath, value: { [view.id]: target } },
      ]);
      return;
    }
    run(t('localizationEditor.commands.useSource', { locale }), [
      { op: existing === undefined ? 'add' : 'replace', path: messagePath, value: target },
    ]);
  }

  function overrideInheritedTarget(view: MessageView) {
    const locale = effectiveTargetLocale;
    if (!locale) return;
    const effective = effectiveLocalizationTarget(project!, locale, view.id);
    if (!effective.inherited || !effective.target) return;
    if (effective.target.useSource) {
      setTranslation(view, view.source);
      return;
    }
    const localeTranslations = localization.translations[locale];
    const localePath = `/localization/translations/${escapeJsonPointerToken(locale)}`;
    const messagePath = `${localePath}/${escapeJsonPointerToken(view.id)}`;
    const target = structuredClone(effective.target);
    if (!localeTranslations) {
      run(t('localizationEditor.commands.overrideInherited', { locale }), [
        { op: 'add', path: localePath, value: { [view.id]: target } },
      ]);
      return;
    }
    run(t('localizationEditor.commands.overrideInherited', { locale }), [
      { op: 'add', path: messagePath, value: target },
    ]);
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
      run(t('localizationEditor.commands.clearTranslation', { locale }), [
        { op: 'remove', path: messagePath },
      ]);
      return;
    }
    if (existing?.text === value) return;
    const translation = createLocalizationTranslation(view, value, 'human');
    if (existing?.pattern !== undefined) translation.pattern = structuredClone(existing.pattern);
    if (existing?.dialogueCues !== undefined)
      translation.dialogueCues = existing.dialogueCues.map((cue) => structuredClone(cue));
    if (!localeTranslations) {
      run(t('localizationEditor.commands.translateMessage', { locale }), [
        { op: 'add', path: localePath, value: { [view.id]: translation } },
      ]);
      return;
    }
    run(t('localizationEditor.commands.translateMessage', { locale }), [
      { op: existing === undefined ? 'add' : 'replace', path: messagePath, value: translation },
    ]);
  }

  function setDialogueCuePosition(
    view: MessageView,
    cueId: string,
    field: 'offset' | 'order',
    value: number,
  ) {
    const locale = effectiveTargetLocale;
    const existing = localization.translations[locale]?.[view.id];
    if (!locale || !existing || existing.useSource || !view.dialogueCues) return;
    const cues = (existing.dialogueCues ?? view.dialogueCues).map((cue) => structuredClone(cue));
    const index = cues.findIndex((cue) => cue.id === cueId);
    if (index < 0) return;
    if (cues[index]!.position[field] === value && existing.dialogueCues !== undefined) return;
    cues[index]!.position[field] = value;
    const path = `${translationRecordPath(locale, view.id)}/dialogueCues`;
    run(t('localizationEditor.commands.placeDialogueCue', { locale }), [
      { op: existing.dialogueCues === undefined ? 'add' : 'replace', path, value: cues },
    ]);
  }

  function dialogueCuesReviewable(view: MessageView, translation: LocalizationTranslation) {
    if (!view.dialogueCues) return translation.dialogueCues === undefined;
    const cues = translation.dialogueCues ?? [];
    if (
      cues.length !== view.dialogueCues.length ||
      cues.some((cue, index) => cue.id !== view.dialogueCues![index]?.id)
    )
      return false;
    const textLength = Array.from(translation.text).length;
    let previous: { offset: number; order: number } | null = null;
    for (const cue of cues) {
      if (cue.position.offset > textLength) return false;
      if (
        previous &&
        (cue.position.offset < previous.offset ||
          (cue.position.offset === previous.offset && cue.position.order <= previous.order))
      )
        return false;
      previous = cue.position;
    }
    return true;
  }

  function acceptTranslation(view: MessageView) {
    const locale = effectiveTargetLocale;
    const existing = localization.translations[locale]?.[view.id];
    if (!locale || !existing) return;
    const path = translationRecordPath(locale, view.id);
    run(t('localizationEditor.commands.acceptTranslation', { locale }), [
      {
        op: 'replace',
        path: `${path}/sourceFingerprint`,
        value: view.sourceFingerprint,
      },
    ]);
  }

  function translationReviewable(
    view: MessageView,
    locale: string,
    translation: LocalizationTranslation,
    validation = localizationValidationDiagnostics,
  ) {
    const path = translationRecordPath(locale, view.id);
    return (
      !translation.useSource &&
      translation.sourceFingerprint === view.sourceFingerprint &&
      dialogueCuesReviewable(view, translation) &&
      !validation.some(
        (diagnostic) => diagnostic.severity === 'error' && diagnostic.path.startsWith(path),
      )
    );
  }

  function reviewTranslation(view: MessageView) {
    const locale = effectiveTargetLocale;
    const existing = localization.translations[locale]?.[view.id];
    if (!locale || !existing || !translationReviewable(view, locale, existing)) return;
    const path = translationRecordPath(locale, view.id);
    run(t('localizationEditor.commands.reviewTranslation', { locale }), [
      {
        op: 'replace',
        path: `${path}/review`,
        value: 'reviewed',
      },
    ]);
  }

  function bulkReviewFiltered() {
    const locale = effectiveTargetLocale;
    if (!locale) return;
    const patches = filteredMessages.flatMap((view) => {
      const translation = localization.translations[locale]?.[view.id];
      if (
        !translation ||
        translation.review === 'reviewed' ||
        !translationReviewable(view, locale, translation)
      )
        return [];
      return [
        {
          op: 'replace',
          path: `${translationRecordPath(locale, view.id)}/review`,
          value: 'reviewed',
        },
      ];
    });
    if (patches.length > 0)
      run(t('localizationEditor.commands.reviewFiltered', { locale }), patches);
  }

  function setUsageNote(usageId: string, value: string) {
    const path = `/localization/usageNotes/${escapeJsonPointerToken(usageId)}`;
    const current = localization.usageNotes[usageId];
    const note = value.trim();
    if (!note) {
      if (current !== undefined)
        run(t('localizationEditor.commands.clearUsageNote'), [{ op: 'remove', path }]);
      return;
    }
    if (current === note) return;
    run(t('localizationEditor.commands.updateUsageNote'), [
      { op: current === undefined ? 'add' : 'replace', path, value: note },
    ]);
  }

  function setLocaleDisplayName(locale: string, value: string) {
    const path = `/localization/locales/${escapeJsonPointerToken(locale)}/displayName`;
    const current = localization.locales[locale]?.displayName;
    const trimmed = value.trim();
    if (!trimmed) {
      if (current !== undefined)
        run(t('localizationEditor.commands.clearDisplayName', { locale }), [
          { op: 'remove', path },
        ]);
      return;
    }
    if (current === trimmed) return;
    run(t('localizationEditor.commands.setDisplayName', { locale }), [
      { op: current === undefined ? 'add' : 'replace', path, value: trimmed },
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

  function renderMergeControls(
    sourceMessageId: string,
    sourceLabel: string,
    excludedTargetMessageId?: string,
  ) {
    const availableTargets = namedMessages.filter(([id]) => id !== excludedTargetMessageId);
    if (availableTargets.length === 0) return null;
    return (
      <div className="rounded border bg-muted/30 p-3 text-xs">
        {mergeDraft?.sourceMessageId === sourceMessageId ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`merge-target-${sourceMessageId}`}>
                {t('localizationMessageReuse.mergeIntoNamed')}
              </Label>
              <Select
                value={mergeDraft.targetMessageId}
                onValueChange={(value) => {
                  if (!value) return;
                  setMergeError(null);
                  setMergeDraft((current) =>
                    current && current.sourceMessageId === sourceMessageId
                      ? { ...current, targetMessageId: value, resolutions: {} }
                      : current,
                  );
                }}
              >
                <SelectTrigger
                  id={`merge-target-${sourceMessageId}`}
                  aria-label={t('localizationMessageReuse.mergeTargetAria', {
                    label: sourceLabel,
                  })}
                >
                  <SelectValue placeholder={t('localizationMessageReuse.selectNamed')} />
                </SelectTrigger>
                <SelectContent>
                  {availableTargets.map(([targetId, targetMessage]) => (
                    <SelectItem key={targetId} value={targetId}>
                      {targetMessage.key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mergeDraft.targetMessageId &&
              Object.keys(localization.locales).map((locale) => {
                const sourceTarget = localization.translations[locale]?.[sourceMessageId];
                const targetTarget =
                  localization.translations[locale]?.[mergeDraft.targetMessageId];
                if (
                  !sourceTarget ||
                  !targetTarget ||
                  JSON.stringify(sourceTarget) === JSON.stringify(targetTarget)
                )
                  return null;
                return (
                  <div key={locale} className="space-y-1 rounded border p-2">
                    <div className="font-medium">
                      {t('localizationMessageReuse.mergeConflict', { locale })}
                    </div>
                    <div className="text-muted-foreground">
                      {t('localizationMessageReuse.mergeConflictSummary', {
                        named: targetTarget.text,
                        local: sourceTarget.text,
                      })}
                    </div>
                    <Select
                      value={mergeDraft.resolutions[locale] ?? ''}
                      onValueChange={(value) => {
                        if (!value) return;
                        setMergeDraft((current) =>
                          current && current.sourceMessageId === sourceMessageId
                            ? {
                                ...current,
                                resolutions: {
                                  ...current.resolutions,
                                  [locale]: value as 'target' | 'source',
                                },
                              }
                            : current,
                        );
                      }}
                    >
                      <SelectTrigger
                        aria-label={t('localizationMessageReuse.mergeResolutionAria', {
                          locale,
                        })}
                      >
                        <SelectValue
                          placeholder={t('localizationMessageReuse.chooseTranslation')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="target">
                          {t('localizationMessageReuse.keepNamedTranslation')}
                        </SelectItem>
                        <SelectItem value="source">
                          {t('localizationMessageReuse.useLocalTranslation')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            {mergeError && <p className="text-destructive">{mergeError}</p>}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!mergeDraft.targetMessageId}
                onClick={mergeMessage}
              >
                {t('localizationMessageReuse.mergeMessage')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMergeDraft(null);
                  setMergeError(null);
                }}
              >
                {t('localizationMessageReuse.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setMergeError(null);
              setMergeDraft({
                sourceMessageId,
                targetMessageId: '',
                resolutions: {},
              });
            }}
          >
            {t('localizationMessageReuse.mergeIntoNamed')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b px-4 pt-4">
        <h2 className="text-lg font-semibold">{t('localizationEditor.title')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('localizationEditor.description')}</p>
        <div
          className="flex gap-1"
          role="navigation"
          aria-label={t('localizationEditor.surfacesAria')}
        >
          {surfaces.map((entry) => (
            <Button
              key={entry}
              type="button"
              size="sm"
              variant={surface === entry ? 'secondary' : 'ghost'}
              onClick={() => setSurface(entry)}
            >
              {entry === 'reconciliation'
                ? t('localizationReconciliation.tab')
                : t(`localizationEditor.surfaces.${entry}`)}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {surface === 'overview' && (
          <div className="grid gap-3 @3xl:grid-cols-3">
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">
                {t('localizationEditor.labels.sourceLocale')}
              </div>
              <div className="mt-1 text-lg font-semibold">{localization.sourceLocale}</div>
            </section>
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">
                {t('localizationEditor.labels.defaultLocale')}
              </div>
              <div className="mt-1 text-lg font-semibold">{localization.defaultLocale}</div>
            </section>
            <section className="rounded border p-4">
              <div className="text-xs font-medium text-muted-foreground">
                {t('localizationEditor.labels.translationProgress')}
              </div>
              <div className="mt-1 text-lg font-semibold">
                {t('localizationEditor.overview.progress', {
                  messages: namedMessages.length,
                  targets: targetLocales.length,
                })}
              </div>
            </section>
            <section className="rounded border p-4 @3xl:col-span-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t('localizationEditor.labels.previewLocale')}
              </div>
              <div className="mt-2 max-w-sm">
                <Select
                  value={project.editor.previewLocale ?? '__project_default__'}
                  onValueChange={(value) =>
                    setPreviewLocale(value === '__project_default__' ? null : value)
                  }
                >
                  <SelectTrigger aria-label={t('localizationEditor.labels.previewLocale')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__project_default__">
                      {t('localizationEditor.overview.projectDefault', {
                        locale: localization.defaultLocale,
                      })}
                    </SelectItem>
                    <SelectItem value={PSEUDO_PREVIEW_LOCALE}>
                      {t('localizationPreviewLocale.pseudoOption')}
                    </SelectItem>
                    {previewLocales.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {displayLocale(locale)} ({locale})
                        {localization.locales[locale]?.supported
                          ? ''
                          : t('localizationEditor.overview.localeWorkInProgress')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('localizationPreviewLocale.description')}
              </p>
            </section>
            <section className="rounded border p-4 @3xl:col-span-3">
              <h3 className="font-medium">{t('localizationEditor.labels.languages')}</h3>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                {localeEntries.map(([locale, definition]) => (
                  <span key={locale} className="rounded bg-muted px-2 py-1">
                    {locale} ·{' '}
                    {definition.supported
                      ? t('localizationEditor.status.supported')
                      : t('localizationEditor.status.workInProgress')}
                  </span>
                ))}
              </div>
            </section>
          </div>
        )}

        {surface === 'assets' && (
          <div className="space-y-4">
            <div className="max-w-sm space-y-1">
              <Label htmlFor="asset-target-locale">
                {t('localizationEditor.labels.targetLocale')}
              </Label>
              <Select
                value={effectiveTargetLocale}
                onValueChange={(value) => {
                  if (value) setTargetLocale(value);
                }}
                disabled={targetLocales.length === 0}
              >
                <SelectTrigger
                  id="asset-target-locale"
                  aria-label={t('localizationEditor.labels.localizedAssetTargetLocale')}
                >
                  <SelectValue placeholder={t('localizationEditor.assets.addTargetFirst')} />
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
                {t('localizationEditor.assets.emptyLocale')}
              </div>
            ) : localizableAssets.length === 0 ? (
              <div className="rounded border p-4 text-sm text-muted-foreground">
                {t('localizationEditor.assets.emptyAssets')}
              </div>
            ) : (
              <div className="space-y-3">
                {localizableAssets.map(({ id: baseAssetId, record, data }) => {
                  const view = localizationAssetWorkflowView(
                    project,
                    effectiveTargetLocale,
                    baseAssetId,
                  );
                  if (!view) return null;
                  const localTarget =
                    localization.assets[effectiveTargetLocale]?.[baseAssetId] ?? null;
                  const effectiveTarget = view.target;
                  const effectiveVariantId =
                    effectiveTarget && !('useSource' in effectiveTarget)
                      ? effectiveTarget.asset.$ref.id
                      : null;
                  const targetData = effectiveVariantId
                    ? parseAssetData(project.assets[effectiveVariantId]?.data)
                    : null;
                  const compatibleVariants = localizableAssets.filter(
                    (candidate) =>
                      candidate.id !== baseAssetId && candidate.data.kind === data.kind,
                  );
                  const stateLabel = !effectiveTarget
                    ? t('localizationEditor.status.missing')
                    : 'useSource' in effectiveTarget
                      ? t('localizationEditor.status.useSource')
                      : view.freshness === 'outdated'
                        ? t('localizationEditor.status.localizedOutdated')
                        : t('localizationEditor.status.localized');
                  const selectValue = !localTarget
                    ? '__missing__'
                    : 'useSource' in localTarget
                      ? '__source__'
                      : localTarget.asset.$ref.id;
                  return (
                    <section key={baseAssetId} className="rounded border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{record.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {baseAssetId} · {data.kind}
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          {stateLabel}
                          {view.inherited && view.effectiveLocale
                            ? ` · ${t('localizationEditor.status.inheritedFrom', { locale: view.effectiveLocale })}`
                            : ''}
                          {effectiveTarget && !('useSource' in effectiveTarget)
                            ? ` · ${t(`localizationEditor.status.${effectiveTarget.origin}`)} · ${t(
                                effectiveTarget.review === 'reviewed'
                                  ? 'localizationEditor.status.reviewed'
                                  : 'localizationEditor.status.needsReview',
                              )}`
                            : ''}
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 @3xl:grid-cols-2">
                        <div className="rounded bg-muted/30 p-3 text-xs">
                          <div className="font-medium">{t('localizationEditor.labels.source')}</div>
                          <div className="mt-1 break-all text-muted-foreground">
                            {data.source.path}
                          </div>
                          <div className="mt-1 break-all text-muted-foreground">
                            {data.contentHash ?? t('localizationEditor.assets.noContentHash')}
                          </div>
                        </div>
                        <div className="rounded bg-muted/30 p-3 text-xs">
                          <div className="font-medium">
                            {t('localizationEditor.labels.effectiveTarget')}
                          </div>
                          <div className="mt-1 break-all text-muted-foreground">
                            {!effectiveTarget
                              ? t('localizationEditor.status.missing')
                              : 'useSource' in effectiveTarget
                                ? data.source.path
                                : (targetData?.source.path ??
                                  effectiveVariantId ??
                                  t('localizationEditor.status.missing'))}
                          </div>
                          <div className="mt-1 break-all text-muted-foreground">
                            {!effectiveTarget
                              ? t('localizationEditor.assets.noLocalizedTarget')
                              : 'useSource' in effectiveTarget
                                ? (data.contentHash ?? t('localizationEditor.assets.noContentHash'))
                                : (targetData?.contentHash ??
                                  t('localizationEditor.assets.noContentHash'))}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 max-w-md space-y-1">
                        <Label htmlFor={`localized-asset-${baseAssetId}`}>
                          {t('localizationEditor.labels.localeRealization')}
                        </Label>
                        {view.inherited && !localTarget ? (
                          <div className="rounded border p-3 text-xs">
                            <p className="text-muted-foreground">
                              {t('localizationEditor.assets.inherited', {
                                locale: view.effectiveLocale,
                                target: effectiveTargetLocale,
                              })}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              className="mt-2"
                              onClick={() => {
                                if (!effectiveTarget) return;
                                if ('useSource' in effectiveTarget) {
                                  setLocalizedAssetTarget(effectiveTargetLocale, baseAssetId, {
                                    useSource: true,
                                  });
                                  return;
                                }
                                setLocalizedAssetTarget(effectiveTargetLocale, baseAssetId, {
                                  ...effectiveTarget,
                                  review: 'needs-review',
                                });
                              }}
                            >
                              {t('localizationEditor.assets.override', {
                                locale: effectiveTargetLocale,
                              })}
                            </Button>
                          </div>
                        ) : (
                          <Select
                            value={selectValue}
                            onValueChange={(value) => {
                              if (!value) return;
                              if (value === '__missing__') {
                                setLocalizedAssetTarget(effectiveTargetLocale, baseAssetId, null);
                                return;
                              }
                              if (value === '__source__') {
                                setLocalizedAssetTarget(effectiveTargetLocale, baseAssetId, {
                                  useSource: true,
                                });
                                return;
                              }
                              const variant = createLocalizedAssetVariant(
                                project,
                                baseAssetId,
                                value,
                              );
                              if (variant)
                                setLocalizedAssetTarget(
                                  effectiveTargetLocale,
                                  baseAssetId,
                                  variant,
                                );
                            }}
                          >
                            <SelectTrigger
                              id={`localized-asset-${baseAssetId}`}
                              aria-label={t('localizationEditor.assets.assetAria', {
                                label: record.label,
                              })}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__missing__">
                                {t('localizationEditor.status.missing')}
                              </SelectItem>
                              <SelectItem value="__source__">
                                {t('localizationEditor.status.useSource')}
                              </SelectItem>
                              {compatibleVariants.map((candidate) => (
                                <SelectItem key={candidate.id} value={candidate.id}>
                                  {candidate.record.label} · {candidate.data.source.path}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        {localTarget &&
                          !('useSource' in localTarget) &&
                          localTarget.review === 'needs-review' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setLocalizedAssetTarget(effectiveTargetLocale, baseAssetId, {
                                  ...localTarget,
                                  sourceFingerprint: view.sourceFingerprint,
                                  review: 'reviewed',
                                })
                              }
                            >
                              {t('localizationEditor.assets.markReviewed')}
                            </Button>
                          )}
                        {compatibleVariants.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            {t('localizationEditor.assets.noCompatible', { kind: data.kind })}
                          </p>
                        )}
                        {view.freshness === 'outdated' && (
                          <p className="text-xs text-destructive">
                            {t('localizationEditor.assets.baseChanged')}
                          </p>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
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
                <Label htmlFor="source-locale">{t('localizationEditor.labels.sourceLocale')}</Label>
                <Select
                  value={localization.sourceLocale}
                  onValueChange={(value) => {
                    if (value) setSourceLocale(value);
                  }}
                  disabled={sourceChangeBlocked}
                >
                  <SelectTrigger
                    id="source-locale"
                    aria-label={t('localizationEditor.labels.sourceLocale')}
                  >
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
                    {t('localizationEditor.languages.sourceLocked')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('localizationEditor.languages.sourceSetup')}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-locale">
                  {t('localizationEditor.labels.defaultLocale')}
                </Label>
                <Select
                  value={localization.defaultLocale}
                  onValueChange={(value) => {
                    if (value) setDefaultLocale(value);
                  }}
                >
                  <SelectTrigger
                    id="default-locale"
                    aria-label={t('localizationEditor.labels.defaultLocale')}
                  >
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
                <p className="text-xs text-muted-foreground">
                  {t('localizationEditor.languages.defaultSupported')}
                </p>
              </div>
            </section>

            <section className="rounded border p-4">
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-52 flex-1 space-y-1">
                  <Label htmlFor="new-locale">{t('localizationEditor.labels.newLocale')}</Label>
                  <Input
                    id="new-locale"
                    aria-label={t('localizationEditor.labels.newLocale')}
                    value={newLocale}
                    onChange={(event) => setNewLocale(event.currentTarget.value)}
                    placeholder="fr-CA"
                  />
                </div>
                <Button type="button" onClick={addLanguage}>
                  <Plus className="size-4" /> {t('localizationEditor.actions.addLanguage')}
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
                      className="grid gap-3 p-3 @3xl:grid-cols-[minmax(10rem,1fr)_9rem_minmax(10rem,1fr)_minmax(12rem,1.4fr)_auto] @3xl:items-center"
                    >
                      <div>
                        <div className="font-medium" lang={locale} dir={localeDirection(locale)}>
                          {definition.displayName ?? displayLocale(locale)}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">{locale}</div>
                        <Input
                          className="mt-2 h-8"
                          aria-label={t('localizationEditor.languages.displayNameAria', { locale })}
                          defaultValue={definition.displayName ?? ''}
                          placeholder={t('localizationEditor.languages.nativeDisplayName')}
                          onBlur={(event) =>
                            setLocaleDisplayName(locale, event.currentTarget.value)
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label={t('localizationEditor.labels.supported')}
                          checked={definition.supported}
                          disabled={locale === localization.defaultLocale}
                          onCheckedChange={(checked) => setSupported(locale, checked)}
                        />
                        <span className="text-sm">{t('localizationEditor.labels.supported')}</span>
                      </div>
                      <Select
                        value={definition.parentLocale ?? '__none__'}
                        onValueChange={(value) =>
                          setParentLocale(locale, value === '__none__' ? null : value)
                        }
                      >
                        <SelectTrigger
                          aria-label={t('localizationEditor.languages.parentAria', { locale })}
                        >
                          <SelectValue placeholder={t('localizationEditor.languages.noParent')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            {t('localizationEditor.languages.noParent')}
                          </SelectItem>
                          {localeEntries
                            .filter(([candidate]) => candidate !== locale)
                            .map(([candidate]) => (
                              <SelectItem key={candidate} value={candidate}>
                                {candidate}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <div
                        className="space-y-1"
                        data-workbench-anchor={`localization.locale.${locale}.fontStack`}
                      >
                        {definition.fontStack === null ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setLocaleFontStack(locale, [])}
                          >
                            {t('localizationEditor.languages.customFontStack')}
                          </Button>
                        ) : (
                          <>
                            <select
                              aria-label={t('localizationEditor.languages.addFallbackAria', {
                                locale,
                              })}
                              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                              value=""
                              onChange={(event) => {
                                addLocaleFont(locale, event.currentTarget.value);
                                event.currentTarget.value = '';
                              }}
                            >
                              <option value="">
                                {t('localizationEditor.languages.addFallback')}
                              </option>
                              {fontAssets
                                .filter(
                                  (asset) =>
                                    !definition.fontStack?.some((ref) => ref.$ref.id === asset.id),
                                )
                                .map((asset) => (
                                  <option key={asset.id} value={asset.id}>
                                    {asset.label} ({asset.id})
                                  </option>
                                ))}
                            </select>
                            <div className="flex flex-wrap gap-1">
                              {(definition.fontStack ?? []).map((ref) => (
                                <Button
                                  key={ref.$ref.id}
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => removeLocaleFont(locale, ref.$ref.id)}
                                  title={t('localizationEditor.languages.removeFallback')}
                                >
                                  {project.assets[ref.$ref.id]?.label ?? ref.$ref.id} ×
                                </Button>
                              ))}
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setLocaleFontStack(locale, null)}
                            >
                              {t('localizationEditor.languages.projectFontStack')}
                            </Button>
                          </>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={roleLocked}
                        onClick={() => removeLanguage(locale)}
                        aria-label={t('localizationEditor.languages.removeAria', { locale })}
                      >
                        <Trash2 className="size-4" /> {t('localizationEditor.actions.remove')}
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
                <h3 className="font-medium">{t('localizationEditor.messages.title')}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('localizationEditor.messages.description')}
                </p>
              </div>
              <Button type="button" onClick={() => setCreatingMessage(true)}>
                <Plus className="size-4" /> {t('localizationEditor.messages.new')}
              </Button>
            </div>
            {creatingMessage && (
              <section className="grid gap-3 rounded border p-4 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="new-message-key">
                    {t('localizationEditor.labels.semanticKey')}
                  </Label>
                  <Input
                    id="new-message-key"
                    aria-label={t('localizationEditor.labels.semanticKey')}
                    value={messageDraft.key}
                    onChange={(event) => updateMessageDraft('key', event.currentTarget.value)}
                    placeholder="ui.menu.play"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-source">
                    {t('localizationEditor.labels.sourceContent')}
                  </Label>
                  <Input
                    id="new-message-source"
                    aria-label={t('localizationEditor.labels.sourceContent')}
                    value={messageDraft.source}
                    onChange={(event) => updateMessageDraft('source', event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-context">
                    {t('localizationEditor.labels.context')}
                  </Label>
                  <Input
                    id="new-message-context"
                    aria-label={t('localizationEditor.labels.context')}
                    value={messageDraft.context}
                    onChange={(event) => updateMessageDraft('context', event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-message-note">
                    {t('localizationEditor.labels.translatorNote')}
                  </Label>
                  <Input
                    id="new-message-note"
                    aria-label={t('localizationEditor.labels.translatorNote')}
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
                    {t('localizationEditor.messages.create')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setCreatingMessage(false);
                      setMessageError(null);
                    }}
                  >
                    {t('localizationEditor.messages.cancel')}
                  </Button>
                </div>
              </section>
            )}
            <div className="space-y-3">
              {namedMessages.length === 0 && !creatingMessage && (
                <div className="rounded border p-4 text-sm text-muted-foreground">
                  {t('localizationEditor.messages.empty')}
                </div>
              )}
              {namedMessages.map(([messageId, message]) => {
                const usages = usagePaths(messageId);
                const namedUsages = namedMessageUsages(project, messageId);
                const localizableUsages = namedUsages.filter((usage) => usage.rewriteable);
                return (
                  <section
                    key={messageId}
                    className="grid gap-3 rounded border p-4 @3xl:grid-cols-2"
                  >
                    <div className="space-y-1">
                      <Label htmlFor={`message-key-${messageId}`}>
                        {t('localizationEditor.labels.semanticKey')}
                      </Label>
                      <Input
                        id={`message-key-${messageId}`}
                        defaultValue={message.key}
                        onBlur={(event) =>
                          updateMessageField(messageId, message, 'key', event.currentTarget.value)
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`message-source-${messageId}`}>
                        {t('localizationEditor.labels.sourceContent')}
                      </Label>
                      <textarea
                        className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm"
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
                      <Label htmlFor={`message-context-${messageId}`}>
                        {t('localizationEditor.labels.context')}
                      </Label>
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
                      <Label htmlFor={`message-note-${messageId}`}>
                        {t('localizationEditor.labels.translatorNote')}
                      </Label>
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
                        {t('localizationEditor.messages.usedIn', { count: usages.length })}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('localizationMessageReuse.sharedSourceImpact')}
                      </div>
                      {usages.length > 0 ? (
                        <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                          {usages.slice(0, 5).map((path) => (
                            <div key={path}>{path}</div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t('localizationEditor.messages.noUsages')}
                        </div>
                      )}
                      {namedUsages.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {namedUsages.map((usage) => (
                            <div
                              key={usage.id}
                              className="grid gap-1 @3xl:grid-cols-2 @3xl:items-center"
                            >
                              <div
                                className="truncate font-mono text-xs text-muted-foreground"
                                title={usage.path}
                              >
                                {usage.path}
                              </div>
                              <Input
                                aria-label={t('localizationEditor.messages.usageNoteAria', {
                                  path: usage.path,
                                })}
                                defaultValue={localization.usageNotes[usage.id] ?? ''}
                                placeholder={t('localizationEditor.messages.usageGuidance')}
                                onBlur={(event) =>
                                  setUsageNote(usage.id, event.currentTarget.value)
                                }
                              />
                            </div>
                          ))}
                        </div>
                      )}
                      {localizableUsages.length > 0 && (
                        <div className="mt-3 rounded border bg-muted/30 p-3 text-xs">
                          {demotionDraft?.messageId === messageId ? (
                            <div className="space-y-3">
                              <div className="space-y-1">
                                <Label htmlFor={`demote-usage-${messageId}`}>
                                  {t('localizationMessageReuse.usageToMakeLocal')}
                                </Label>
                                <Select
                                  value={demotionDraft.usageId}
                                  onValueChange={(value) => {
                                    if (!value) return;
                                    setDemotionDraft((current) =>
                                      current && current.messageId === messageId
                                        ? { ...current, usageId: value }
                                        : current,
                                    );
                                  }}
                                >
                                  <SelectTrigger
                                    id={`demote-usage-${messageId}`}
                                    aria-label={t('localizationMessageReuse.usageToMakeLocalAria', {
                                      key: message.key,
                                    })}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {localizableUsages.map((usage) => (
                                      <SelectItem key={usage.id} value={usage.id}>
                                        {usage.path}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              {namedUsages.length > 1 ? (
                                <div className="space-y-2">
                                  <p className="text-muted-foreground">
                                    {t('localizationMessageReuse.demoteNewIdentity')}
                                  </p>
                                  {Object.keys(localization.locales)
                                    .filter(
                                      (locale) =>
                                        locale !== localization.sourceLocale &&
                                        localization.translations[locale]?.[messageId],
                                    )
                                    .map((locale) => {
                                      const target = localization.translations[locale]![messageId]!;
                                      return (
                                        <label key={locale} className="flex items-start gap-2">
                                          <input
                                            type="checkbox"
                                            aria-label={t(
                                              'localizationMessageReuse.copyDraftAria',
                                              {
                                                locale,
                                                key: message.key,
                                              },
                                            )}
                                            checked={demotionDraft.copyDraftLocales.includes(
                                              locale,
                                            )}
                                            onChange={(event) => {
                                              const checked = event.currentTarget.checked;
                                              setDemotionDraft((current) => {
                                                if (!current || current.messageId !== messageId)
                                                  return current;
                                                return {
                                                  ...current,
                                                  copyDraftLocales: checked
                                                    ? [...current.copyDraftLocales, locale]
                                                    : current.copyDraftLocales.filter(
                                                        (candidate) => candidate !== locale,
                                                      ),
                                                };
                                              });
                                            }}
                                          />
                                          <span>
                                            <span className="font-medium">{locale}</span> ·{' '}
                                            {target.text}
                                          </span>
                                        </label>
                                      );
                                    })}
                                </div>
                              ) : (
                                <p className="text-muted-foreground">
                                  {t('localizationMessageReuse.soleUsagePreserves')}
                                </p>
                              )}
                              {demotionError && <p className="text-destructive">{demotionError}</p>}
                              <div className="flex gap-2">
                                <Button type="button" size="sm" onClick={demoteMessageUsage}>
                                  {t('localizationMessageReuse.makeLocal')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setDemotionDraft(null);
                                    setDemotionError(null);
                                  }}
                                >
                                  {t('localizationMessageReuse.cancel')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setDemotionError(null);
                                setDemotionDraft({
                                  messageId,
                                  usageId: localizableUsages[0]!.id,
                                  copyDraftLocales: [],
                                });
                              }}
                            >
                              {t('localizationMessageReuse.makeUsageLocal')}
                            </Button>
                          )}
                        </div>
                      )}
                      {namedMessages.length > 1 && (
                        <div className="mt-3">
                          {renderMergeControls(messageId, message.key, messageId)}
                        </div>
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
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 max-w-sm flex-1 space-y-1">
                <Label htmlFor="target-locale">{t('localizationEditor.labels.targetLocale')}</Label>
                <Select
                  value={effectiveTargetLocale}
                  onValueChange={(value) => {
                    if (value) setTargetLocale(value);
                  }}
                  disabled={targetLocales.length === 0}
                >
                  <SelectTrigger
                    id="target-locale"
                    aria-label={t('localizationEditor.labels.targetLocale')}
                  >
                    <SelectValue
                      placeholder={t('localizationEditor.translations.addTargetFirst')}
                    />
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
              <div className="min-w-48 space-y-1">
                <Label htmlFor="translation-filter">
                  {t('localizationEditor.labels.statusFilter')}
                </Label>
                <Select
                  value={translationFilter}
                  onValueChange={(value) => setTranslationFilter(value as TranslationFilter)}
                >
                  <SelectTrigger
                    id="translation-filter"
                    aria-label={t('localizationEditor.labels.translationStatusFilter')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {translationFilters.map((filter) => (
                      <SelectItem key={filter} value={filter}>
                        {t(`localizationEditor.filters.${filter}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={bulkReviewFiltered}
                disabled={!effectiveTargetLocale || filteredMessages.length === 0}
              >
                {t('localizationEditor.translations.bulkReview')}
              </Button>
            </div>
            {!effectiveTargetLocale ? (
              <div className="rounded border p-4 text-sm text-muted-foreground">
                {t('localizationEditor.translations.emptyLocale')}
              </div>
            ) : allMessages.length === 0 ? (
              <div className="rounded border p-4 text-sm text-muted-foreground">
                {t('localizationEditor.translations.emptyMessages')}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredMessages.map((view) => {
                  const { id: messageId, message } = view;
                  const label = messageLabel(message, messageId);
                  const localTranslation =
                    localization.translations[effectiveTargetLocale]?.[messageId] ?? null;
                  const effective = effectiveLocalizationTarget(
                    project,
                    effectiveTargetLocale,
                    messageId,
                  );
                  const translation = effective.target;
                  const translated = translation
                    ? translation.useSource
                      ? view.source
                      : translation.text
                    : '';
                  const freshness = !translation
                    ? t('localizationEditor.status.missing')
                    : translation.useSource ||
                        translation.sourceFingerprint === view.sourceFingerprint
                      ? t('localizationEditor.status.current')
                      : t('localizationEditor.status.outdated');
                  const reuseCandidates =
                    message.kind === 'local'
                      ? identicalSourceReuseCandidates(project, messageId)
                      : [];
                  const promotable = canPromoteLocalMessage(project, messageId);
                  const attention =
                    translation && !translation.useSource
                      ? [
                          translation.acknowledgedPresentationFingerprint !== undefined &&
                          translation.acknowledgedPresentationFingerprint !==
                            view.presentationFingerprint
                            ? t('localizationEditor.status.presentationChanged')
                            : null,
                          translation.acknowledgedGuidanceFingerprint !== undefined &&
                          translation.acknowledgedGuidanceFingerprint !== view.guidanceFingerprint
                            ? t('localizationEditor.status.guidanceChanged')
                            : null,
                        ].filter((value): value is string => value !== null)
                      : [];
                  return (
                    <section key={messageId} className="rounded border p-4">
                      <div className="mb-2 flex items-baseline justify-between gap-3">
                        <div className="font-medium">{label}</div>
                        <div className="text-right text-xs text-muted-foreground">
                          {freshness}
                          {translation?.useSource
                            ? ` · ${t('localizationEditor.status.useSource')}${
                                effective.inherited && effective.locale
                                  ? ` · ${t('localizationEditor.status.inheritedFrom', { locale: effective.locale })}`
                                  : ''
                              }`
                            : translation
                              ? ` · ${t(`localizationEditor.status.${translation.origin}`)} · ${t(
                                  translation.review === 'reviewed'
                                    ? 'localizationEditor.status.reviewed'
                                    : 'localizationEditor.status.needsReview',
                                )}${
                                  effective.inherited && effective.locale
                                    ? ` · ${t('localizationEditor.status.inheritedFrom', { locale: effective.locale })}`
                                    : ''
                                }`
                              : ''}
                          {attention.length > 0 ? ` · ${attention.join(', ')}` : ''}
                        </div>
                      </div>
                      {(message.context || message.translatorNote || view.usedIn) && (
                        <div className="mb-3 text-xs text-muted-foreground">
                          {message.context
                            ? t('localizationEditor.translations.context', {
                                value: message.context,
                              })
                            : ''}
                          {message.context && (message.translatorNote || view.usedIn) ? ' · ' : ''}
                          {message.translatorNote
                            ? t('localizationEditor.translations.translatorNote', {
                                value: message.translatorNote,
                              })
                            : ''}
                          {message.translatorNote && view.usedIn ? ' · ' : ''}
                          {view.usedIn
                            ? t('localizationEditor.translations.usedIn', { value: view.usedIn })
                            : ''}
                        </div>
                      )}
                      {view.kind === 'local' && (
                        <div className="mb-3 max-w-xl space-y-1">
                          <Label htmlFor={`usage-note-${messageId}`}>
                            {t('localizationEditor.labels.usageNote')}
                          </Label>
                          <Input
                            id={`usage-note-${messageId}`}
                            aria-label={t('localizationEditor.messages.usageNoteAria', {
                              path: label,
                            })}
                            defaultValue={view.usageNote ?? ''}
                            placeholder={t('localizationEditor.messages.usageGuidance')}
                            onBlur={(event) => setUsageNote(view.id, event.currentTarget.value)}
                          />
                        </div>
                      )}
                      {message.kind === 'local' && promotable && (
                        <div className="mb-3 rounded border bg-muted/30 p-3 text-xs">
                          {reuseCandidates.length > 0 ? (
                            <p className="text-muted-foreground">
                              {t('localizationMessageReuse.identicalHint', {
                                count: reuseCandidates.length,
                              })}
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              {t('localizationMessageReuse.promoteHint')}
                            </p>
                          )}
                          {promotionDraft?.messageId === messageId ? (
                            <div className="mt-3 space-y-3">
                              <div className="space-y-1">
                                <Label htmlFor={`promotion-key-${messageId}`}>
                                  {t('localizationMessageReuse.semanticKey')}
                                </Label>
                                <Input
                                  id={`promotion-key-${messageId}`}
                                  aria-label={t('localizationMessageReuse.promotionKeyAria', {
                                    label,
                                  })}
                                  value={promotionDraft.key}
                                  onChange={(event) => {
                                    const key = event.currentTarget.value;
                                    setPromotionDraft((current) =>
                                      current && current.messageId === messageId
                                        ? { ...current, key }
                                        : current,
                                    );
                                  }}
                                  placeholder="ui.shared.message"
                                />
                              </div>
                              {reuseCandidates.length > 0 && (
                                <div className="space-y-1">
                                  <div className="font-medium">
                                    {t('localizationMessageReuse.linkSelected')}
                                  </div>
                                  {reuseCandidates.map((candidate) => (
                                    <label
                                      key={candidate.id}
                                      className="flex items-start gap-2 text-muted-foreground"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={promotionDraft.selectedIds.includes(candidate.id)}
                                        disabled={!candidate.rewriteable}
                                        onChange={(event) => {
                                          const checked = event.currentTarget.checked;
                                          setPromotionDraft((current) => {
                                            if (!current || current.messageId !== messageId)
                                              return current;
                                            return {
                                              ...current,
                                              selectedIds: checked
                                                ? [...current.selectedIds, candidate.id]
                                                : current.selectedIds.filter(
                                                    (candidateId) => candidateId !== candidate.id,
                                                  ),
                                            };
                                          });
                                        }}
                                      />
                                      <span>
                                        {candidate.usedIn ?? candidate.id}
                                        {!candidate.rewriteable
                                          ? ` · ${t('localizationMessageReuse.unsupportedRefactor')}`
                                          : ''}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              )}
                              {promotionError && (
                                <p className="text-destructive">{promotionError}</p>
                              )}
                              <div className="flex gap-2">
                                <Button type="button" size="sm" onClick={promoteMessage}>
                                  {t('localizationMessageReuse.promoteAndLink')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setPromotionDraft(null);
                                    setPromotionError(null);
                                  }}
                                >
                                  {t('localizationMessageReuse.cancel')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="mt-2"
                              onClick={() => {
                                setPromotionError(null);
                                setPromotionDraft({ messageId, key: '', selectedIds: [] });
                              }}
                            >
                              {t('localizationMessageReuse.promote')}
                            </Button>
                          )}
                        </div>
                      )}
                      {message.kind === 'local' && namedMessages.length > 0 && (
                        <div className="mb-3">{renderMergeControls(messageId, label)}</div>
                      )}
                      <div className="grid gap-3 @3xl:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`source-${messageId}`}>
                            {t('localizationEditor.translations.sourceLabel', {
                              locale: localization.sourceLocale,
                            })}
                          </Label>
                          <textarea
                            className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm"
                            id={`source-${messageId}`}
                            key={`source:${messageId}:${message.source}`}
                            defaultValue={message.source}
                            disabled={!view.sourceEditPath}
                            onBlur={(event) => setSourceContent(view, event.currentTarget.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`target-${messageId}`}>
                            {t('localizationEditor.translations.targetLabel', {
                              locale: effectiveTargetLocale,
                            })}
                          </Label>
                          <textarea
                            className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm"
                            id={`target-${messageId}`}
                            aria-label={t('localizationEditor.translations.targetAria', { label })}
                            key={`${effectiveTargetLocale}:${messageId}:${translated}:${effective.locale ?? 'missing'}`}
                            defaultValue={translated}
                            placeholder={t('localizationEditor.status.missing')}
                            disabled={effective.inherited || translation?.useSource}
                            onBlur={(event) => setTranslation(view, event.currentTarget.value)}
                          />
                          {view.dialogueCues &&
                            view.dialogueCues.length > 0 &&
                            translation &&
                            !translation.useSource && (
                              <div className="space-y-2 rounded-md border p-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  {t('localizationEditor.labels.dialogueCuePlacements')}
                                </div>
                                {view.dialogueCues.map((sourceCue) => {
                                  const cue =
                                    translation.dialogueCues?.find(
                                      (candidate) => candidate.id === sourceCue.id,
                                    ) ?? sourceCue;
                                  return (
                                    <div
                                      key={`${sourceCue.id}:${cue.position.offset}:${cue.position.order}`}
                                      className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-end gap-2"
                                    >
                                      <div
                                        className="min-w-0 truncate text-xs"
                                        title={sourceCue.id}
                                      >
                                        {sourceCue.id}
                                      </div>
                                      <div className="space-y-1">
                                        <Label className="text-[11px]">
                                          {t('localizationEditor.labels.offset')}
                                        </Label>
                                        <Input
                                          type="number"
                                          min={0}
                                          step={1}
                                          aria-label={t(
                                            'localizationEditor.translations.cueOffsetAria',
                                            {
                                              id: sourceCue.id,
                                            },
                                          )}
                                          defaultValue={cue.position.offset}
                                          disabled={effective.inherited || !localTranslation}
                                          onBlur={(event) => {
                                            const value = Number.parseInt(
                                              event.currentTarget.value,
                                              10,
                                            );
                                            if (Number.isInteger(value) && value >= 0)
                                              setDialogueCuePosition(
                                                view,
                                                sourceCue.id,
                                                'offset',
                                                value,
                                              );
                                          }}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <Label className="text-[11px]">
                                          {t('localizationEditor.labels.order')}
                                        </Label>
                                        <Input
                                          type="number"
                                          min={0}
                                          step={1}
                                          aria-label={t(
                                            'localizationEditor.translations.cueOrderAria',
                                            {
                                              id: sourceCue.id,
                                            },
                                          )}
                                          defaultValue={cue.position.order}
                                          disabled={effective.inherited || !localTranslation}
                                          onBlur={(event) => {
                                            const value = Number.parseInt(
                                              event.currentTarget.value,
                                              10,
                                            );
                                            if (Number.isInteger(value) && value >= 0)
                                              setDialogueCuePosition(
                                                view,
                                                sourceCue.id,
                                                'order',
                                                value,
                                              );
                                          }}
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                                {!dialogueCuesReviewable(view, translation) && (
                                  <p className="text-xs text-destructive">
                                    {t('localizationEditor.translations.cueValidation')}
                                  </p>
                                )}
                              </div>
                            )}
                          <div className="flex flex-wrap gap-2 pt-1">
                            {effective.inherited && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => overrideInheritedTarget(view)}
                              >
                                {t('localizationEditor.translations.overrideInherited')}
                              </Button>
                            )}
                            {!effective.inherited && !localTranslation?.useSource && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setUseSource(view)}
                              >
                                {t('localizationEditor.translations.useSource')}
                              </Button>
                            )}
                            {localTranslation?.useSource && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setTranslation(view, view.source)}
                              >
                                {t('localizationEditor.translations.translateInstead')}
                              </Button>
                            )}
                            {translation && !effective.inherited && !translation.useSource && (
                              <>
                                {translation.sourceFingerprint !== view.sourceFingerprint && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => acceptTranslation(view)}
                                  >
                                    {t('localizationEditor.translations.acceptCurrentSource')}
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    translation.review === 'reviewed' ||
                                    !translationReviewable(view, effectiveTargetLocale, translation)
                                  }
                                  onClick={() => reviewTranslation(view)}
                                >
                                  {t('localizationEditor.translations.markReviewed')}
                                </Button>
                              </>
                            )}
                          </div>
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
