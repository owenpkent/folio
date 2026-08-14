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
      // Staged extension output: a copy of the built web app, plus the
      // extension sources that are linted at their real location.
      'extensions/chrome/build',
      // Output of the pre-Phase-4 build, which staged in place instead of
      // into build/ (see extensions/chrome/.gitignore, which still lists
      // these for the same reason: git does not remove ignored files on
      // pull, so a contributor who built before that change still has them
      // on disk). The top-level 'dist' pattern above does not cover these:
      // ESLint's ignore patterns are not gitignore-style path globbing, so
      // an unanchored 'dist' only matches a literal top-level ./dist, not
      // extensions/chrome/dist -- verified by lint-ing a file planted there.
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
      // Name the two react-hooks rules instead of spreading the plugin's
      // `recommended` preset. In react-hooks 7 that preset also carries the
      // React Compiler rules, taking it from 2 rules to 16 and turning on 12
      // errors nobody here opted into. Adopting those is a real decision with
      // real work behind it -- several in-flight branches mutate module scope
      // from effects and would fail them -- so it should land as its own change,
      // not arrive because an upstream preset grew.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // A placed overlay (text box, image, check mark, signature) is a focusable
      // composite: `role="group"` with a name, an accessible description of its
      // keys, and a keydown handler that moves and resizes it (see
      // src/a11y/useNudgeKeys.ts). ARIA allows a focusable group -- the APG's
      // own toolbar and grid patterns rely on it -- but both rules below assume
      // any non-widget role is inert, which is the false positive they are known
      // for. Allowlisting `group` specifically keeps them enforcing everywhere
      // else, rather than scattering per-line disables across four layers.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { tags: [], roles: ['group'] }],
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        { handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyUp'] },
      ],
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
  {
    // The options page is a document, not a worker: it needs the DOM globals
    // the block above deliberately withholds.
    files: ['extensions/chrome/options.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    // Extension unit tests run under Vitest in Node, not in the browser, so
    // they get Node's globals rather than the service worker's.
    files: ['extensions/chrome/**/*.test.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
