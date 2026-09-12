import {
  effectiveLocalizationTarget,
  localizationMessageWorkflowViews,
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

function patternTexts(pattern: MessagePattern | undefined): string[] {
  if (!pattern) return [];
  if (pattern.kind === 'text') return [pattern.text];
  return Object.values(pattern.cases).flatMap(patternTexts);
}

function effectiveTexts(
  project: AuthoringProject,
  locale: string,
  view: ReturnType<typeof localizationMessageWorkflowViews>[number],
): string[] {
  if (locale === project.localization.sourceLocale)
    return [view.source, ...patternTexts(view.pattern)];
  const effective = effectiveLocalizationTarget(project, locale, view.id).target;
  if (!effective || effective.useSource) return [view.source, ...patternTexts(view.pattern)];
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

export function localizationFontCoverageLocales(
  project: AuthoringProject,
): readonly LocalizationFontCoverageLocale[] {
  const views = localizationMessageWorkflowViews(project);
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
      const messages = views.flatMap((view) =>
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
