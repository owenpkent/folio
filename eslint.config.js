import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'playwright-report',
      'src-tauri/target',
      'src-tauri/gen',
      '**/out',
      // Vendored, self-hosted OCR runtime (minified worker + wasm glue).
      'public/tesseract',
      'extensions/vscode/fuzz/_*.cjs',
      'extensions/chrome/dist',
      'extensions/chrome/icons',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Node-side config, build, and script files (e.g. the VS Code extension's
    // build.mjs and fuzz harnesses).
    files: ['*.config.{js,ts}', 'vite.config.ts', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Chrome extension service worker: webextension + service worker globals.
    files: ['extensions/chrome/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } },
  },
);
