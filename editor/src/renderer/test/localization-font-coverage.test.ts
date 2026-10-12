import { describe, expect, it, vi } from 'vite-plus/test';
import { LocalizationFontCoverageService } from '../../main/services/localization-font-coverage-service';
import {
  fontCoverageMessageIdentities,
  fontCoverageStackIdentity,
  fontCoverageUnverifiedMessages,
  localizationFontCoverageLocales,
  updateFontCoverageForMessageEdits,
} from '../../shared/localization-font-coverage';
import {
  localizationMessageSourceViews,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { minimalGoldenProject } from './fixtures/compiled-project-golden-projects';

describe('localization font coverage', () => {
  it('reprojects edited named Message coverage identically to a full rebuild', () => {
    const project = minimalGoldenProject();
    const id = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[id] = {
      kind: 'named',
      key: 'coverage.greeting',
      source: 'Hello, {name}!',
      arguments: { name: 'string' },
    };
    project.localization.locales.fr = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };
    const originalLocales = localizationFontCoverageLocales(project);
    const changed = structuredClone(project);
    changed.localization.messages[id] = {
      kind: 'named',
      key: 'coverage.greeting',
      source: 'Welcome back, {name}!',
      arguments: { name: 'string' },
    };
    const incremental = updateFontCoverageForMessageEdits(project, changed, originalLocales);
    expect(incremental).not.toBeNull();
    expect(incremental).toEqual(localizationFontCoverageLocales(changed));
    const added = structuredClone(changed);
    added.localization.messages['22222222-2222-4222-8222-222222222222'] = {
      kind: 'local',
      source: 'New',
    };
    expect(updateFontCoverageForMessageEdits(project, added, originalLocales)).toBeNull();
  });
  it('rejects reuse when font revision identity changes without changing its logical path', () => {
    const original = {
      locale: 'en',
      supported: true,
      fonts: ['project:/assets/font.ttf'],
      messages: [{ messageId: 'one', sourcePath: '/localization/messages/one', text: 'Hello' }],
      fingerprint: JSON.stringify({
        locale: 'en',
        supported: true,
        fontInputs: ['project:/assets/font.ttf\u0000sha256:old'],
      }),
    };
    const replaced = {
      ...original,
      fingerprint: JSON.stringify({
        locale: 'en',
        supported: true,
        fontInputs: ['project:/assets/font.ttf\u0000sha256:new'],
      }),
    };
    expect(
      fontCoverageUnverifiedMessages(replaced, {
        stackIdentity: fontCoverageStackIdentity(original),
        messageIdentities: fontCoverageMessageIdentities(original),
        diagnosticCount: 0,
      }),
    ).toBeNull();
  });
  it('preserves every coverage request and fingerprint when reusing source-only views', () => {
    const project = minimalGoldenProject();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'coverage.example',
      source: 'Hello, {name}!',
    };
    project.localization.locales.fr = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };
    const baseline = localizationFontCoverageLocales(
      project,
      localizationMessageWorkflowViews(project),
    );
    const prepared = localizationMessageSourceViews(project);
    expect(localizationFontCoverageLocales(project, prepared)).toEqual(baseline);
    expect(localizationFontCoverageLocales(project)).toEqual(baseline);
  });

  it('builds locale requests from the canonical Message workflow and native locale name', () => {
    const project = minimalGoldenProject();
    const [locale] = localizationFontCoverageLocales(project);
    expect(locale?.locale).toBe('en');
    expect(locale?.messages.some((message) => message.text === 'Minimal room.')).toBe(true);
    expect(locale?.messages.some((message) => message.messageId === 'locale-name:en')).toBe(true);
  });

  it('reuses unchanged locale coverage and invalidates only changed locale inputs', async () => {
    const project = minimalGoldenProject();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = { kind: 'local', source: 'Initial message.' };
    const runCoverage = vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] });
    const service = new LocalizationFontCoverageService(runCoverage, '/system');

    await service.validate('session', '/project', project);
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(1);

    project.localization.messages[messageId] = { kind: 'local', source: 'Changed message.' };
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(2);
  });

  it('checks only edited complete message strings and reuses unchanged shaped text', async () => {
    const project = minimalGoldenProject();
    const id = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[id] = { kind: 'local', source: 'Hello world!' };
    const runCoverage = vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] });
    const service = new LocalizationFontCoverageService(runCoverage, '/system');
    await service.validate('session', '/project', project);
    const previousRequest = runCoverage.mock.calls[0]?.[0];
    const previousCount = previousRequest.locales[0].messages.length as number;
    expect(previousCount).toBeGreaterThan(1);
    project.localization.messages[id] = { kind: 'local', source: 'Hello!' };
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(2);
    expect(runCoverage.mock.calls[1]?.[0].locales[0].messages).toEqual([
      expect.objectContaining({ messageId: id, text: 'Hello!' }),
    ]);
    // Exactly the same shaped text needs no further native check.
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(2);
    project.localization.messages[id] = { kind: 'local', source: 'Hello Ω!' };
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(3);
    expect(runCoverage.mock.calls[2]?.[0].locales[0].messages).toEqual([
      expect.objectContaining({ messageId: id, text: 'Hello Ω!' }),
    ]);
  });

  it('does not reuse a previous missing-glyph diagnostic for changed message text', async () => {
    const project = minimalGoldenProject();
    const id = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[id] = { kind: 'local', source: 'Hello world!' };
    const runCoverage = vi.fn().mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [
        {
          code: 'localization.font_coverage',
          severity: 'warning',
          path: '/localization',
          messageId: id,
          locale: 'en',
          cluster: '!',
          fontStack: [],
          message: 'Missing glyph',
        },
      ],
    });
    const service = new LocalizationFontCoverageService(runCoverage, '/system');
    await service.validate('session', '/project', project);
    project.localization.messages[id] = { kind: 'local', source: 'Hello!' };
    await service.validate('session', '/project', project);
    expect(runCoverage).toHaveBeenCalledTimes(2);
  });
});
