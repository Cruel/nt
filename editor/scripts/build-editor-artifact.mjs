import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  createStage,
  distributionRoot,
  editorRoot,
  findPackagedApplication,
  runCommand,
  writeJson,
} from './editor-distribution-lib.mjs';
import { verifyPackagedEditor } from './verify-packaged-editor.mjs';

const argumentsList = process.argv.slice(2);
let mode = null;
let releaseTag;
let keepStage = false;
let build = true;

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--stage' || argument === '--dir' || argument === '--artifact') {
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
  await runCommand('pnpm', builderArguments(stageRoot), {
    cwd: editorRoot,
    label: mode === 'dir' ? 'package' : 'artifact',
    env: {
      ...process.env,
      NOVELTEA_STAGE_ROOT: stageRoot,
      NOVELTEA_BUILDER_OUTPUT: transactionOutput,
      CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false',
    },
  });
  const transactionApplication = await findPackagedApplication(transactionOutput);
  await verifyPackagedEditor(transactionApplication);
  await mkdir(path.dirname(finalRoot), { recursive: true });
  await rm(finalRoot, { recursive: true, force: true });
  await rename(transactionOutput, finalRoot);
  const finalApplication = await findPackagedApplication(finalRoot);
  const verification = await verifyPackagedEditor(finalApplication);
  const pointer = {
    mode,
    stageRoot,
    outputRoot: finalRoot,
    executable: finalApplication.executable,
    resources: finalApplication.resources,
    version: identity.version,
    releaseTag: identity.releaseTag,
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
