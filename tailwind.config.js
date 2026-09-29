/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 语义化暖色调色板：颜色值由 CSS 变量提供（亮色 :root / 暗色 html.dark）
        appbg: 'rgb(var(--c-bg) / <alpha-value>)',
        sidebar: 'rgb(var(--c-sidebar) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        inset: 'rgb(var(--c-inset) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        dim: 'rgb(var(--c-dim) / <alpha-value>)',
        brand: 'rgb(var(--c-brand) / <alpha-value>)',
        brandHover: 'rgb(var(--c-brand-hover) / <alpha-value>)',
        brandSoft: 'rgb(var(--c-brand-soft) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['Menlo', 'Monaco', 'Consolas', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
