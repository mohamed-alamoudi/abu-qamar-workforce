import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts', '**/coverage/**', '**/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': ['error', { allow: ['^reflect-metadata$'] }],
    },
  },
  {
    files: ['apps/api/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', __dirname: 'readonly' } },
  },
  {
    files: ['**/*.spec.ts', '**/*.int-spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly', Response: 'readonly' } },
  },
];
