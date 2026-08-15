import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function countByChannel(text: string, pattern: RegExp) {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(pattern)) {
    const channel = match[1];
    if (!channel) continue;
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return counts;
}

describe('preload-to-main IPC trust-boundary inventory', () => {
  it('registers every preload invoke channel exactly once through the guarded parser seam', () => {
    const preload = source('src/preload.ts');
    const main = source('src/main.ts');
    const preloadInvokes = countByChannel(
      preload,
      /(?:ipcRenderer\.invoke|invokeGuarded)\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/gu,
    );
    const guardedRegistrations = countByChannel(
      main,
      /guardedIpc\.handle\(\s*IPC_CHANNELS\.([A-Z0-9_]+)\s*,\s*\(arguments_\)\s*=>\s*[A-Za-z0-9_]+\.parse\(arguments_\)/gu,
    );

    expect([...preloadInvokes.keys()].sort()).not.toHaveLength(0);
    for (const channel of preloadInvokes.keys()) {
      expect(guardedRegistrations.get(channel), `${channel} guarded registration count`).toBe(1);
    }

    const unexpectedRegistrations = [...guardedRegistrations.keys()].filter(
      (channel) => !preloadInvokes.has(channel),
    );
    expect(unexpectedRegistrations).toEqual([]);
  });

  it('forbids channel-specific direct ipcMain.handle registrations', () => {
    const main = source('src/main.ts');
    expect(main).not.toMatch(/ipcMain\.handle\(\s*IPC_CHANNELS\./u);
  });
});
