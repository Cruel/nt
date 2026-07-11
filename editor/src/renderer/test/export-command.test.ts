import { describe, expect, it } from 'vitest';
import { exitCodeForExportResult, parseExportCommandArguments } from '../../cli/export-command';

describe('platform export CLI', () => {
  it('parses the practical project/profile/output command', () => {
    expect(parseExportCommandArguments(['--export-project', '--project', '/game/project.json', '--profile', 'linux-release', '--output', '/dist/game', '--json'])).toEqual({
      projectPath: '/game/project.json',
      profileId: 'linux-release',
      outputDirectory: '/dist/game',
      json: true,
    });
    expect(() => parseExportCommandArguments(['--export-project'])).toThrow(/Usage:/);
  });

  it('returns stable exit codes for automation', () => {
    expect(exitCodeForExportResult({ ok: true, success: true, cancelled: false, operationId: 'ok', diagnostics: [] })).toBe(0);
    expect(exitCodeForExportResult({ ok: false, success: false, cancelled: false, operationId: 'missing', diagnostics: [{ severity: 'error', code: 'template-missing', path: '/template', message: 'missing' }] })).toBe(3);
    expect(exitCodeForExportResult({ ok: false, success: false, cancelled: true, operationId: 'cancel', diagnostics: [] })).toBe(6);
  });
});
