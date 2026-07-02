import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'

/**
 * Flat ESLint config. Enforces the house style automatically — no semicolons,
 * single quotes, 2-space indent — across the Express server (Node) and the Vue
 * frontend (browser).
 */
const style = {
  '@stylistic/semi': ['error', 'never'],
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
  '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
  '@stylistic/comma-dangle': ['error', 'never'],
  '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
  '@stylistic/eol-last': ['error', 'always']
}

export default [
  { ignores: ['dist/**', '**/dist/**', 'node_modules/**', 'data/**', 'uploads/**', 'coverage/**', 'public/**'] },

  js.configs.recommended,
  ...vue.configs['flat/essential'],

  {
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module'
    },
    rules: {
      ...style,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },

  // Server runs on Node. `@carelane/core` is host-agnostic but relies only on
  // globals present in both Node and React Native (Buffer, console, JSON, …).
  {
    files: ['server/**/*.js', 'packages/**/*.js', '*.config.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } }
  },

  // Frontend runs in the browser; tests run under Node + Vitest globals.
  {
    files: ['src/**/*.{js,vue}'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node } }
  },

  // In Vue SFCs let the Vue plugin own template indentation.
  {
    files: ['**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
      // The app intentionally passes a mutable `settings` object to section
      // components (e.g. BrandingSettings) which edit it then emit `save`.
      'vue/no-mutating-props': 'off',
      '@stylistic/indent': 'off'
    }
  }
]
