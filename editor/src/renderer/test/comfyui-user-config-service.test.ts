import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  comfyUiUserConfigPath,
  loadComfyUiUserConfig,
  saveComfyUiUserConfig,
} from '../../main/services/comfyui-user-config-service';
import { defaultComfyUiSharedUserConfig } from '../../shared/comfyui';

const roots: string[] = [];
const previousUserConfigRoot = process.env.NOVELTEA_USER_CONFIG_ROOT;

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-user-config-'));
  roots.push(value);
  process.env.NOVELTEA_USER_CONFIG_ROOT = value;
  return value;
}

afterEach(() => {
  if (previousUserConfigRoot === undefined) delete process.env.NOVELTEA_USER_CONFIG_ROOT;
  else process.env.NOVELTEA_USER_CONFIG_ROOT = previousUserConfigRoot;
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('ComfyUI shared user config service', () => {
  it('uses defaults when config is absent and stores shared state under NOVELTEA_USER_CONFIG_ROOT', async () => {
    const configRoot = root();
    await expect(loadComfyUiUserConfig()).resolves.toEqual(defaultComfyUiSharedUserConfig());

    const saved = await saveComfyUiUserConfig({
      ...defaultComfyUiSharedUserConfig(),
      serverUrl: 'https://comfy.example.test:8443/',
      requestTimeoutMs: 2345,
      defaultWorkflows: { 'image.generate': 'custom-generate' },
      defaultWorkflowId: 'custom-generate',
    });

    expect(saved).toMatchObject({
      serverUrl: 'https://comfy.example.test:8443',
      requestTimeoutMs: 2345,
      defaultWorkflowId: 'custom-generate',
    });
    expect(comfyUiUserConfigPath()).toBe(path.join(configRoot, 'comfyui', 'config-v1.json'));
    await expect(loadComfyUiUserConfig()).resolves.toEqual(saved);
  });

  it('discards replaced or malformed same-version config data instead of migrating it', async () => {
    const configRoot = root();
    const file = path.join(configRoot, 'comfyui', 'config-v1.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        format: 'noveltea.comfyui-user-config',
        formatVersion: 1,
        serverUrl: 'http://127.0.0.1:9000',
        requestTimeoutMs: 1000,
        defaultWorkflowId: 'legacy',
        defaultWorkflows: {},
        enabled: true,
      })}\n`,
    );

    await expect(loadComfyUiUserConfig()).resolves.toEqual(defaultComfyUiSharedUserConfig());
  });
});
