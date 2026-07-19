import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';

const stageRoot = process.env.NOVELTEA_STAGE_ROOT?.trim();
const outputRoot = process.env.NOVELTEA_BUILDER_OUTPUT?.trim();

if (!stageRoot || !outputRoot) {
  throw new Error(
    'electron-builder requires NOVELTEA_STAGE_ROOT and NOVELTEA_BUILDER_OUTPUT from build-editor-artifact.mjs.',
  );
}

const stageManifest = JSON.parse(readFileSync(path.join(stageRoot, 'stage-manifest.json'), 'utf8'));

function packagedExecutable(context) {
  const candidates =
    context.electronPlatformName === 'darwin'
      ? [
          path.join(
            context.appOutDir,
            'NovelTea Editor.app',
            'Contents',
            'MacOS',
            'noveltea-editor',
          ),
          path.join(
            context.appOutDir,
            'NovelTea Editor.app',
            'Contents',
            'MacOS',
            'NovelTea Editor',
          ),
        ]
      : [
          path.join(
            context.appOutDir,
            context.electronPlatformName === 'win32' ? 'noveltea-editor.exe' : 'noveltea-editor',
          ),
        ];
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(`Unable to locate the packaged Electron executable in ${context.appOutDir}.`);
  }
  return executable;
}

const completeFusePolicy = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

export default {
  appId: 'org.noveltea.editor',
  productName: 'NovelTea Editor',
  executableName: 'noveltea-editor',
  electronVersion: stageManifest.runtime.electronVersion,
  artifactName: 'NovelTea-Editor-${version}-${os}-${arch}.${ext}',
  asar: true,
  asarUnpack: ['node_modules/sharp/**/*', 'node_modules/@img/**/*'],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  removePackageScripts: true,
  removePackageKeywords: true,
  forceCodeSigning: false,
  files: [
    'package.json',
    'dist-electron/**/*',
    'node_modules/**/*',
    '!node_modules/.cache{,/**/*}',
    '!node_modules/**/{test,tests,__tests__,coverage,fixtures}/**/*',
  ],
  extraResources: [
    {
      from: path.join(stageRoot, 'resources', 'engine-preview'),
      to: 'engine-preview',
      filter: ['**/*'],
    },
    {
      from: path.join(stageRoot, 'resources', 'editor-assets'),
      to: 'editor-assets',
      filter: ['**/*'],
    },
    {
      from: path.join(stageRoot, 'resources', 'bin'),
      to: 'bin',
      filter: ['**/*'],
    },
  ],
  directories: {
    output: outputRoot,
  },
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  afterPack: async (context) => {
    await flipFuses(packagedExecutable(context), completeFusePolicy);
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
    category: 'Development',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : null,
  },
};
