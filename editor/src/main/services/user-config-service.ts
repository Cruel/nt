import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultNovelTeaUserConfig,
  novelTeaUserPreferencesSchema,
  novelTeaUserConfigSchema,
  type NovelTeaUserConfig,
  type NovelTeaUserPreferences,
} from '../../shared/user-config';
import { novelTeaUserConfigRoot } from '../../shared/user-config-root';

export function novelTeaUserConfigPath(): string {
  return path.join(novelTeaUserConfigRoot(), 'config.json');
}

export async function loadNovelTeaUserConfig(): Promise<NovelTeaUserConfig> {
  let text: string;
  try {
    text = await readFile(novelTeaUserConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultNovelTeaUserConfig();
    throw error;
  }
  try {
    return novelTeaUserConfigSchema.parse(JSON.parse(text) as unknown);
  } catch {
    return defaultNovelTeaUserConfig();
  }
}

let updateQueue: Promise<void> = Promise.resolve();

export function updateNovelTeaUserConfig(
  update: (current: NovelTeaUserConfig) => NovelTeaUserConfig,
): Promise<NovelTeaUserConfig> {
  let result: NovelTeaUserConfig | undefined;
  const save = updateQueue.then(async () => {
    const current = await loadNovelTeaUserConfig();
    result = novelTeaUserConfigSchema.parse(update(current));
    const destination = novelTeaUserConfigPath();
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
  updateQueue = save.catch(() => undefined);
  return save.then(() => result!);
}

export async function loadNovelTeaUserPreferences(): Promise<NovelTeaUserPreferences> {
  return (await loadNovelTeaUserConfig()).preferences;
}

export function saveNovelTeaUserPreferences(value: unknown): Promise<NovelTeaUserPreferences> {
  const parsed = novelTeaUserPreferencesSchema.parse(value);
  return updateNovelTeaUserConfig((current) => ({ ...current, preferences: parsed })).then(
    (config) => config.preferences,
  );
}
