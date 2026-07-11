import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializePlatformExportAcceptanceFixture } from '../../main/services/platform-export-acceptance-fixture-service';

const roots: string[] = [];
const fontSourcePath = path.resolve(process.cwd(), '../apps/sandbox/assets/rmlui/LiberationSans.ttf');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('platform export acceptance fixture materializer', () => {
  it('materializes deterministic project/profile inputs for the same target and revision', async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-fixture-a-'));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-fixture-b-'));
    roots.push(firstRoot, secondRoot);
    const first = await materializePlatformExportAcceptanceFixture({ root: firstRoot, target: 'web', fontSourcePath });
    const second = await materializePlatformExportAcceptanceFixture({ root: secondRoot, target: 'web', fontSourcePath });
    expect(first.projectSha256).toBe(second.projectSha256);
    expect(first.profileSha256).toBe(second.profileSha256);
    expect(await readFile(first.projectPath)).toEqual(await readFile(second.projectPath));
  });

  it('changes the Android project identity revision without changing its stable application/save identity', async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-fixture-android-a-'));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-fixture-android-b-'));
    roots.push(firstRoot, secondRoot);
    const first = await materializePlatformExportAcceptanceFixture({
      root: firstRoot, target: 'android', androidAbi: 'x86_64', buildFlavor: 'debug', contentRevision: 1, fontSourcePath,
    });
    const second = await materializePlatformExportAcceptanceFixture({
      root: secondRoot, target: 'android', androidAbi: 'x86_64', buildFlavor: 'debug', contentRevision: 2, fontSourcePath,
    });
    expect(first.projectSha256).not.toBe(second.projectSha256);
    const firstProject = JSON.parse(await readFile(first.projectPath, 'utf8'));
    const secondProject = JSON.parse(await readFile(second.projectPath, 'utf8'));
    expect(firstProject.settings.app.applicationId).toBe(secondProject.settings.app.applicationId);
    expect(firstProject.settings.app.saveNamespace).toBe(secondProject.settings.app.saveNamespace);
    expect(firstProject.settings.app.android.versionCode).toBe(1);
    expect(secondProject.settings.app.android.versionCode).toBe(2);
  });
});
