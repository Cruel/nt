import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const nodeRuntimeExternals = [
  ...new Set(builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`])),
];
const electronRuntimeExternals = [...nodeRuntimeExternals, 'electron', 'sharp', /^sharp\//];
const editorCheckInputs = [
  'src/**/*',
  'scripts/**/*',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.*.config.ts',
  'electron-builder.config.mjs',
];

function shouldBundleNodeDependency(id: string): boolean {
  if (id === 'electron' || id === 'sharp' || id.startsWith('sharp/')) return false;
  const withoutNodeProtocol = id.startsWith('node:') ? id.slice(5) : id;
  return !builtinModules.includes(withoutNodeProtocol);
}

const commonNodePack = {
  platform: 'node' as const,
  target: 'node24.18',
  sourcemap: true,
  hash: false,
  treeshake: true,
  deps: {
    neverBundle: electronRuntimeExternals,
    alwaysBundle: shouldBundleNodeDependency,
  },
};

export default defineConfig({
  base: './',
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
      quoteStyle: 'single',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(editorRoot, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(editorRoot, 'dist-electron/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    css: true,
  },
  fmt: {
    ignorePatterns: [
      'coverage/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      '.vite/**',
      'node_modules/**',
      'src/renderer/routeTree.gen.ts',
      'src/renderer/test/fixtures/compiled-project-golden/**',
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
      '.vite/**',
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
        command: 'vp fmt . --check && vp lint .',
        cache: true,
        input: editorCheckInputs,
        output: [],
      },
      'check:types': {
        command: 'tsc --noEmit',
        dependsOn: ['check:tooling'],
        cache: true,
        input: editorCheckInputs,
        output: [],
      },
      'check:all': {
        command: 'node -e "process.exit(0)"',
        dependsOn: ['check:types'],
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
        cache: true,
        output: ['dist-electron/main/**', 'dist-electron/preload/**', 'dist-electron/tools/**'],
      },
      'validate:bundles': {
        command: 'node scripts/validate-bundle-policy.mjs',
        dependsOn: ['compile:electron'],
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
      deps: {
        ...commonNodePack.deps,
        onlyBundle: ['chokidar', 'debug', 'ms', 'pe-library', 'readdirp', 'resedit', 'zod'],
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
      name: 'electron-preload',
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
      deps: {
        ...commonNodePack.deps,
        onlyBundle: ['zod'],
      },
      entry: {
        'project-compile': 'scripts/compile-project.ts',
        'generate-compiled-project-goldens': 'scripts/generate-compiled-project-goldens.ts',
      },
      format: 'esm',
      outDir: 'dist-electron/tools',
      fixedExtension: true,
      clean: true,
    },
  ],
});
