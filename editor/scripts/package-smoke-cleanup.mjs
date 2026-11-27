import { rm } from 'node:fs/promises';

/**
 * Windows Electron helpers may release the smoke root just after the parent
 * process and its streams close. Retry OS-classified transient removals, but
 * propagate a persistent lock: success must not hide leaked package resources.
 */
export async function removePackageSmokeRoot(
  root,
  { platform = process.platform, remove = rm } = {},
) {
  await remove(root, {
    recursive: true,
    force: true,
    maxRetries: platform === 'win32' ? 30 : 0,
    retryDelay: 200,
  });
}
