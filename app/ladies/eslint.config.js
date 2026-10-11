import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Local-time Date methods are banned: all day/time logic must go through src/shared/time.ts (JST, UTC+9 fixed).
const localTimeMethods = [
  'getHours',
  'getMinutes',
  'getDate',
  'getDay',
  'getMonth',
  'getFullYear',
  'setHours',
  'setMinutes',
  'setSeconds',
  'setDate',
  'setMonth',
  'setFullYear',
  'getTimezoneOffset',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];

// Plan 3 boundaries (spec 1.3, plan §6): Playwright never drives production code; the shared protocol and the extension
// stay free of Node and of the stores/server; the content script never talks to the network; the service worker has no DOM.
const noPlaywright = {
  paths: ['@playwright/test', 'playwright', 'playwright-core'].map((name) => ({ name, message: 'Playwright はテスト専用です' })),
  patterns: [{ group: ['@playwright/test/*', 'playwright/*', 'playwright-core/*'], message: 'Playwright はテスト専用です' }],
};
const noNodeOrStores = [
  { group: ['node:*'], message: '拡張機能と共有の protocol では node:* を使いません' },
  { group: ['**/storage/**', '**/server/**'], message: '拡張機能と共有の protocol からは保存処理やサーバーを読み込みません' },
];
const globals = (names, message) => names.map((name) => ({ name, message }));
const forbiddenChromeApis = '/^(webRequest|cookies|debugger)$/';

export default defineConfig(
  {
    ignores: ['dist/', 'node_modules/', '.superpowers/', 'docs/', '.claude/', 'apps/extension/dist/', 'apps/extension/dist-e2e/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-properties': [
        'error',
        ...localTimeMethods.map((property) => ({
          property,
          message: 'JST関数を使う',
        })),
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'apps/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', noPlaywright] },
  },
  {
    files: ['src/shared/protocol/**/*.ts', 'apps/extension/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: noPlaywright.paths, patterns: [...noPlaywright.patterns, ...noNodeOrStores] }] },
  },
  {
    files: ['apps/extension/src/content/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', ...globals(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'], '通信は service worker だけが行います')] },
  },
  {
    files: ['apps/extension/src/sw/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', ...globals(['window', 'document', 'localStorage'], 'service worker に DOM はありません')] },
  },
  {
    files: ['apps/extension/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]", message: 'ページの文字列を HTML として入れません' },
        { selector: "CallExpression[callee.name='eval']", message: 'eval は使いません' },
        { selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']", message: 'Function による実行は使いません' },
        { selector: `MemberExpression[object.name='chrome'][property.name=${forbiddenChromeApis}]`, message: 'この chrome API は使いません（spec 1.1-R09）' },
        { selector: `MemberExpression[object.name='chrome'][property.value=${forbiddenChromeApis}]`, message: 'この chrome API は使いません（spec 1.1-R09）' },
      ],
    },
  },
);
