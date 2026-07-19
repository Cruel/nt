import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resolveProjectAssetUrl } from '../../main/services/project-asset-url-service';

const roots: string[] = [];

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-asset-url-'));
  roots.push(root);
  const projectFilePath = path.join(root, 'game.json');
  fs.writeFileSync(projectFilePath, '{}');
  fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'images', 'logo.png'), 'png');
  return { root, projectFilePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveProjectAssetUrl', () => {
  it('returns a file URL and absolute path for safe project asset paths', () => {
    const { root, projectFilePath } = tempProject();
    const result = resolveProjectAssetUrl(projectFilePath, 'assets/images/logo.png');
    expect(result?.url).toMatch(/^data:image\/png;base64,/);
    expect(result?.absolutePath).toBe(path.join(root, 'assets', 'images', 'logo.png'));
  });

  it('rejects unsafe or missing paths', () => {
    const { projectFilePath } = tempProject();
    expect(resolveProjectAssetUrl(projectFilePath, '../logo.png')).toBeNull();
    expect(resolveProjectAssetUrl(projectFilePath, 'assets/images/missing.png')).toBeNull();
  });
});
