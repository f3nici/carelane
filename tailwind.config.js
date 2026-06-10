/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        primary: '#2563eb',
        accent: '#14b8a6',
        deep: '#1a1a1a',
        surface: '#2d2d2d',
        mid: '#999999',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        info: '#0ea5e9'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        heading: ['Sora', 'Oswald', 'sans-serif']
      },
      borderRadius: {
        card: '14px'
      }
    }
  },
  plugins: []
}
