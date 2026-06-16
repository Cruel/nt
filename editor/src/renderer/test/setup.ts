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
  },
  writable: true,
  configurable: true,
});
