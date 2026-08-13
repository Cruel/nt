import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const roots: string[] = [];
const verifier = path.resolve(process.cwd(), '../.github/verify-release-inventory.mjs');
const tag = 'v1.0.0';
const templateIds = [
  'android-arm64-v8a-release',
  'android-x86_64-debug',
  'linux-x64-release',
  'macos-arm64-release',
  'web-wasm32-release',
  'web-wasm32-threads-release',
  'windows-x64-release',
];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function write(root: string, relative: string, value = relative) {
  writeFileSync(path.join(root, relative), value);
}

function completeInventory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noveltea-release-inventory-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const templateId of templateIds) {
    const archive = `noveltea-player-template-${tag}-${templateId}.zip`;
    const symbols = `noveltea-player-symbols-${tag}-${templateId}.zip`;
    const proof = `noveltea-certification-evidence-${templateId}-artifact-claims.json`;
    const report = `noveltea-platform-certification-${templateId}.json`;
    write(
      root,
      `${templateId}.template.json`,
      JSON.stringify({
        templateId,
        buildId: `${tag}-${templateId}`,
        engineVersion: tag,
        artifacts: { archive, symbols },
      }),
    );
    write(root, archive);
    write(root, symbols);
    write(root, `${templateId}.SBOM.cdx.json`);
    write(root, `${templateId}.THIRD_PARTY_NOTICES.txt`);
    write(root, `noveltea-certification-results-${templateId}.json`);
    write(root, proof);
    write(
      root,
      report,
      JSON.stringify({
        template: { templateId, buildId: `${tag}-${templateId}` },
        evidence: [{ artifact: proof }],
      }),
    );
  }
  for (const name of [
    `noveltea-${tag}-linux-x64`,
    `noveltea-${tag}-windows-x64.exe`,
    `noveltea-editor-${tag}-linux-x64-release.AppImage`,
    `noveltea-editor-${tag}-linux-x64-release.deb`,
    `noveltea-editor-${tag}-linux-x64-release.rpm`,
    `noveltea-editor-${tag}-windows-x64-release.setup.exe`,
    'noveltea-player-template-registry.json',
  ])
    write(root, name);
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [verifier, root, tag], { encoding: 'utf8' });
}

describe('release inventory certification evidence', () => {
  it('accepts one results file and every report proof for each required template', () => {
    const root = completeInventory();
    const result = verify(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('complete required release matrix');
  });

  it('rejects stray certification evidence outside the qualified reports', () => {
    const root = completeInventory();
    write(root, 'noveltea-certification-evidence-stale-extra.json');
    const result = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Unexpected release artifact: noveltea-certification-evidence-stale-extra.json',
    );
  });
});
