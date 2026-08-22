import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultUserExportConfig,
  parseUserExportConfig,
  type UserExportConfig,
} from '../../shared/project-schema/platform-export-contracts';
import { novelTeaUserConfigRoot } from '../../shared/user-config-root';

export function userExportConfigRoot(): string {
  return novelTeaUserConfigRoot();
}

export function userExportConfigPath(): string {
  return path.join(userExportConfigRoot(), 'export-config-v1.json');
}

export async function loadUserExportConfig(): Promise<UserExportConfig> {
  let text: string;
  try {
    text = await readFile(userExportConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultUserExportConfig();
    throw error;
  }

  try {
    return parseUserExportConfig(JSON.parse(text) as unknown);
  } catch {
    return defaultUserExportConfig();
  }
}

let saveQueue: Promise<void> = Promise.resolve();

export function saveUserExportConfig(value: unknown): Promise<UserExportConfig> {
  const parsed = parseUserExportConfig(value);
  const save = saveQueue.then(async () => {
    const destination = userExportConfigPath();
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
  saveQueue = save.catch(() => undefined);
  return save.then(() => parsed);
}
