import type { AuthoringProject } from './project-schema/authoring-project';
import {
  messagePlaceholderNames,
  type AuthoringMessage,
  type DialogueCuePlacement,
  type LocalizationTranslation,
} from './project-schema/authoring-localization';
import { dialogueMessageCueContracts, structuredMessages } from './authoring-structured-messages';
import { collectManagedLuaLocalizationSources } from './authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from './authoring-rml-localization-lowering';
import { parseDialogueCueMarkup } from './project-schema/dialogue-cue-markup';
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
  readonly arguments?: AuthoringMessage['arguments'];
  readonly pattern?: AuthoringMessage['pattern'];
  readonly context?: string;
  readonly translatorNote?: string;
  readonly sourcePath: string | null;
  readonly sourceEditPath: string | null;
  readonly usedIn: string | null;
  readonly usageNote: string | null;
  readonly dialogueCues?: readonly DialogueCuePlacement[];
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

export interface EffectiveLocalizationTarget {
  readonly target: LocalizationTranslation | null;
  readonly locale: string | null;
  readonly inherited: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function activeTextObjectId(token: string): string | null {
  const match = /^\[(?:o|object)(?:\s+id)?=([^\]]+)\]$/iu.exec(token);
  return match?.[1]?.trim() || null;
}

function normalizeLinguisticText(value: string): string {
  const objectIds: string[] = [];
  const expandedShorthand = value.replace(
    /\[\[([^\]|]*)\|([^\]]+)\]\]/gu,
    (_token, label: string, objectId: string) => {
      objectIds.push(objectId.trim());
      return label;
    },
  );
  const parsed = parseDialogueCueMarkup(expandedShorthand);
  for (const cue of parsed.cues) {
    if (cue.kind !== 'active-text') continue;
    const objectId = activeTextObjectId(cue.token);
    if (objectId) objectIds.push(objectId);
  }
  const text = normalizeWhitespace(parsed.text.replace(/<[^>]*>/gu, ''));
  return objectIds.length > 0 ? `${text}\u0000objects:${objectIds.join('|')}` : text;
}

function normalizePlainLinguisticText(value: string): string {
  return normalizeWhitespace(value);
}

function normalizeRmlLinguisticText(value: string): string {
  return normalizeWhitespace(value.replace(/<[^>]*>/gu, ''));
}

function fingerprint(prefix: string, value: string): string {
  return localizationTrackingFingerprint(`${prefix}\u0000${value}`);
}

function patternFingerprintValue(
  pattern: AuthoringMessage['pattern'],
  normalizeText: (value: string) => string = (value) => value,
): string {
  if (!pattern) return '';
  if (pattern.kind === 'text') return JSON.stringify(['text', normalizeText(pattern.text)]);
  return JSON.stringify([
    pattern.kind,
    pattern.argument,
    Object.entries(pattern.cases)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, branch]) => [key, patternFingerprintValue(branch, normalizeText)]),
  ]);
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
  usedIn: string | null,
  usageNote: string | null,
  dialogueCues?: readonly DialogueCuePlacement[],
): LocalizationMessageWorkflowView {
  const argumentContract = Object.entries(message.arguments ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => `${name}:${type}`)
    .join('|');
  const semanticPatternContract = patternFingerprintValue(message.pattern, normalizeLinguisticText);
  const presentationPatternContract = patternFingerprintValue(message.pattern);
  const cueContract = (dialogueCues ?? []).map((cue) => cue.id).join('|');
  const cuePresentation = (dialogueCues ?? [])
    .map((cue) => `${cue.id}:${cue.position.offset}:${cue.position.order}`)
    .join('|');
  const sourceFingerprint = fingerprint(
    'semantic',
    `${normalizeLinguisticText(message.source)}\u0000${argumentContract}\u0000${semanticPatternContract}\u0000${cueContract}`,
  );
  return {
    id,
    kind: message.kind,
    ...(message.kind === 'named' ? { key: message.key } : {}),
    source: message.source,
    ...(message.arguments === undefined ? {} : { arguments: message.arguments }),
    ...(message.pattern === undefined ? {} : { pattern: message.pattern }),
    ...(message.context === undefined ? {} : { context: message.context }),
    ...(message.translatorNote === undefined ? {} : { translatorNote: message.translatorNote }),
    sourcePath,
    sourceEditPath: sourcePath,
    usedIn,
    usageNote,
    ...(dialogueCues === undefined ? {} : { dialogueCues }),
    sourceFingerprint,
    presentationFingerprint: fingerprint(
      'presentation',
      `${message.source}\u0000${presentationPatternContract}\u0000${cuePresentation}`,
    ),
    guidanceFingerprint: guidanceFingerprint(message),
  };
}

