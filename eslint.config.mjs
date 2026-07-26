import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/release/**',
      '**/.turbo/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        Buffer: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        URL: 'readonly',
      },
    },
  },
];
