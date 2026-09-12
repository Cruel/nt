import { describe, expect, it, vi } from 'vite-plus/test';
import { LocalizationFontCoverageService } from '../../main/services/localization-font-coverage-service';
import { localizationFontCoverageLocales } from '../../shared/localization-font-coverage';
import { minimalGoldenProject } from './fixtures/compiled-project-golden-projects';

describe('localization font coverage', () => {
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
});
