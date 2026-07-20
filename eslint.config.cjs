'use strict';

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'data/**', 'reports/**', 'backups/**', 'exports/**'],
  },
  {
    files: ['src/routes/**/*.js', 'src/deploymentControl.js', 'src/releaseManager.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-shadow-restricted-names': 'error',
    },
  },
  {
    files: ['public/modules/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        Error: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
    },
  },
];
