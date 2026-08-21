/**
 * Real insurer policy schedules are laid out as tables, so a PDF text
 * extractor emits the label and its value as separate items. Everything
 * here works on a flat array of trimmed non-empty lines and reads values
 * by their position *relative to a label*, rather than by matching
 * "Label: value" on one line (which is how a generated sample PDF looks,
 * but almost never how a real one does).
 */

function toLines(pageText) {
  return pageText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rupee glyphs extract as stray "(" / ")" / "₹" / "`" (some fonts map the
 * rupee glyph to a backtick codepoint), and a label's trailing colon can
 * end up detached on its own. None of these is ever a real value.
 */
const NOISE = /^[)(₹`:\-\s]*$/;

function isNoise(line) {
  return NOISE.test(line);
}

function indexOfLabel(lines, label, { from = 0 } = {}) {
  const target = normalize(label);
  for (let i = from; i < lines.length; i++) {
    if (normalize(lines[i]) === target) return i;
  }
  return -1;
}

function indexMatching(lines, re, { from = 0 } = {}) {
  for (let i = from; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Value that follows a label, skipping rupee-glyph noise.
 * `label` may be an exact string or a RegExp tested against each line.
 */
function valueAfter(lines, label, { skip = 0, from = 0 } = {}) {
  const idx = label instanceof RegExp
    ? indexMatching(lines, label, { from })
    : indexOfLabel(lines, label, { from });
  if (idx === -1) return null;

  let seen = 0;
  for (let i = idx + 1; i < lines.length; i++) {
    if (isNoise(lines[i])) continue;
    if (seen++ < skip) continue;
    return lines[i];
  }
  return null;
}

/** Value on the same line as the label ("Receipt Date: 16/06/2026"), else the next line. */
function valueInlineOrAfter(lines, label) {
  const escaped = escapeRe(label);
  // (.*) not (.+): a label frequently occupies its whole line ("Premium:"),
  // with the value on the next one. Requiring a character here would make
  // the whole pattern fail rather than fall through to the next line.
  const inlineRe = new RegExp(`^\\s*${escaped}\\s*[:\\-]?\\s*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(inlineRe);
    if (m) {
      const inline = m[1].trim();
      if (inline && !isNoise(inline)) return inline;
      for (let j = i + 1; j < lines.length; j++) {
        if (!isNoise(lines[j])) return lines[j];
      }
      return null;
    }
  }
  return null;
}

/**
 * The next `count` non-noise lines after a label, as an array — for a table
 * whose header cells and data cells print as two separate blocks rather
 * than "label, value" pairs (common when a row wraps and a positional
 * extractor can't otherwise tell where the header block ends).
 */
function valuesAfter(lines, label, count, { from = 0 } = {}) {
  const idx = label instanceof RegExp
    ? indexMatching(lines, label, { from })
    : indexOfLabel(lines, label, { from });
  if (idx === -1) return [];

  const out = [];
  for (let i = idx + 1; i < lines.length && out.length < count; i++) {
    if (isNoise(lines[i])) continue;
    out.push(lines[i]);
  }
  return out;
}

/** Joins the `count` lines following a label — for addresses split across rows. */
function linesAfter(lines, label, count) {
  const idx = label instanceof RegExp ? indexMatching(lines, label) : indexOfLabel(lines, label);
  if (idx === -1) return null;
  const out = [];
  for (let i = idx + 1; i < lines.length && out.length < count; i++) {
    if (isNoise(lines[i])) continue;
    out.push(lines[i]);
  }
  return out.length ? out.join(' ') : null;
}

function normalize(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  toLines,
  isNoise,
  indexOfLabel,
  indexMatching,
  valueAfter,
  valuesAfter,
  valueInlineOrAfter,
  linesAfter,
  escapeRe,
};
