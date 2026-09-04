/**
 * gogogo-frontend design system — Tailwind theme preset
 * Colors/type/radius mirror this repo's real "Clean Modern" brand
 * (apps/storefront/static/app.css, packages/web-ui/views/_theme.njk).
 * Layout/component structure was reverse-engineered from gogogo.id.
 *
 * Usage (Tailwind v3):  presets: [require('./tailwind.preset.js')]
 * This repo runs Tailwind v4 (@theme in CSS) — port these into an @theme
 * block instead of using this file directly; kept here as a portable spec.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        paper: '#f6f8fb',
        card: '#ffffff',
        sand: '#eef1f6',
        line: '#e3e8ef',
        ink: { DEFAULT: '#1b2330', soft: '#5a6473', faint: '#677288' },
        pine: { DEFAULT: '#2563eb', dark: '#1d4ed8', tint: '#e6effe' },
        grass: { DEFAULT: '#16a34a', dark: '#15803d', tint: '#e7f6ec' },
        amberx: { DEFAULT: '#b45c0a', tint: '#fdedcf' },
        rust: { DEFAULT: '#dc2626', dark: '#b91c1c', tint: '#fde7e7' },

        // semantic aliases
        bg: '#f6f8fb',
        surface: '#ffffff',
        'surface-raised': '#eef1f6',
        'text-muted': '#5a6473',
        'text-disabled': '#677288',
      },
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs: ['12px', { lineHeight: '1' }],
        sm: ['13px', { lineHeight: '1.25' }],
        base: ['16px', { lineHeight: '1.5' }],   // storefront field text (mobile, iOS-zoom safe)
        'base-desktop': ['14px', { lineHeight: '1.5' }],
        md: ['16px', { lineHeight: '1.5' }],
        lg: ['18px', { lineHeight: '1.4' }],       // .section-title
        xl: ['24px', { lineHeight: '1.3', letterSpacing: '-0.025em' }], // .page-title (mobile)
        '2xl': ['30px', { lineHeight: '1.2', letterSpacing: '-0.025em' }], // .page-title (desktop), .stat-value
      },
      fontWeight: { normal: '400', medium: '500', semibold: '600', bold: '700' },
      letterSpacing: {
        tight: '-0.025em', normal: '0', wide: '0.03em', wider: '0.05em',
      },
      borderRadius: {
        xs: '4px', sm: '8px', md: '12px', lg: '16px', full: '9999px',
      },
      boxShadow: {
        none: 'none',
        soft: '0 1px 2px rgba(16,24,40,.04), 0 8px 24px -14px rgba(16,24,40,.12)',
        lift: '0 2px 4px rgba(16,24,40,.06), 0 16px 36px -18px rgba(16,24,40,.18)',
        focus: '0 0 0 3px rgba(37,99,235,.35)',
      },
      spacing: {
        card: '1.25rem',
        'card-lg': '1.5rem',
        'tap-target': '2.75rem', // 44px WCAG/iOS minimum
        'bottom-nav': '56px',
      },
      maxWidth: {
        content: '1152px',
        prose: '768px',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0.22, 1, 0.36, 1)', // this repo's "rise" ease-out
      },
      transitionDuration: {
        DEFAULT: '150ms',
        entrance: '500ms',
      },
      screens: {
        sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px',
      },
    },
  },
};
