import {
  effectiveLocalizationTarget,
  localizationMessageSourceViews,
} from './authoring-localization-workflow';
import { parseAssetData } from './project-schema/authoring-assets';
import type { AuthoringProject } from './project-schema/authoring-project';
import type { MessagePattern } from './project-schema/authoring-localization';

export interface LocalizationFontCoverageMessage {
  readonly messageId: string;
  readonly sourcePath: string;
  readonly text: string;
}

export interface LocalizationFontCoverageLocale {
  readonly locale: string;
  readonly supported: boolean;
  readonly fonts: readonly string[];
  readonly fingerprint: string;
  readonly messages: readonly LocalizationFontCoverageMessage[];
}

export interface LocalizationFontCoverageRequest {
  readonly projectRoot: string;
  readonly systemRoot?: string;
  readonly locales: readonly LocalizationFontCoverageLocale[];
}

export interface LocalizationFontCoverageDiagnostic {
  readonly code: 'localization.font_coverage';
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly messageId: string;
  readonly locale: string;
  readonly cluster: string;
  readonly fontStack: readonly string[];
  readonly message: string;
}

export interface LocalizationFontCoverageResponse {
  readonly ok: boolean;
  readonly success: boolean;
  readonly error?: string;
  readonly diagnostics: readonly LocalizationFontCoverageDiagnostic[];
}

/** Exact message inputs: the native TextEngine shapes complete strings in context. */
export function fontCoverageMessageIdentities(
  locale: LocalizationFontCoverageLocale,
): readonly string[] {
  return locale.messages.map((message) =>
    JSON.stringify([message.messageId, message.sourcePath, message.text]),
  );
}

export function fontCoverageStackIdentity(locale: LocalizationFontCoverageLocale): string {
  // A logical font path alone is not sufficient: the same font file can be
  // reimported with different bytes while retaining its source path.
  let fontInputs: unknown = null;
  try {
    const fingerprint = JSON.parse(locale.fingerprint) as { fontInputs?: unknown };
    fontInputs = fingerprint.fontInputs ?? null;
  } catch {
    // Unknown fingerprints must not accidentally match a normal request.
    fontInputs = locale.fingerprint;
  }
  return JSON.stringify([locale.locale, locale.supported, locale.fonts, fontInputs]);
}

/**
 * A successful check proves only its *complete shaped strings*, never an
 * arbitrary recombination of their characters. Return null when the old
 * evidence cannot be used; otherwise return the subset requiring native
 * coverage (which may be empty).
 */
export function fontCoverageUnverifiedMessages(
  locale: LocalizationFontCoverageLocale,
  previous: Readonly<{
    stackIdentity: string;
    messageIdentities: readonly string[];
    diagnosticCount: number;
  }>,
): LocalizationFontCoverageLocale | null {
  if (
    previous.diagnosticCount !== 0 ||
    previous.stackIdentity !== fontCoverageStackIdentity(locale)
  )
    return null;
  const verified = new Set(previous.messageIdentities);
  return {
    ...locale,
    messages: locale.messages.filter(
      (message) =>
        !verified.has(JSON.stringify([message.messageId, message.sourcePath, message.text])),
    ),
  };
}

function patternTexts(pattern: MessagePattern | undefined): string[] {
  if (!pattern) return [];
  if (pattern.kind === 'text') return [pattern.text];
  return Object.values(pattern.cases).flatMap(patternTexts);
}

function effectiveTexts(
  project: AuthoringProject,
  locale: string,
  view: ReturnType<typeof localizationMessageSourceViews>[number],
): string[] {
  return effectiveMessageTexts(project, locale, view.id, view.source, view.pattern);
}

function effectiveMessageTexts(
  project: AuthoringProject,
  locale: string,
  id: string,
  source: string,
  pattern: MessagePattern | undefined,
): string[] {
  if (locale === project.localization.sourceLocale) return [source, ...patternTexts(pattern)];
  const effective = effectiveLocalizationTarget(project, locale, id).target;
  if (!effective || effective.useSource) return [source, ...patternTexts(pattern)];
  return [effective.text, ...patternTexts(effective.pattern)];
}

function logicalFontPath(project: AuthoringProject, assetId: string): string | null {
  const asset = parseAssetData(project.assets[assetId]?.data);
  if (!asset || asset.kind !== 'font') return null;
  const path = asset.source.path.replaceAll('\\', '/').replace(/^\/+/, '');
  return path ? `project:/${path}` : null;
}

