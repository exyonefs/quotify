import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * ESLint 扁平配置（ESLint 9+）。
 *
 * 只做「静态缺陷检查」，把格式化完全交给 Prettier（`eslint-config-prettier`
 * 关掉所有与之冲突的风格规则），避免两套规则互相打架。
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.wrangler/**',
      '.wrangler-tmp/**',
      'dist/**',
      // 由 `wrangler types` 生成，不参与检查（文件头部自带 eslint-disable）。
      'worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // 测试里大量使用「故意的 any / 非空断言」来构造边界场景。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // 数据维护脚本运行在 Node 中（不是 Worker），只补它需要的全局。
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly' },
    },
  },
);
