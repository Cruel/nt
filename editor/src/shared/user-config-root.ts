import os from 'node:os';
import path from 'node:path';

export function novelTeaUserConfigRoot(): string {
  return process.env.NOVELTEA_USER_CONFIG_ROOT || path.join(os.homedir(), '.noveltea');
}

export function novelTeaComfyUiConfigRoot(): string {
  return path.join(novelTeaUserConfigRoot(), 'comfyui');
}
