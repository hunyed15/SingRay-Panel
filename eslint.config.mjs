// ESLint 扁平配置。
// 定位:抓"真问题"(未使用的变量、错误的比较、可疑的空块),不做风格警察 ——
// 风格由 prettier/编辑器负责。类型感知规则暂不开启(会要求每个包都配置 project,
// 跑一次要几十秒);需要时按包逐步接 recommendedTypeChecked。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TS 自己管作用域,no-undef 在 TS 里只会误报(DOM/Node 全局)
      'no-undef': 'off',
      'no-console': 'off',
      // 这套代码里 any 主要出现在 SQLite 行映射,收紧需要先建行类型
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // catch {} 是本仓库的显式风格(吞错有注释说明)
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // 中文界面里会用到全角空格/不间断空格,这是文案不是排版错误
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true, skipComments: true, skipJSXText: true },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // 前端:hooks 依赖检查(代码里已有 eslint-disable-next-line react-hooks/exhaustive-deps)
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/exhaustive-deps': 'warn' },
  },
);