function nativeLocaleName(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function coverageFingerprint(
  locale: string,
  supported: boolean,
  fontInputs: readonly string[],
  messages: readonly LocalizationFontCoverageMessage[],
): string {
  return JSON.stringify({ locale, supported, fontInputs, messages });
}

/**
 * Reproject only edited named Message texts, without rebuilding structural,
 * Script, and Layout localization source views. The caller must independently
 * prove that the tracked i18n/messages source was the sole changed physical input.
 */
export function updateFontCoverageForMessageEdits(
  before: AuthoringProject,
  after: AuthoringProject,
  previous: readonly LocalizationFontCoverageLocale[],
): readonly LocalizationFontCoverageLocale[] | null {
  const oldMessages = before.localization.messages;
  const newMessages = after.localization.messages;
  const ids = Object.keys(oldMessages);
  if (
    ids.length !== Object.keys(newMessages).length ||
    ids.some((id) => !Object.hasOwn(newMessages, id)) ||
    JSON.stringify(before.localization.structuredMessageIds) !==
      JSON.stringify(after.localization.structuredMessageIds)
  )
    return null;
  const changed = ids.filter(
    (id) => JSON.stringify(oldMessages[id]) !== JSON.stringify(newMessages[id]),
  );
  if (changed.length === 0) return previous;
  const result: LocalizationFontCoverageLocale[] = [];
  for (const locale of previous) {
    const messages = [...locale.messages];
    for (const id of changed) {
      const beforeMessage = oldMessages[id]!;
      const afterMessage = newMessages[id]!;
      const sourcePath = `/localization/messages/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/source`;
      const oldTexts = effectiveMessageTexts(
        before,
        locale.locale,
        id,
        beforeMessage.source,
        beforeMessage.pattern,
      );
      const newTexts = effectiveMessageTexts(
        after,
        locale.locale,
        id,
        afterMessage.source,
        afterMessage.pattern,
      );
      const start = messages.findIndex(
        (message) => message.messageId === id && message.sourcePath === sourcePath,
      );
      if (start < 0) return null;
      // Detect colliding source IDs and changed view ownership conservatively.
      const owned = messages.filter(
        (message) => message.messageId === id && message.sourcePath === sourcePath,
      );
      if (
        owned.length !== oldTexts.length ||
        owned.some((message, index) => message.text !== oldTexts[index]) ||
        messages
          .slice(start, start + owned.length)
          .some((message) => message.messageId !== id || message.sourcePath !== sourcePath)
      )
        return null;
      messages.splice(
        start,
        owned.length,
        ...newTexts.map((text) => ({ messageId: id, sourcePath, text })),
      );
    }
    let fontInputs: string[];
    try {
      const decoded = JSON.parse(locale.fingerprint) as { fontInputs?: string[] };
      if (
        !Array.isArray(decoded.fontInputs) ||
        !decoded.fontInputs.every((item) => typeof item === 'string')
      )
        return null;
      fontInputs = decoded.fontInputs;
    } catch {
      return null;
    }
    result.push(
      Object.freeze({
        ...locale,
        messages,
        fingerprint: coverageFingerprint(locale.locale, locale.supported, fontInputs, messages),
      }),
    );
  }
  return result;
}

export function localizationFontCoverageLocales(
  project: AuthoringProject,
  sourceViews: ReturnType<typeof localizationMessageSourceViews> = localizationMessageSourceViews(
    project,
  ),
): readonly LocalizationFontCoverageLocale[] {
  return Object.entries(project.localization.locales)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([locale, definition]) => {
      const stack = definition.fontStack ?? project.settings.text.fontStack;
      const fontInputs = stack.flatMap((reference) => {
        const asset = parseAssetData(project.assets[reference.$ref.id]?.data);
        const path = logicalFontPath(project, reference.$ref.id);
        return path ? [`${path}\u0000${asset?.contentHash ?? ''}`] : [];
      });
      const fonts = fontInputs.map((input) => input.split('\u0000', 1)[0]!);
      const messages = sourceViews.flatMap((view) =>
        effectiveTexts(project, locale, view).map((text) => ({
          messageId: view.id,
          sourcePath: view.sourcePath ?? `/localization/messages/${view.id}`,
          text,
        })),
      );
      const nativeName = nativeLocaleName(locale);
      messages.push({
        messageId: `locale-name:${locale}`,
        sourcePath: `/localization/locales/${locale}/displayName`,
        text: nativeName,
      });
      if (definition.displayName && definition.displayName !== nativeName)
        messages.push({
          messageId: `locale-display-name:${locale}`,
          sourcePath: `/localization/locales/${locale}/displayName`,
          text: definition.displayName,
        });
      return Object.freeze({
        locale,
        supported: definition.supported,
        fonts,
        fingerprint: coverageFingerprint(locale, definition.supported, fontInputs, messages),
        messages,
      });
    });
}
