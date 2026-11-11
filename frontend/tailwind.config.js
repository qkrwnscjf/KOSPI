/** @type {import('tailwindcss').Config} */

// 색은 src/index.css의 CSS 변수(라이트·다크 두 벌)를 가리킨다 (docs/Task_ORDER.md T-54, D-35).
const token = name => `rgb(var(--color-${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        page: token('page'),
        surface: token('surface'),
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        fg: {
          DEFAULT: token('fg'),
          muted: token('fg-muted'),
        },
        up: token('up'),
        down: token('down'),
        neon: token('neon'), // 강조 1색 (T-69, D-54)
      },
      // 외부 웹 폰트를 불러오지 않고 운영체제 기본 글꼴을 쓴다 (T-44: 방문자 IP가 외부로 전달되지 않음)
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"Apple SD Gothic Neo"',
          '"Malgun Gothic"',
          '"Noto Sans KR"',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
