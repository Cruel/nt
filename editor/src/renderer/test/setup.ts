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
  },
  writable: true,
  configurable: true,
});
