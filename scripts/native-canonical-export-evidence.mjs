#!/usr/bin/env node
// Bind release certification to a real native CLI export, not a deleted
// editor integration test. Every reported digest is calculated from an
// existing physical export artifact and checked against its declared owner.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireEditor = createRequire(new URL('../editor/package.json', import.meta.url));
const { parse: parseYaml } = requireEditor('yaml');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const option = (key) => {
  const at = args.indexOf(`--${key}`);
  if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--'))
    throw new Error(`Missing --${key}`);
  return args[at + 1];
};
const archive = path.resolve(option('archive'));
const exported = path.resolve(option('export'));
const project = path.resolve(option('project'));
const evidencePath = path.resolve(option('evidence'));
const sha = async (file) => digest(await readFile(file));
const check = (valid, message) => { if (!valid) throw new Error(message); };
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const extract = (file, destination) => execFileSync('cmake', ['-E', 'tar', 'xf', file], { cwd: destination });
const walk = async (folder) => {
  const out = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...await walk(relative));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`Unsafe export member: ${relative}`);
  }
  return out;
};
const safe = (value) => typeof value === 'string' && value.length > 0 &&
  !path.isAbsolute(value) && !value.split(/[\\/]/).some((segment) => segment === '..' || !segment);

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-export-proof-'));
  try {
    const templateDir = path.join(temp, 'template');
    await mkdir(templateDir);
    extract(archive, templateDir);
    const descriptorFiles = (await walk(templateDir)).filter((file) => path.basename(file) === 'template.json');
    check(descriptorFiles.length === 1, 'Template archive must contain exactly one descriptor.');
    const descriptor = await json(descriptorFiles[0]);
    const source = await readFile(path.join(project, 'project.yaml'));
    const authored = parseYaml(source.toString('utf8'));
    const profile = authored.export?.profiles?.find((item) => item.target === descriptor.platform &&
      item.architecture === (descriptor.platform === 'android' && descriptor.architecture === 'arm64-v8a'
        ? 'arm64' : descriptor.architecture) && item.buildFlavor === descriptor.buildFlavor);
    check(profile, 'Exported Project does not declare the certified target/profile.');

    const androidReports = descriptor.platform === 'android'
      ? (await walk(exported)).filter((file) => file.endsWith('-export-report.json')) : [];
    check(descriptor.platform !== 'android' || androidReports.length === 1,
      'Android export must contain exactly one native export report.');
    const manifestFile = descriptor.platform === 'android' ? androidReports[0]
      : descriptor.platform === 'macos'
        ? path.join(path.dirname(exported), `${path.basename(exported, '.app')}-export-manifest.json`)
        : path.join(exported, 'export-manifest.json');
    const manifest = await json(manifestFile);
    if (descriptor.platform === 'android') {
      check(manifest.format === 'noveltea.android-export-report' &&
        manifest.template?.id === descriptor.templateId && manifest.template?.buildId === descriptor.buildId &&
        manifest.deployment?.abi === descriptor.android?.supportedAbis?.[0] &&
        manifest.verification?.apkReadback === true,
        'Native Android report does not certify the selected template, ABI, and APK readback.');
    } else check(manifest.format === 'noveltea.platform-export-manifest', 'Not a native export manifest.');
    const deployment = descriptor.platform === 'android'
      ? { target: 'android', architecture: profile.architecture,
        buildFlavor: descriptor.buildFlavor, templateId: manifest.template.id, buildId: manifest.template.buildId,
        compiledProjectFormatVersion: descriptor.compiledProjectFormatVersion,
        playerRuntimeApiVersion: descriptor.playerRuntimeApiVersion, packageAccess: manifest.deployment.packageAccess }
      : manifest.deployment;
    for (const [field, expected] of Object.entries({ target: descriptor.platform, buildFlavor: descriptor.buildFlavor,
      templateId: descriptor.templateId, buildId: descriptor.buildId,
      compiledProjectFormatVersion: descriptor.compiledProjectFormatVersion,
      playerRuntimeApiVersion: descriptor.playerRuntimeApiVersion }))
      check(deployment?.[field] === expected, `Native export ${field} does not match certified template.`);
    const inventory = new Set();
    for (const file of descriptor.platform === 'android' ? manifest.artifacts : manifest.files) {
      const relative = file.path ?? file.file;
      check(safe(relative) && !inventory.has(relative), `Invalid export inventory path: ${relative}`);
      inventory.add(relative);
      const actual = path.join(exported, ...relative.split('/'));
      const bytes = await readFile(actual);
      check(bytes.length === file.size && digest(bytes) === file.sha256,
        `Native export file integrity failed: ${relative}`);
    }
    const packageDir = path.join(temp, 'package');
    await mkdir(packageDir);
    let packageBytes;
    if (descriptor.platform === 'android') {
      const report = manifest;
      const apk = report.artifacts.find((item) => item.kind === 'apk');
      check(apk, 'Android export does not contain an inspected APK.');
      const extractedApk = path.join(temp, 'apk');
      await mkdir(extractedApk);
      extract(path.join(exported, apk.file), extractedApk);
      packageBytes = await readFile(path.join(extractedApk, 'assets/noveltea/bootstrap/game.ntpkg'));
      check(digest(packageBytes) === report.package?.sha256, 'APK package differs from native Android report.');
    } else {
      const configPath = descriptor.platform === 'macos'
        ? 'Contents/Resources/player.json' : descriptor.platform === 'linux' ? 'bin/player.json' : 'player.json';
      const config = await json(path.join(exported, configPath));
      check(config.format === 'noveltea.player-config' && safe(config.package?.path),
        'Exported player configuration has no valid package path.');
      const packageFile = path.join(exported, path.dirname(configPath), config.package.path);
      packageBytes = await readFile(packageFile);
      check(digest(packageBytes) === config.package.sha256, 'Exported package differs from player configuration.');
      check(inventory.has(path.relative(exported, packageFile).split(path.sep).join('/')),
        'Runtime package is not in the native export inventory.');
    }
    const packageFile = path.join(temp, 'game.ntpkg');
    await writeFile(packageFile, packageBytes);
    extract(packageFile, packageDir);
    const notices = await json(path.join(packageDir, 'licenses/index.json'));
    check(notices.schema === 'noveltea.project-notices' && Array.isArray(notices.notices),
      'Native runtime package has no valid Project license notice index.');
    // A profile may omit unused or unselected localized Assets. Its package
    // must carry the global notices and notices attached to the Assets that
    // actually ship, rather than the fixed three notices in the full fixture.
    const compiled = await json(path.join(packageDir, 'game'));
    check(compiled.schema === 'noveltea.compiled.project' && Array.isArray(compiled.resources?.assets),
      'Native runtime package has no compiled Asset inventory.');
    const packagedAssets = new Set(compiled.resources.assets.map((asset) => asset.id));
    const expectedNotices = new Set(
      (authored.settings?.distributionNotices ?? []).map((notice) => notice.path),
    );
    const assetRecords = (await walk(path.join(project, 'records/assets')))
      .filter((file) => file.endsWith('.yaml'));
    for (const file of assetRecords) {
      const asset = parseYaml(await readFile(file, 'utf8'));
      if (!packagedAssets.has(asset.id)) continue;
      for (const attachment of asset.data?.attachments ?? [])
        if (attachment.purpose === 'distribution-notice') expectedNotices.add(attachment.path);
    }
    const actualNotices = new Set(notices.notices.map((notice) => notice.source));
    check(notices.notices.length === expectedNotices.size &&
      actualNotices.size === expectedNotices.size &&
      [...expectedNotices].every((source) => actualNotices.has(source)),
    'Native runtime package Project license notices do not match the shipped Assets and Project.');
    for (const notice of notices.notices) {
      check(safe(notice.path) && `sha256:${await sha(path.join(packageDir, notice.path))}` === notice.contentHash,
        `Project license notice digest does not match packaged bytes: ${notice.path}`);
    }
    let licenseCatalog;
    if (descriptor.platform !== 'android') {
      const engineIndex = descriptor.platform === 'macos'
        ? 'Contents/Resources/licenses/index.json' : descriptor.platform === 'linux'
          ? 'share/licenses/index.json' : 'licenses/index.json';
      const candidates = [engineIndex, 'assets/system/licenses/index.json', 'licenses/index.json',
        'Contents/Resources/assets/system/licenses/index.json'];
      let catalogBytes;
      for (const relative of candidates) {
        if (!inventory.has(relative)) continue;
        const bytes = await readFile(path.join(exported, relative));
        const index = JSON.parse(bytes);
        if (index.format !== 'noveltea.engine-licenses' || !Array.isArray(index.components)) continue;
        check(index.components.length > 0, 'Engine license index has no components.');
        for (const component of index.components)
          for (const license of component.files) {
            const file = descriptor.platform === 'macos' ? path.join('Contents/Resources', license.path)
              : descriptor.platform === 'linux' ? path.join('share', license.path) : license.path;
            check(inventory.has(file.split(path.sep).join('/')) || inventory.has(license.path),
              `Exported engine license text is missing: ${license.path}`);
          }
        catalogBytes = bytes;
        licenseCatalog = { engineNotices: index.components.length, projectNotices: notices.notices.length,
          catalogSha256: digest(catalogBytes), verified: true };
        break;
      }
      check(licenseCatalog, 'Native export has no verifiable engine license catalog.');
    }
    const web = profile.web;
    const sourceRevision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const evidence = {
      format: 'noveltea-canonical-export-fixture',
      producer: 'native-cli', sourceRevision, fixtureRevision: authored.project.version,
      target: descriptor.platform, architecture: descriptor.architecture, buildFlavor: descriptor.buildFlavor,
      templateId: descriptor.templateId, templateBuildId: descriptor.buildId,
      runtimePackageSha256: digest(packageBytes), profileSha256: digest(JSON.stringify(profile)),
      projectSha256: digest(source), outputManifestSha256: await sha(manifestFile),
      compiledProjectFormatVersion: deployment.compiledProjectFormatVersion,
      playerRuntimeApiVersion: deployment.playerRuntimeApiVersion, packageAccessMode: deployment.packageAccess,
      ...(licenseCatalog ? { licenseCatalog } : {}),
      ...(descriptor.platform === 'web' ? { webBasePath: web.basePath, webThreaded: web.threaded } : {}),
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`Verified native ${descriptor.platform} export and produced ${evidencePath}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
