import { describe, expect, it } from 'vite-plus/test';
import { createTestI18n } from '@/i18n/test-utils';

describe('editor i18n conventions', () => {
  it('supports whole-message interpolation for dynamic values', async () => {
    const i18n = await createTestI18n('en-US');
    i18n.addResource('en-US', 'common', 'test.savedProject', 'Saved {{projectName}} to {{path}}.');

    expect(
      i18n.t('common:test.savedProject', {
        projectName: 'Demo',
        path: '/tmp/demo.ntproj',
      }),
    ).toBe('Saved Demo to /tmp/demo.ntproj.');
  });

  it('uses i18next plural forms for count-based text', async () => {
    const i18n = await createTestI18n('en-US');
    i18n.addResource('en-US', 'common', 'test.importedFile_one', 'Imported {{count}} file.');
    i18n.addResource('en-US', 'common', 'test.importedFile_other', 'Imported {{count}} files.');

    expect(i18n.t('common:test.importedFile', { count: 1 })).toBe('Imported 1 file.');
    expect(i18n.t('common:test.importedFile', { count: 2 })).toBe('Imported 2 files.');
  });
});
