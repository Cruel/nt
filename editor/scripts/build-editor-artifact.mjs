import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  collectDistributableArtifacts,
  createStage,
  distributionRoot,
  editorRoot,
  findPackagedApplication,
  runCommand,
  runPnpmCommand,
  writeJson,
} from './editor-distribution-lib.mjs';
import { verifyPackagedEditor } from './verify-packaged-editor.mjs';

const argumentsList = process.argv.slice(2);
const releasePlatform =
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform;
let mode = null;
let releaseTag;
let keepStage = false;
let build = true;

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--') {
    continue;
  } else if (argument === '--stage' || argument === '--dir' || argument === '--artifact') {
    if (mode) throw new Error('Choose exactly one of --stage, --dir, or --artifact.');
    mode = argument.slice(2);
  } else if (argument === '--release-tag') {
    releaseTag = argumentsList[++index];
  } else if (argument === '--keep-stage') {
    keepStage = true;
  } else if (argument === '--skip-build') {
    build = false;
  } else {
    throw new Error(`Unknown distribution argument: ${argument}`);
  }
}

if (!mode) throw new Error('Choose one of --stage, --dir, or --artifact.');

function builderArguments(stageRoot) {
  const common = [
    'exec',
    'electron-builder',
    '--projectDir',
    path.join(stageRoot, 'app'),
    '--config',
    path.join(editorRoot, 'electron-builder.config.mjs'),
    '--publish',
    'never',
  ];
  if (mode === 'dir') {
    return [...common, '--dir', process.platform === 'darwin' ? '--arm64' : '--x64'];
  }
  if (process.platform === 'linux')
    return [...common, '--linux', 'AppImage', 'deb', 'rpm', '--x64'];
  if (process.platform === 'win32') return [...common, '--win', 'nsis', '--x64'];
  if (process.platform === 'darwin') return [...common, '--mac', 'dmg', 'zip', '--arm64'];
  throw new Error(`Unsupported packaging host: ${process.platform}`);
}

function requireInstallerText(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`${label} is missing '${expected}'.`);
}

async function verifyLinuxInstallerContracts(outputRoot, transactionRoot) {
  const artifacts = await collectDistributableArtifacts(outputRoot, 'linux');
  const deb = artifacts.find((artifact) => artifact.fileName.endsWith('.deb'));
  const rpm = artifacts.find((artifact) => artifact.fileName.endsWith('.rpm'));
  if (!deb || !rpm) throw new Error('Linux installer verification requires DEB and RPM artifacts.');

  const debPath = path.join(outputRoot, deb.fileName);
  const { stdout: debContents } = await runCommand('dpkg-deb', ['--contents', debPath], {
    capture: true,
    label: 'verify-deb-contents',
  });
  requireInstallerText(
    debContents,
    './opt/noveltea-editor/noveltea-editor',
    'DEB application payload',
  );
  requireInstallerText(
    debContents,
    './opt/noveltea-editor/resources/bin/noveltea',
    'DEB CLI payload',
  );
  if (debContents.includes('/opt/NovelTea Editor')) {
    throw new Error('DEB payload uses the retired mixed-case installation directory.');
  }

  const debControlRoot = path.join(transactionRoot, 'deb-control');
  await runCommand('dpkg-deb', ['--control', debPath, debControlRoot], {
    label: 'extract-deb-control',
  });
  const debScripts = `${await readFile(path.join(debControlRoot, 'postinst'), 'utf8')}\n${await readFile(path.join(debControlRoot, 'postrm'), 'utf8')}`;

  const rpmPath = path.join(outputRoot, rpm.fileName);
  const { stdout: rpmContents } = await runCommand('rpm', ['-qpl', rpmPath], {
    capture: true,
    label: 'verify-rpm-contents',
  });
  requireInstallerText(
    rpmContents,
    '/opt/noveltea-editor/noveltea-editor',
    'RPM application payload',
  );
  requireInstallerText(
    rpmContents,
    '/opt/noveltea-editor/resources/bin/noveltea',
    'RPM CLI payload',
  );
  if (rpmContents.includes('/opt/NovelTea Editor')) {
    throw new Error('RPM payload uses the retired mixed-case installation directory.');
  }
  const { stdout: rpmScripts } = await runCommand('rpm', ['-qp', '--scripts', rpmPath], {
    capture: true,
    label: 'verify-rpm-scripts',
  });

  for (const [command, target] of [
    ['noveltea-editor', '/opt/noveltea-editor/noveltea-editor'],
    ['noveltea', '/opt/noveltea-editor/resources/bin/noveltea'],
  ]) {
    for (const [kind, scripts] of [
      ['DEB', debScripts],
      ['RPM', rpmScripts],
    ]) {
      requireInstallerText(
        scripts,
        `install_alternative '${command}' '${target}'`,
        `${kind} install script`,
      );
      requireInstallerText(
        scripts,
        `remove_alternative '${command}' '${target}'`,
        `${kind} removal script`,
      );
    }
  }
}

