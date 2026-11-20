// ESLint 설정 (plan.md P6-3 · QA-43, docs/Task_ORDER.md T-224, BENCHMARK B-96)
// `npm run lint`는 정의만 있고 설정 파일이 없어 실행되지 않았다. 이미 설치된 플러그인만 쓴다(새 의존성 없음).
// Docker 빌드와 CI에서 경고 0(--max-warnings 0)으로 실행한다.
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
  },
}
