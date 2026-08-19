const unitedIndia = require('./united-india');

/**
 * Format registry. Each entry exposes matches(fullText) and parse({pageTexts}).
 * Adding a new insurer means adding one module here — the routes, DB layer,
 * and Excel mapper stay untouched, since every parser returns the same shape.
 */
const FORMATS = [{ id: 'UNITED_INDIA_FAMILY_MEDICARE', module: unitedIndia }];

function detectFormat(fullText) {
  return FORMATS.find((f) => f.module.matches(fullText)) || null;
}

function parseByFormat({ fullText, pageTexts }) {
  const format = detectFormat(fullText);
  if (!format) {
    const err = new Error(
      'Unrecognised policy layout. Supported formats: '
        + FORMATS.map((f) => f.id).join(', ')
        + '. Add a parser under src/extraction/formats/ for this insurer.',
    );
    err.code = 'UNKNOWN_FORMAT';
    throw err;
  }
  return format.module.parse({ fullText, pageTexts });
}

module.exports = { FORMATS, detectFormat, parseByFormat };