async function verifyWindowsInstallerContracts() {
  const includePath = path.join(editorRoot, 'branding', 'windows', 'installer.nsh');
  const include = await readFile(includePath, 'utf8');
  for (const expected of [
    '!macro customInstall',
    '!macro customUnInstall',
    '$INSTDIR\\resources\\bin',
    'NovelTeaCliPathEntry',
    'Another noveltea.exe is already available on PATH',
    'WM_SETTINGCHANGE',
  ]) {
    requireInstallerText(include, expected, 'Windows installer include');
  }
}

const { stageRoot, identity } = await createStage({ build, keepStage, releaseTag });
if (mode === 'stage') process.exit(0);

await mkdir(distributionRoot, { recursive: true });
const transactionRoot = await mkdtemp(path.join(distributionRoot, '.builder-'));
const transactionOutput = path.join(transactionRoot, 'output');
const finalRoot = path.join(
  distributionRoot,
  mode === 'dir' ? 'packages' : 'artifacts',
  path.basename(stageRoot),
);

try {
  await runPnpmCommand(builderArguments(stageRoot), {
    cwd: editorRoot,
    label: mode === 'dir' ? 'package' : 'artifact',
    env: {
      ...process.env,
      NOVELTEA_STAGE_ROOT: stageRoot,
      NOVELTEA_BUILDER_OUTPUT: transactionOutput,
      CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false',
    },
  });
  if (mode === 'artifact' && process.platform === 'linux') {
    await verifyLinuxInstallerContracts(transactionOutput, transactionRoot);
  }
  if (mode === 'artifact' && process.platform === 'win32') {
    await verifyWindowsInstallerContracts();
  }
  await mkdir(path.dirname(finalRoot), { recursive: true });
  await rm(finalRoot, { recursive: true, force: true });
  await rename(transactionOutput, finalRoot);
  const finalApplication = await findPackagedApplication(finalRoot);
  const verification = await verifyPackagedEditor(finalApplication);
  const artifacts = mode === 'artifact' ? await collectDistributableArtifacts(finalRoot) : [];
  const pointer = {
    mode,
    stageRoot,
    outputRoot: finalRoot,
    executable: finalApplication.executable,
    resources: finalApplication.resources,
    version: identity.version,
    releaseTag: identity.releaseTag,
    platform: releasePlatform,
    architecture: process.arch,
    artifacts,
    verification,
  };
  await writeJson(
    path.join(distributionRoot, mode === 'dir' ? 'latest-package.json' : 'latest-artifact.json'),
    pointer,
  );
  console.log(`[${mode}] ${finalRoot}`);
} catch (error) {
  if (keepStage) console.error(`[builder] retained stage at ${stageRoot}`);
  throw error;
} finally {
  await rm(transactionRoot, { recursive: true, force: true });
}
