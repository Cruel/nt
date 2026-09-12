import { localizationMessageWorkflowViews } from './authoring-localization-workflow';
import type { AuthoringProject } from './project-schema/authoring-project';

/**
 * Vendor-neutral seam for future localization exchange/TMS integrations.
 *
 * Canonical NovelTea storage remains authoritative. Adapters receive and return normalized exchange
 * records keyed by stable Message identity; they do not own Project persistence, Message identity,
 * freshness/review policy, or source reconciliation.
 */
export interface LocalizationExchangeMessage {
  readonly messageId: string;
  readonly namedKey?: string;
  readonly source: string;
  readonly context?: string;
  readonly translatorNote?: string;
  readonly usageNotes: readonly string[];
  readonly target?: string;
}

export interface LocalizationExchangeDocument {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly messages: readonly LocalizationExchangeMessage[];
}

export interface LocalizationExchangeImport {
  readonly messageId: string;
  readonly target: string;
}

export interface LocalizationExchangeAdapter<Serialized = unknown> {
  readonly formatId: string;
  exportDocument(document: LocalizationExchangeDocument): Serialized;
  importDocument(serialized: Serialized): readonly LocalizationExchangeImport[];
}

export function localizationExchangeDocument(
  project: AuthoringProject,
  targetLocale: string,
): LocalizationExchangeDocument {
  const messages = [...localizationMessageWorkflowViews(project)]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((message) => {
      const translation = project.localization.translations[targetLocale]?.[message.id];
      return {
        messageId: message.id,
        ...(message.kind === 'named' && message.key ? { namedKey: message.key } : {}),
        source: message.source,
        ...(message.context === undefined ? {} : { context: message.context }),
        ...(message.translatorNote === undefined ? {} : { translatorNote: message.translatorNote }),
        usageNotes: message.usageNote ? [message.usageNote] : [],
        ...(!translation?.useSource && translation ? { target: translation.text } : {}),
      };
    });
  return {
    sourceLocale: project.localization.sourceLocale,
    targetLocale,
    messages: Object.freeze(messages),
  };
}
