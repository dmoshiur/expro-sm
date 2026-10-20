/**
 * Tailwind is used for utilities only. Preflight is off so the existing plain
 * CSS base (src/styles/app.css) keeps rendering exactly as before.
 *
 * Theme: Professional light-blue gradient (sky palette). Use the custom
 * `bg-brand-gradient` / `bg-brand-hero` backgrounds for hero + header surfaces,
 * `shadow-soft` for low-spread card shadows, and `rounded-2xl` for cards.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #38bdf8 0%, #0284c7 55%, #0369a1 100%)',
        'brand-hero': 'linear-gradient(150deg, #0284c7 0%, #0369a1 60%, #075985 100%)',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06)',
        'soft-lg': '0 12px 32px rgba(3, 105, 161, 0.18)',
      },
    },
  },
  plugins: [],
};
