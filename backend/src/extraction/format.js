const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** '30-07-2026' | '30-Jul-2026' | '30 Jul 2026' -> '2026-07-30' (ISO). Returns null if unparseable. */
function parseDateToIso(raw) {
  if (!raw) return null;
  const s = raw.trim();

  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
  if (m) {
    const [, dd, monName, yyyy] = m;
    const mm = MONTHS[monName.slice(0, 3).toLowerCase()];
    if (mm) return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
  }

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  return null;
}

/** 'Rs. 10,00,000' | '₹24,800' | '24800' -> 1000000 | 24800 | 24800. Returns null if unparseable. */
function parseCurrency(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[₹,]|Rs\.?/gi, '').trim();
  const n = Number(cleaned.match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

/** 'Age 41' | '41 years' | '41' -> 41 */
function parseAge(raw) {
  if (!raw) return null;
  const n = Number(raw.match(/\d+/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

function titleCase(raw) {
  if (!raw) return raw;
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

module.exports = { parseDateToIso, parseCurrency, parseAge, titleCase };
