import { rm } from 'node:fs/promises';

export function cliRelocationCleanupOptions(platform = process.platform) {
  return {
    recursive: true,
    force: true,
    // A Windows CLI that has just exited may still be held open briefly by
    // the OS or a scanner. Retry only transient removal errors; exhaustion
    // must still fail the release build rather than leave an unnoticed leak.
    maxRetries: platform === 'win32' ? 20 : 0,
    retryDelay: 100,
  };
}

export async function removeCliRelocation(root) {
  await rm(root, cliRelocationCleanupOptions());
}
