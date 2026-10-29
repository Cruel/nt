import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';
import { cliLazyModulePolicy, cliStartupPolicy } from './scripts/cli-startup-policy';
import { nativeProductionProvenance } from './scripts/native-production-provenance';
import { readNovelTeaBuildIdentity, readNovelTeaVersion } from '../scripts/noveltea-version.mjs';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(editorRoot, '..');
const { version: productVersion } = readNovelTeaVersion(repositoryRoot);
const buildIdentity = readNovelTeaBuildIdentity(repositoryRoot);
const nodeRuntimeExternals = [
  ...new Set(builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`])),
];
const electronRuntimeExternals = [
  ...nodeRuntimeExternals,
  'electron',
  'node-pty',
  'sharp',
  /^sharp\//,
];
const productionBuild = process.env.NODE_ENV === 'production';
const editorCheckInputs = [
  'src/**/*',
  'scripts/**/*',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'electron-builder.config.mjs',
];

function shouldBundleNodeDependency(id: string): boolean {
  if (id === 'electron' || id === 'node-pty' || id === 'sharp' || id.startsWith('sharp/'))
    return false;
  const withoutNodeProtocol = id.startsWith('node:') ? id.slice(5) : id;
  return !builtinModules.includes(withoutNodeProtocol);
}

const commonNodePack = {
  platform: 'node' as const,
  target: 'node24.18',
  define: {
    __NOVELTEA_VERSION__: JSON.stringify(productVersion),
    __NOVELTEA_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
  },
  sourcemap: !productionBuild,
  hash: false,
  treeshake: true,
  deps: {
    neverBundle: electronRuntimeExternals,
    alwaysBundle: shouldBundleNodeDependency,
  },
};

export default defineConfig({
  base: './',
  define: {
    __NOVELTEA_VERSION__: JSON.stringify(productVersion),
    __NOVELTEA_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    TanStackRouterVite({
      routesDirectory: path.resolve(editorRoot, 'src/renderer/routes'),
      generatedRouteTree: path.resolve(editorRoot, 'src/renderer/routeTree.gen.ts'),
      routeTreeFileHeader: ['// @ts-nocheck', '// noinspection JSUnusedGlobalSymbols'],
      quoteStyle: 'single',
    }),
    react(),
    tailwindcss(),
    nativeProductionProvenance(editorRoot),
  ],
  resolve: {
    alias: {
      '@': path.resolve(editorRoot, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(editorRoot, 'dist-electron/renderer'),
    emptyOutDir: true,
    sourcemap: !productionBuild,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    css: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'html', 'json', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/**/test/**',
        'src/**/test-support/**',
        'src/**/*.gen.ts',
        'src/renderer/components/ui/**',
      ],
      reportOnFailure: true,
    },
  },
  fmt: {
    ignorePatterns: [
      'coverage/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'node_modules/**',
      'src/renderer/routeTree.gen.ts',
      'src/renderer/test/fixtures/compiled-project-golden/**',
      'src/renderer/test/fixtures/compiled-project-runtime/**',
    ],
    printWidth: 100,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    sortPackageJson: false,
  },
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn', 'react'],
    categories: {
      correctness: 'warn',
    },
    env: {
      builtin: true,
    },
    ignorePatterns: [
      'coverage/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'node_modules/**',
      'src/renderer/routeTree.gen.ts',
    ],
    overrides: [
      {
        files: ['**/*.{ts,tsx}'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
          'no-array-constructor': 'error',
          'no-unused-expressions': 'error',
          'no-unused-vars': [
            'error',
            {
              argsIgnorePattern: '^_',
              caughtErrorsIgnorePattern: '^_',
              destructuredArrayIgnorePattern: '^_',
              ignoreRestSiblings: true,
              varsIgnorePattern: '^_',
            },
          ],
          'typescript/ban-ts-comment': 'error',
          'typescript/no-duplicate-enum-values': 'error',
          'typescript/no-empty-object-type': 'error',
          'typescript/no-explicit-any': 'error',
          'typescript/no-extra-non-null-assertion': 'error',
          'typescript/no-misused-new': 'error',
          'typescript/no-namespace': 'error',
          'typescript/no-non-null-asserted-optional-chain': 'error',
          'typescript/no-require-imports': 'error',
          'typescript/no-this-alias': 'error',
          'typescript/no-unnecessary-type-constraint': 'error',
          'typescript/no-unsafe-declaration-merging': 'error',
          'typescript/no-unsafe-function-type': 'error',
          'typescript/no-wrapper-object-types': 'error',
          'typescript/prefer-as-const': 'error',
          'typescript/prefer-namespace-keyword': 'error',
          'typescript/triple-slash-reference': 'error',
          'react/rules-of-hooks': 'error',
          'react/exhaustive-deps': 'warn',
        },
        env: {
          es2026: true,
          browser: true,
          node: true,
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },
  run: {
    tasks: {
      'check:tooling': {
        command: 'vp fmt . --check && vp lint . --deny-warnings',
        cache: true,
        input: editorCheckInputs,
        output: [],
      },
      'check:select-contract': {
        command: 'node scripts/check-select-contract.mjs',
        cache: true,
        input: [
          'src/renderer/**/*.ts',
          'src/renderer/**/*.tsx',
          'scripts/check-select-contract.mjs',
        ],
        output: [],
      },
      'check:types': {
        command: 'tsc --noEmit',
        dependsOn: ['check:tooling', 'check:select-contract'],
        cache: true,
        input: editorCheckInputs,
        output: [],
      },
      'check:schema-version-policy:run': {
        command:
          'cmake -DSOURCE_ROOT=.. -DCONTRACTS=../cmake/schema_version_policy/contracts.tsv -DRULES=../cmake/schema_version_policy/rules.tsv -DEXCEPTIONS=../cmake/schema_version_policy/exceptions.tsv -P ../cmake/CheckSchemaVersionPolicy.cmake',
        input: [
          'src/**/*',
          'assets/comfyui/**/*',
          '../engine/src/render/material_codec.cpp',
          '../cmake/CheckSchemaVersionPolicy.cmake',
          '../cmake/schema_version_policy/contracts.tsv',
          '../cmake/schema_version_policy/rules.tsv',
          '../cmake/schema_version_policy/exceptions.tsv',
        ],
        output: [],
      },
      'check:graph-field-metadata': {
        command: 'node scripts/generate-authoring-graph-field-metadata.mjs --check',
        cache: true,
        input: ['src/shared/**/*', 'scripts/generate-authoring-graph-field-metadata.mjs'],
        output: [],
      },
      'check:native-schema': {
        command: 'node scripts/generate-native-schema.mjs --check',
        cache: true,
        input: [
          'src/shared/**/*',
          'scripts/native-schema/**/*',
          'scripts/generate-native-schema.mjs',
          'package.json',
          '../pnpm-lock.yaml',
          '../.node-version',
          '../tools/project_authoring/generated/*',
        ],
        output: [],
      },
      'check:all': {
        command: 'node -e "process.exit(0)"',
        dependsOn: [
          'check:types',
          'check:schema-version-policy:run',
          'check:graph-field-metadata',
          'check:native-schema',
        ],
        cache: true,
        input: [],
        output: [],
      },
      'test:unit': {
        command: 'vp test run',
        cache: true,
        output: [],
      },
      'compile:renderer': {
        command: 'vp build',
        cache: true,
        output: ['dist-electron/renderer/**'],
      },
      'compile:electron': {
        command: 'vp pack',
        dependsOn: ['check:graph-field-metadata'],
        cache: true,
        output: [
          'dist-electron/main/**',
          'dist-electron/authoring-worker/**',
          'dist-electron/preload/**',
          'dist-electron/tools/**',
          'dist-scriptc-island/**',
        ],
      },
      'validate:bundles': {
        command: 'node scripts/validate-bundle-policy.mjs',
        dependsOn: ['compile:electron', 'compile:renderer'],
        cache: true,
        output: [],
      },
      'build:all': {
        command: 'node -e "process.exit(0)"',
        dependsOn: ['check:types', 'compile:renderer', 'validate:bundles'],
        cache: true,
        output: [],
      },
    },
  },
  pack: [
    {
      ...commonNodePack,
      name: 'electron-main',
      plugins: [nativeProductionProvenance(editorRoot)],
      deps: {
        ...commonNodePack.deps,
        onlyBundle: [
          'chokidar',
          'debug',
          'ms',
          'pe-library',
          'readdirp',
          'resedit',
          'saxes',
          'xmlchars',
          'yaml',
          'zod',
        ],
      },
      entry: { main: 'src/main.ts' },
      format: 'cjs',
      outDir: 'dist-electron/main',
      fixedExtension: true,
      clean: true,
      checks: { legacyCjs: false },
      outputOptions: { codeSplitting: false },
    },
    {
      ...commonNodePack,
      name: 'native-authoring-worker',
      plugins: [nativeProductionProvenance(editorRoot)],
      entry: { 'native-authoring-worker': 'src/main/services/native-authoring-worker.ts' },
      format: 'cjs',
      outDir: 'dist-electron/authoring-worker',
      fixedExtension: true,
      clean: true,
      checks: { legacyCjs: false },
      outputOptions: { codeSplitting: false },
    },
    {
      ...commonNodePack,
      name: 'electron-preload',
      plugins: [nativeProductionProvenance(editorRoot)],
      deps: {
        ...commonNodePack.deps,
        onlyBundle: [],
      },
      entry: { preload: 'src/preload.ts' },
      format: 'cjs',
      outDir: 'dist-electron/preload',
      fixedExtension: true,
      clean: true,
      checks: { legacyCjs: false },
      outputOptions: { codeSplitting: false },
    },
    {
      ...commonNodePack,
      name: 'node-tools',
      plugins: [
        cliStartupPolicy(
          'Native Node CLI candidate',
          path.join(editorRoot, 'scripts/noveltea-native.ts'),
        ),
        nativeProductionProvenance(editorRoot),
      ],
      deps: {
        ...commonNodePack.deps,
        onlyBundle: ['zod', 'resedit', 'pe-library', 'saxes', 'xmlchars', 'yaml'],
      },
      entry: {
        noveltea: 'scripts/noveltea-native.ts',
      },
      format: 'esm',
      outDir: 'dist-electron/tools',
      fixedExtension: true,
      clean: true,
      outputOptions: { codeSplitting: true },
    },
    {
      ...commonNodePack,
      name: 'scriptc-island',
      plugins: [
        cliStartupPolicy(
          'ScriptC island',
          path.join(editorRoot, 'scripts/noveltea-scriptc-island.ts'),
        ),
        cliLazyModulePolicy(
          'Native ScriptC application',
          path.join(editorRoot, 'src/cli/native-application.ts'),
        ),
        nativeProductionProvenance(editorRoot),
      ],
      deps: {
        ...commonNodePack.deps,
        neverBundle: [
          ...electronRuntimeExternals,
          'noveltea-scriptc-agent-kit-source',
          'noveltea-scriptc-comfyui-workflows',
        ],
        onlyBundle: ['pe-library', 'resedit', 'saxes', 'xmlchars', 'yaml', 'zod'],
      },
      entry: { 'noveltea-scriptc-island': 'scripts/noveltea-scriptc-island.ts' },
      format: 'esm',
      outDir: 'dist-scriptc-island',
      fixedExtension: true,
      clean: true,
      checks: { legacyCjs: false },
      outputOptions: { codeSplitting: true },
      sourcemap: false,
    },
  ],
});
