/**
 * JS mirror of the AI Glass palette.
 *
 * Canvas and chart renderers can't read CSS custom properties — a `<canvas>`
 * 2D context takes concrete colour strings, and charting libraries resolve
 * their series colours in JS. So the handful of values those consumers need
 * are duplicated here, keyed by theme.
 *
 * This file and src/styles/_tokens.scss / _theme.scss must be changed
 * together; nothing enforces that at build time.
 */

export type ResolvedTheme = 'light' | 'dark';

/** Particle colours for the ambient aurora field. Light mode leads with the brand purple + accent orange. */
export const AURORA_PARTICLE_COLORS: Record<ResolvedTheme, readonly string[]> = {
  light: ['#7c3aed', '#a855f7', '#ea580c'],
  dark: ['#4f46e5', '#8b5cf6', '#00d9ff', '#6c5ce7', '#00f5ff'],
};

/** Chart palettes — series ramp plus the grid/axis/tooltip chrome. */
export const CHART_PALETTES: Record<ResolvedTheme, ChartPalette> = {
  light: {
    // Brand pair first (purple, then the accent orange --ai-orange — not the
    // status/"matched by auditor" #f97316), then supporting hues.
    series: [
      '#7c3aed',
      '#ea580c',
      '#a855f7',
      '#fb923c',
      '#0ea5e9',
      '#14b8a6',
      '#ec4899',
      '#6366f1',
      '#94a3b8',
      '#10b981',
    ],
    grid: 'rgba(15, 23, 42, 0.08)',
    axis: '#64748b',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e6e8ee',
    tooltipText: '#0f172a',
    bar1: '#7c3aed',
    bar2: '#ea580c',
    // The client's own colour code (green matched / amber partial-mismatch /
    // red unmatched) — status charts use these, never the brand pair, so a
    // chart can't contradict the status pills. Mirrors --success/--warning/--danger.
    matched: '#10b981',
    mismatch: '#f59e0b',
    unmatched: '#ef4444',
    neutral: '#94a3b8',
  },
  dark: {
    series: [
      '#6366f1',
      '#22d3ee',
      '#fbbf24',
      '#f87171',
      '#8b5cf6',
      '#f472b6',
      '#34d399',
      '#fb923c',
      '#94a3b8',
      '#2dd4bf',
    ],
    grid: 'rgba(148, 163, 184, 0.16)',
    axis: '#94a3b8',
    tooltipBg: '#111827',
    tooltipBorder: 'rgba(148, 163, 184, 0.24)',
    tooltipText: '#e2e8f0',
    bar1: '#6366f1',
    bar2: '#fbbf24',
    matched: '#34d399',
    mismatch: '#fbbf24',
    unmatched: '#f87171',
    neutral: '#94a3b8',
  },
};

export interface ChartPalette {
  readonly series: readonly string[];
  readonly grid: string;
  readonly axis: string;
  readonly tooltipBg: string;
  readonly tooltipBorder: string;
  readonly tooltipText: string;
  readonly bar1: string;
  readonly bar2: string;
  /** Status colours — the client's green/amber/red code, for charts that plot verdicts. */
  readonly matched: string;
  readonly mismatch: string;
  readonly unmatched: string;
  readonly neutral: string;
}

/**
 * Resolves the *effective* theme. ThemeStore stores three states — 'light',
 * 'dark' and 'system' — but canvas/chart consumers need a concrete one, so
 * 'system' has to be collapsed against the OS preference.
 */
export function resolveTheme(mode: 'light' | 'dark' | 'system'): ResolvedTheme {
  if (mode !== 'system') {
    return mode;
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
