import '@testing-library/jest-dom';
import { vi } from 'vitest';

Object.defineProperty(window, 'noveltea', {
  value: {
    getAppInfo: vi.fn().mockResolvedValue({
      version: '1.0.0',
      electronVersion: '42.0.0',
      platform: 'linux',
      arch: 'x64',
      packaged: false,
    }),
    selectProjectDirectory: vi.fn().mockResolvedValue('/mock/project'),
    openExternal: vi.fn().mockResolvedValue(undefined),
    getEnginePreviewSession: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    }),
    reloadEnginePreview: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5001/?sessionToken=test-token-2',
      origin: 'http://127.0.0.1:5001',
      sessionToken: 'test-token-2',
    }),
    openProject: vi.fn().mockResolvedValue({
      ok: true,
      success: true,
      importedLegacy: false,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
      project: { room: { foyer: ['foyer'] }, object: { lamp: ['lamp'] }, tests: {} },
      diagnostics: [],
    }),
    importLegacyGame: vi.fn().mockResolvedValue({ ok: true, success: true, importedLegacy: true, diagnostics: [] }),
    validateProject: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    listPlaybackTests: vi.fn().mockResolvedValue({ ok: true, tests: [{ id: 'smoke', steps: 1 }], diagnostics: [] }),
    runPlaybackTest: vi.fn().mockResolvedValue({ ok: true, report: { id: 'smoke', passed: true }, diagnostics: [] }),
    exportPackage: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], byteCount: 1 }),
    saveProject: vi.fn().mockResolvedValue({ ok: true, success: true, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' }),
    saveProjectAs: vi.fn().mockResolvedValue({ ok: true, success: true, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' }),
    setEntityRecord: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], project: {} }),
    eraseEntityRecord: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], project: {} }),
  },
  writable: true,
  configurable: true,
});
