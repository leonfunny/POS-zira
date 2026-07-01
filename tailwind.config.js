/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff7f2',
          100: '#fde9dd',
          200: '#f6cbb6',
          300: '#eea98a',
          400: '#e38462',
          500: '#da7756',
          600: '#c5684a',
          700: '#a9533a',
          800: '#7f3f2d',
          900: '#5e2e21',
        },
        slate: {
          50: '#faf9f7',
          100: '#f3f2ef',
          200: '#e8e5e0',
          300: '#d4d0c8',
          400: '#b0aba3',
          500: '#8a8680',
          600: '#6b6760',
          700: '#4f4b45',
          800: '#2f2c28',
          900: '#1a1915',
        },
      },
      fontFamily: {
        sans: ['"Bahnschrift"', '"Segoe UI Variable Text"', '"Segoe UI"', 'Tahoma', 'sans-serif'],
        display: ['"Sitka Display"', '"Bahnschrift"', '"Segoe UI"', 'Tahoma', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 12px 40px rgba(26, 25, 21, 0.08)',
      },
    },
  },
  plugins: [],
}
