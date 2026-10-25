import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { incompatibleLegacyNativeEditChannels } from '../../main/services/native-editor-ipc-routing';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function sourceTree(relativePath: string): string {
  const chunks: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.[cm]?ts$/u.test(entry.name)) {
        chunks.push(fs.readFileSync(absolute, 'utf8'));
      }
    }
  };
  visit(path.resolve(relativePath));
  return chunks.join('\n');
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
    const main = `${source('src/main.ts')}\n${sourceTree('src/main')}`;
    const preloadInvokes = countByChannel(
      preload,
      /(?:ipcRenderer\.invoke|invokeGuarded)\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/gu,
    );
    const guardedRegistrations = countByChannel(
      main,
      /guardedIpc\.handle\(\s*IPC_CHANNELS\.([A-Z0-9_]+)\s*,\s*\(arguments_\)\s*=>\s*[A-Za-z0-9_]+\.parse\(arguments_\)/gu,
    );

    expect([...preloadInvokes.keys()].sort()).not.toHaveLength(0);
    for (const [channel, count] of preloadInvokes) {
      expect(count, `${channel} preload invoke count`).toBe(1);
      if (
        incompatibleLegacyNativeEditChannels.has(IPC_CHANNELS[channel as keyof typeof IPC_CHANNELS])
      ) {
        // Retired routes may retain a guarded compatibility rejection handler,
        // but a missing registration must not be mistaken for an unguarded one.
        expect(
          guardedRegistrations.get(channel) ?? 0,
          `${channel} compatibility registrations`,
        ).toBeLessThanOrEqual(1);
        continue;
      }
      expect(guardedRegistrations.get(channel), `${channel} guarded registration count`).toBe(1);
    }

    const unexpectedRegistrations = [...guardedRegistrations.keys()].filter(
      (channel) => !preloadInvokes.has(channel),
    );
    expect(unexpectedRegistrations).toEqual([]);
  });

  it('forbids channel-specific direct ipcMain.handle registrations anywhere in main-process source', () => {
    const main = `${source('src/main.ts')}\n${sourceTree('src/main')}`;
    expect(main).not.toMatch(/ipcMain\.handle\(\s*IPC_CHANNELS\./u);
  });
});
