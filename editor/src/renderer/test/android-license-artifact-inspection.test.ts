import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { inspectAndroidLicenseAssets } from '../../main/services/android-artifact-inspection-service';
import type { TemplateDescriptor } from '../../shared/project-schema/platform-export-contracts';
import { createTemplateLicenseFixture } from './player-template-license-fixture';

describe('Android shipped engine notices', () => {
  it('matches the certified catalog and every notice byte in the actual Android resource namespace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-apk-notices-'));
    try {
      const template = path.join(root, 'template');
      const assets = path.join(root, 'apk', 'assets');
      const bundleAssets = path.join(root, 'aab', 'base', 'assets');
      const { files } = createTemplateLicenseFixture(template);
      const descriptor = { files } as TemplateDescriptor;
      const relative = files.filter((file) => file.path.startsWith('licenses/'));
      const stage = async (rootAssets: string) => {
        for (const file of relative) {
          const destination = path.join(rootAssets, 'system', file.path);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, await readFile(path.join(template, file.path)));
        }
      };
      await stage(assets);
      await stage(bundleAssets);
      expect(await inspectAndroidLicenseAssets(assets, template, descriptor)).toEqual([]);
      expect(await inspectAndroidLicenseAssets(bundleAssets, template, descriptor)).toEqual([]);

      const notice = 'licenses/fixture-dependency--license.txt';
      const noticePath = path.join(assets, 'system', notice);
      await writeFile(noticePath, 'Altered license bytes');
      expect((await inspectAndroidLicenseAssets(assets, template, descriptor))[0]?.code).toBe(
        'android-license-content-mismatch',
      );
      await writeFile(noticePath, await readFile(path.join(template, notice)));

      const extra = path.join(assets, 'system', 'licenses', 'extra.txt');
      await writeFile(extra, 'Undeclared notice');
      expect((await inspectAndroidLicenseAssets(assets, template, descriptor))[0]?.code).toBe(
        'android-license-inventory-mismatch',
      );
      await rm(extra);

      await rm(path.join(assets, 'system', 'licenses', 'index.json'));
      expect((await inspectAndroidLicenseAssets(assets, template, descriptor))[0]?.code).toBe(
        'android-license-inventory-mismatch',
      );
      await rm(path.join(assets, 'system', 'licenses'), { recursive: true });
      expect((await inspectAndroidLicenseAssets(assets, template, descriptor))[0]?.code).toBe(
        'android-license-inventory-missing',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
