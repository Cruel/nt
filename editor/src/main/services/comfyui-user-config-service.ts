import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  comfyUiSharedUserConfigSchema,
  defaultComfyUiSharedUserConfig,
  normalizeComfyUiSharedUserConfig,
  type ComfyUiSharedUserConfig,
} from '../../shared/comfyui';
import { novelTeaComfyUiConfigRoot } from '../../shared/user-config-root';

export function comfyUiUserConfigPath(): string {
  return path.join(novelTeaComfyUiConfigRoot(), 'config-v1.json');
}

export async function loadComfyUiUserConfig(): Promise<ComfyUiSharedUserConfig> {
  let text: string;
  try {
    text = await readFile(comfyUiUserConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultComfyUiSharedUserConfig();
    throw error;
  }
  try {
    return comfyUiSharedUserConfigSchema.parse(JSON.parse(text) as unknown);
  } catch {
    return defaultComfyUiSharedUserConfig();
  }
}

let saveQueue: Promise<void> = Promise.resolve();

export function saveComfyUiUserConfig(value: unknown): Promise<ComfyUiSharedUserConfig> {
  const parsed = normalizeComfyUiSharedUserConfig(comfyUiSharedUserConfigSchema.parse(value));
  const save = saveQueue.then(async () => {
    const destination = comfyUiUserConfigPath();
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
