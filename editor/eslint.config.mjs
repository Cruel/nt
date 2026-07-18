import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'coverage',
      'dist',
      'out',
      '.vite',
      'node_modules',
      'src/renderer/routeTree.gen.ts',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  {
    extends: [tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // eslint-plugin-react-hooks 7 expands its recommended preset with
      // React Compiler diagnostics. The editor does not enable the React
      // Compiler, so retain the established Hooks correctness contract
      // without turning a dependency refresh into a compiler-adoption pass.
      'react-hooks/rules-of-hooks': reactHooks.configs.recommended.rules['react-hooks/rules-of-hooks'],
      'react-hooks/exhaustive-deps': reactHooks.configs.recommended.rules['react-hooks/exhaustive-deps'],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
);
