/**
 * Display helpers for the Rule details examples.
 *
 * Dates stay 'YYYY-MM-DD' strings end to end and are shifted with UTC maths:
 * formatting a Date in the browser's local zone is how a date lands a day
 * early in IST elsewhere in this app, and an example must not do that.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08-12' -> '12-Aug-2026'. */
export function formatDay(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : '—';
}

/** '2026-08-12' + 3 -> '2026-08-15'. */
export function addDays(iso: string, days: number): string {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days between two 'YYYY-MM-DD' strings. */
export function dayGap(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/** 150000 -> '₹1,50,000'; 4999.5 -> '₹4,999.50'. */
export function inr(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const fraction = Math.round(n * 100) % 100 !== 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: fraction ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function dayWord(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

export function text(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}
