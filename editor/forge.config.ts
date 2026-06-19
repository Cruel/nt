import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'NovelTea Editor',
    executableName: 'noveltea-editor',
    // TODO: Add macOS signing/notarization with CI secrets when distribution identity is available.
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      const source = path.resolve(__dirname, '..', 'build', 'web-release', 'apps', 'sandbox');
      if (!existsSync(path.join(source, 'index.html'))) {
        return;
      }
      const destination = path.resolve(buildPath, '..', 'engine-preview');
      mkdirSync(destination, { recursive: true });
      const runtimeExtensions = new Set([
        '.html',
        '.js',
        '.mjs',
        '.wasm',
        '.data',
        '.css',
        '.json',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.svg',
        '.ttf',
        '.woff',
        '.woff2',
      ]);
      for (const entry of readdirSync(source)) {
        const from = path.join(source, entry);
        if (statSync(from).isFile() && runtimeExtensions.has(path.extname(entry))) {
          cpSync(from, path.join(destination, entry));
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({
      // TODO: Add Windows Authenticode signing through CI secrets before public distribution.
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
