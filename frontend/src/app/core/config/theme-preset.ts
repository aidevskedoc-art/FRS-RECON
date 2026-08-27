import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * PrimeNG preset aligned to the "AI Glass" design tokens (src/styles/_tokens.scss
 * and _theme.scss). Keeping the two in sync means PrimeNG components (p-table,
 * p-dialog, p-button...) visually match the hand-authored glass surfaces instead
 * of fighting them.
 *
 * Two deliberate asymmetries mirror the design system:
 *   - Light mode is editorial monochrome, so the "primary" ramp is a neutral ink
 *     ramp rather than a hue. Light mode's only sanctioned colour is semantic
 *     status and the KPI stat gradient.
 *   - Dark mode is the signature look, so primary becomes the electric
 *     indigo/violet ramp and the surface ramp is lifted well above the deep-space
 *     background (#050816) rather than being a shade of it.
 */
export const FrsAiPreset = definePreset(Aura, {
  semantic: {
    // Indigo ramp — the dark theme's electric primary. Light mode overrides
    // this to ink below, inside colorScheme.light.primary.
    primary: {
      50: '#eef2ff',
      100: '#e0e7ff',
      200: '#c7d2fe',
      300: '#a5b4fc',
      400: '#818cf8',
      500: '#6366f1',
      600: '#4f46e5',
      700: '#4338ca',
      800: '#3730a3',
      900: '#312e81',
      950: '#1e1b4b',
    },
    focusRing: {
      width: '2px',
      style: 'solid',
      offset: '2px',
    },
    colorScheme: {
      light: {
        // Editorial monochrome: PrimeNG's accents resolve to ink, matching
        // --brand: #0a0a0a.
        primary: {
          color: '#0a0a0a',
          contrastColor: '#ffffff',
          hoverColor: '#000000',
          activeColor: '#000000',
        },
        highlight: {
          background: '#f4f4f5',
          focusBackground: '#efeff1',
          color: '#09090b',
          focusColor: '#09090b',
        },
        focusRing: {
          color: '#0a0a0a',
        },
        // Zinc-based neutrals, matching the --neutral-* aliases in _tokens.scss.
        surface: {
          0: '#ffffff',
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
      },
      dark: {
        primary: {
          color: '#818cf8',
          contrastColor: '#050816',
          hoverColor: '#a5b4fc',
          activeColor: '#c7d2fe',
        },
        highlight: {
          background: 'rgba(99, 102, 241, 0.16)',
          focusBackground: 'rgba(99, 102, 241, 0.24)',
          color: '#f1f3fc',
          focusColor: '#f1f3fc',
        },
        focusRing: {
          color: '#818cf8',
        },
        // Deep-space ramp. 800/900/950 are the app's real backgrounds:
        // 950 = --ai-bg, 900 = --ai-bg-soft, 800 = --ai-surface (lifted).
        surface: {
          0: '#ffffff',
          50: '#f1f3fc',
          100: '#dde2f4',
          200: '#c4cbe4',
          300: '#a6afce',
          400: '#737ca0',
          500: '#4d5678',
          600: '#2c3454',
          700: '#1a2440',
          800: '#121a33',
          900: '#0b1023',
          950: '#050816',
        },
      },
    },
  },
});
