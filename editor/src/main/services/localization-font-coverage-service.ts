import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  fontCoverageMessageIdentities,
  fontCoverageUnverifiedMessages,
  fontCoverageStackIdentity,
  localizationFontCoverageLocales,
  type LocalizationFontCoverageDiagnostic,
} from '../../shared/localization-font-coverage';
import {
  resolveLocalizationSystemAssetRoot,
  runLocalizationFontCoverage,
} from '../../shared/localization-font-coverage-subprocess';

interface CachedLocaleCoverage {
  fingerprint: string;
  diagnostics: readonly LocalizationFontCoverageDiagnostic[];
  stackIdentity: string;
  messageIdentities: readonly string[];
  diagnosticCount: number;
}

export class LocalizationFontCoverageService {
  private readonly cacheBySession = new Map<string, Map<string, CachedLocaleCoverage>>();

  constructor(
    private readonly runCoverage = runLocalizationFontCoverage,
    private readonly systemRoot = resolveLocalizationSystemAssetRoot(),
  ) {}

  clear(projectSessionId?: string): void {
    if (projectSessionId) this.cacheBySession.delete(projectSessionId);
    else this.cacheBySession.clear();
  }

  async validate(
    projectSessionId: string,
    projectRoot: string,
    project: AuthoringProject,
  ): Promise<readonly LocalizationFontCoverageDiagnostic[]> {
    const localeRequests = localizationFontCoverageLocales(project);
    const previous = this.cacheBySession.get(projectSessionId) ?? new Map();
    const next = new Map<string, CachedLocaleCoverage>();
    const diagnostics: LocalizationFontCoverageDiagnostic[] = [];

    for (const localeRequest of localeRequests) {
      const cached = previous.get(localeRequest.locale);
      const delta = cached ? fontCoverageUnverifiedMessages(localeRequest, cached) : null;
      if (
        cached &&
        (cached.fingerprint === localeRequest.fingerprint || delta?.messages.length === 0)
      ) {
        next.set(localeRequest.locale, { ...cached, fingerprint: localeRequest.fingerprint });
        diagnostics.push(...cached.diagnostics);
        continue;
      }
      const response = await this.runCoverage({
        projectRoot,
        systemRoot: this.systemRoot,
        locales: [delta ?? localeRequest],
      });
      if (!response.ok)
        throw new Error(
          response.error ?? `Font coverage validation failed for ${localeRequest.locale}.`,
        );
      const localeDiagnostics = Object.freeze([...response.diagnostics]);
      const entry = Object.freeze({
        fingerprint: localeRequest.fingerprint,
        diagnostics: localeDiagnostics,
        stackIdentity: fontCoverageStackIdentity(localeRequest),
        messageIdentities: fontCoverageMessageIdentities(localeRequest),
        diagnosticCount: localeDiagnostics.length,
      });
      next.set(localeRequest.locale, entry);
      diagnostics.push(...localeDiagnostics);
    }

    this.cacheBySession.set(projectSessionId, next);
    return Object.freeze(diagnostics);
  }
}
