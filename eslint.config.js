// eslint.config.js — Configuración ESLint flat (ESM)
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Calidad básica
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': 'off', // Permitido en servidor/bot
      'no-constant-condition': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'curly': ['error', 'all'],
      'block-scoped-var': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'warn',
      'prefer-template': 'warn',
      'no-duplicate-imports': 'error',
      'no-restricted-syntax': [
        'error',
        'WithStatement',
        'LabeledStatement',
        'DebuggerStatement'
      ],
    },
  },
  {
    // Tests: reglas más permisivas
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // Config files
    files: ['*.config.js', '*.config.mjs', 'ecosystem.config.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      '@eslint/js/no-undef': 'off',
    },
  },
];