export function localizationMessageWorkflowViews(
  project: AuthoringProject,
): readonly LocalizationMessageWorkflowView[] {
  const views = new Map<string, LocalizationMessageWorkflowView>();
  const dialogueCueContracts = dialogueMessageCueContracts(project);
  for (const [id, message] of Object.entries(project.localization.messages))
    views.set(
      id,
      simpleView(
        id,
        message,
        `/localization/messages/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/source`,
        null,
        project.localization.usageNotes[id] ?? null,
        dialogueCueContracts.get(id),
      ),
    );

  for (const occurrence of structuredMessages(project)) {
    const message: AuthoringMessage = { kind: 'local', source: occurrence.source };
    const view = simpleView(
      occurrence.id,
      message,
      occurrence.sourcePath,
      occurrence.usedIn,
      project.localization.usageNotes[occurrence.id] ?? null,
      occurrence.dialogueCues,
    );
    views.set(
      occurrence.id,
      occurrence.text
        ? {
            ...view,
            sourceFingerprint: fingerprint(
              'semantic',
              `${
                occurrence.text.markup === 'active-text'
                  ? normalizeLinguisticText(occurrence.source)
                  : normalizePlainLinguisticText(occurrence.source)
              }\u0000${(occurrence.dialogueCues ?? []).map((cue) => cue.id).join('|')}`,
            ),
            presentationFingerprint: fingerprint(
              'presentation',
              `${occurrence.text.markup}\u0000${occurrence.source}\u0000${(
                occurrence.dialogueCues ?? []
              )
                .map((cue) => `${cue.id}:${cue.position.offset}:${cue.position.order}`)
                .join('|')}`,
            ),
          }
        : view,
    );
  }

  for (const source of collectManagedLuaLocalizationSources(project)) {
    source.occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind === 'named') return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      const selectorKind =
        occurrence.kind === 'plural' || occurrence.kind === 'select' ? occurrence.kind : null;
      const placeholderArguments = Object.fromEntries(
        messagePlaceholderNames(occurrence.source).map((name) => [name, 'printable' as const]),
      );
      const message: AuthoringMessage = {
        kind: 'local',
        source: occurrence.source,
        ...(selectorKind
          ? {
              arguments: {
                value: selectorKind === 'plural' ? ('plural-number' as const) : ('string' as const),
              },
              pattern: {
                kind: selectorKind,
                argument: 'value',
                cases: Object.fromEntries(
                  Object.entries(occurrence.cases ?? {}).map(([key, text]) => [
                    key,
                    { kind: 'text' as const, text },
                  ]),
                ),
              },
            }
          : Object.keys(placeholderArguments).length > 0
            ? { arguments: placeholderArguments }
            : {}),
        ...(occurrence.context === undefined ? {} : { context: occurrence.context }),
        ...(occurrence.translatorNote === undefined
          ? {}
          : { translatorNote: occurrence.translatorNote }),
      };
      views.set(id, {
        ...simpleView(
          id,
          message,
          source.source.sourcePath,
          source.source.sourcePath,
          project.localization.usageNotes[id] ?? null,
        ),
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
      const argumentsContract = Object.fromEntries(
        messagePlaceholderNames(node.content).map((name) => [name, 'printable' as const]),
      );
      const argumentFingerprint = Object.entries(argumentsContract)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => `${name}:${type}`)
        .join('|');
      const semantic = normalizeRmlLinguisticText(node.content);
      views.set(id, {
        id,
        kind: 'local',
        source: node.content,
        ...(Object.keys(argumentsContract).length > 0 ? { arguments: argumentsContract } : {}),
        sourcePath: source.source.sourcePath,
        sourceEditPath: null,
        usedIn: source.source.sourcePath,
        usageNote: project.localization.usageNotes[id] ?? null,
        sourceFingerprint: fingerprint('semantic', `${semantic}\u0000${argumentFingerprint}`),
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

export function effectiveLocalizationTarget(
  project: AuthoringProject,
  locale: string,
  messageId: string,
): EffectiveLocalizationTarget {
  const visited = new Set<string>();
  let current: string | null = locale;
  while (current && current !== project.localization.sourceLocale && !visited.has(current)) {
    visited.add(current);
    const target = project.localization.translations[current]?.[messageId];
    if (target) return { target, locale: current, inherited: current !== locale };
    current = project.localization.locales[current]?.parentLocale ?? null;
  }
  return { target: null, locale: null, inherited: false };
}

export function localizationTargetWorkflowView(
  project: AuthoringProject,
  locale: string,
  message: LocalizationMessageWorkflowView,
): LocalizationTargetWorkflowView {
  const effective = effectiveLocalizationTarget(project, locale, message.id);
  const translation = effective.target;
  const freshness: LocalizationFreshness = !translation
    ? 'missing'
    : translation.useSource || translation.sourceFingerprint === message.sourceFingerprint
      ? 'current'
      : 'outdated';
  const attention: LocalizationAttention[] = [];
  if (translation && !translation.useSource) {
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
    ...(message.dialogueCues === undefined
      ? {}
      : { dialogueCues: message.dialogueCues.map((cue) => structuredClone(cue)) }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

export function createUseSourceLocalizationTarget(
  message: LocalizationMessageWorkflowView,
): LocalizationTranslation {
  return {
    text: '',
    sourceFingerprint: message.sourceFingerprint,
    origin: 'unknown',
    review: 'reviewed',
    acknowledgedPresentationFingerprint: message.presentationFingerprint,
    acknowledgedGuidanceFingerprint: message.guidanceFingerprint,
    useSource: true,
  };
}
