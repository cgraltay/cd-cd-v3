const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
  { ignores: ['actions/*/dist/**'] },
  { ...js.configs.recommended, files: ['**/*.js'] },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts']
  })),
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node
    }
  },
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs' }
  }
];
