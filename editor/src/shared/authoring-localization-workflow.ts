import type { AuthoringProject } from './project-schema/authoring-project';
import type {
  AuthoringMessage,
  LocalizationTranslation,
} from './project-schema/authoring-localization';
import { structuredMessages } from './authoring-structured-messages';
import { collectManagedLuaLocalizationSources } from './authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from './authoring-rml-localization-lowering';
import {
  localizationTrackingFingerprint,
  resolveLocalizationSourceIdentity,
} from './localization-source-tracking';

export type LocalizationFreshness = 'missing' | 'current' | 'outdated';
export type LocalizationAttention = 'presentation' | 'guidance';

export interface LocalizationMessageWorkflowView {
  readonly id: string;
  readonly kind: 'local' | 'named';
  readonly key?: string;
  readonly source: string;
  readonly context?: string;
  readonly translatorNote?: string;
  readonly sourcePath: string | null;
  readonly sourceEditPath: string | null;
  readonly usageNote: string | null;
  readonly sourceFingerprint: string;
  readonly presentationFingerprint: string;
  readonly guidanceFingerprint: string;
}

export interface LocalizationTargetWorkflowView extends LocalizationMessageWorkflowView {
  readonly locale: string;
  readonly translation: LocalizationTranslation | null;
  readonly freshness: LocalizationFreshness;
  readonly attention: readonly LocalizationAttention[];
}

function normalizeLinguisticText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function fingerprint(prefix: string, value: string): string {
  return localizationTrackingFingerprint(`${prefix}\u0000${value}`);
}

function guidanceFingerprint(
  message: Pick<AuthoringMessage, 'context' | 'translatorNote'>,
): string {
  return fingerprint('guidance', `${message.context ?? ''}\u0000${message.translatorNote ?? ''}`);
}

function simpleView(
  id: string,
  message: AuthoringMessage,
  sourcePath: string | null,
  usageNote: string | null,
): LocalizationMessageWorkflowView {
  const argumentContract = Object.entries(message.arguments ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => `${name}:${type}`)
    .join('|');
  const sourceFingerprint = fingerprint('semantic', `${message.source}\u0000${argumentContract}`);
  return {
    id,
    kind: message.kind,
    ...(message.kind === 'named' ? { key: message.key } : {}),
    source: message.source,
    ...(message.context === undefined ? {} : { context: message.context }),
    ...(message.translatorNote === undefined ? {} : { translatorNote: message.translatorNote }),
    sourcePath,
    sourceEditPath: sourcePath,
    usageNote,
    sourceFingerprint,
    presentationFingerprint: fingerprint('presentation', message.source),
    guidanceFingerprint: guidanceFingerprint(message),
  };
}

export function localizationMessageWorkflowViews(
  project: AuthoringProject,
): readonly LocalizationMessageWorkflowView[] {
  const views = new Map<string, LocalizationMessageWorkflowView>();
  for (const [id, message] of Object.entries(project.localization.messages))
    views.set(
      id,
      simpleView(
        id,
        message,
        `/localization/messages/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/source`,
        null,
      ),
    );

  for (const occurrence of structuredMessages(project)) {
    const message: AuthoringMessage = { kind: 'local', source: occurrence.source };
    const view = simpleView(occurrence.id, message, occurrence.sourcePath, occurrence.usageNote);
    views.set(
      occurrence.id,
      occurrence.text
        ? {
            ...view,
            presentationFingerprint: fingerprint(
              'presentation',
              `${occurrence.text.markup}\u0000${occurrence.source}`,
            ),
          }
        : view,
    );
  }

  for (const source of collectManagedLuaLocalizationSources(project)) {
    source.occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind !== 'local') return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      const message: AuthoringMessage = {
        kind: 'local',
        source: occurrence.source,
        ...(occurrence.context === undefined ? {} : { context: occurrence.context }),
        ...(occurrence.translatorNote === undefined
          ? {}
          : { translatorNote: occurrence.translatorNote }),
      };
      views.set(id, {
        ...simpleView(id, message, source.source.sourcePath, source.source.sourcePath),
        sourceEditPath: null,
      });
    });
  }

  for (const source of collectRmlLocalizationSources(project)) {
    source.localNodes.forEach((node, ordinal) => {
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      const semantic = normalizeLinguisticText(node.content);
      views.set(id, {
        id,
        kind: 'local',
        source: node.content,
        sourcePath: source.source.sourcePath,
        sourceEditPath: null,
        usageNote: source.source.sourcePath,
        sourceFingerprint: fingerprint('semantic', semantic),
        presentationFingerprint: fingerprint('presentation', node.content),
        guidanceFingerprint: fingerprint('guidance', ''),
      });
    });
  }

  return Object.freeze([...views.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

export function localizationMessageWorkflowView(
  project: AuthoringProject,
  messageId: string,
): LocalizationMessageWorkflowView | null {
  return (
    localizationMessageWorkflowViews(project).find((message) => message.id === messageId) ?? null
  );
}

export function localizationTargetWorkflowView(
  project: AuthoringProject,
  locale: string,
  message: LocalizationMessageWorkflowView,
): LocalizationTargetWorkflowView {
  const translation = project.localization.translations[locale]?.[message.id] ?? null;
  const freshness: LocalizationFreshness = !translation
    ? 'missing'
    : translation.sourceFingerprint === message.sourceFingerprint
      ? 'current'
      : 'outdated';
  const attention: LocalizationAttention[] = [];
  if (translation) {
    if (
      translation.acknowledgedPresentationFingerprint !== undefined &&
      translation.acknowledgedPresentationFingerprint !== message.presentationFingerprint
    )
      attention.push('presentation');
    if (
      translation.acknowledgedGuidanceFingerprint !== undefined &&
      translation.acknowledgedGuidanceFingerprint !== message.guidanceFingerprint
    )
      attention.push('guidance');
  }
  return { ...message, locale, translation, freshness, attention: Object.freeze(attention) };
}

export function createLocalizationTranslation(
  message: LocalizationMessageWorkflowView,
  text: string,
  origin: LocalizationTranslation['origin'] = 'human',
  options: Readonly<{
    provider?: string;
    model?: string;
    review?: LocalizationTranslation['review'];
  }> = {},
): LocalizationTranslation {
  return {
    text,
    sourceFingerprint: message.sourceFingerprint,
    origin,
    review: options.review ?? 'needs-review',
    acknowledgedPresentationFingerprint: message.presentationFingerprint,
    acknowledgedGuidanceFingerprint: message.guidanceFingerprint,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}
