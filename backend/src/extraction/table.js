/**
 * Rebuilds a table from a page's positioned text items (see pdf-text.js's
 * `pageItems`).
 *
 * Why this exists: every parser under formats/ reads values by counting
 * lines forward from a label, which works for "Label / value" pairs but is
 * fragile on a table. A PDF emits one text item per drawn run, so a cell
 * whose text wraps ("PORT BENEFIT PASSED FOR" / "DIABETES", or a two-line
 * insured name) contributes two items, while a blank cell contributes
 * none. A parser stepping "clientId + 3 = relationship" is therefore
 * counting a quantity the document doesn't hold constant, and once one row
 * wraps every row after it is read out of the wrong columns — quietly, with
 * every individual value still looking well-formed.
 *
 * The x coordinate carries the column and the y carries the row, and both
 * survive wrapping. So: cluster the header cells by x to recover the real
 * columns (including titles that wrap across two lines, which share an x),
 * then attach every data item to the nearest column by x and the nearest
 * row by y. Rows are anchored on a column that prints exactly one cell per
 * row — a Client ID, a serial number — because that is what makes "nearest
 * row" well defined no matter how many lines the other cells took.
 */

/** Header titles that wrap sit within a point or two of their column's x. */
const X_TOLERANCE = 3;

function joinCell(items) {
  return items
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((i) => i.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The items belonging to one section of a page: everything below the
 * topmost heading matching `startRe`, down to the highest heading matching
 * any of `endRes` (or the bottom of the page if none is found).
 */
function sectionItems(items, startRe, endRes = [], { inclusive = false } = {}) {
  const starts = items.filter((i) => startRe.test(i.str));
  if (!starts.length) return null;
  const startY = Math.max(...starts.map((i) => i.y));

  // `inclusive` keeps the matched line itself, for a block whose first
  // column title *is* the marker ("Policyholder | Gender | ... | Client ID")
  // rather than a heading printed above the table.
  const below = items.filter((i) => (inclusive ? i.y <= startY + 1 : i.y < startY - 1));
  const ends = below.filter((i) => endRes.some((re) => re.test(i.str)));
  const endY = ends.length ? Math.max(...ends.map((i) => i.y)) : -Infinity;

  return below.filter((i) => i.y > endY + 1);
}

/**
 * Splits a section into its column titles and its data.
 *
 * The titles are recognised by name rather than by position: a wrapped data
 * cell sits only ~5pt below its row's baseline, which is well inside the
 * gap between the header and the first row, so no y threshold can separate
 * the two reliably. `isTitle` reading the text can. Scanning stops at the
 * first item that isn't a title, so an unrecognised title would show up as
 * a truncated column list rather than as a plausible-looking wrong answer.
 */
function splitHeader(section, isTitle) {
  const ordered = [...section].sort((a, b) => b.y - a.y || a.x - b.x);
  let i = 0;
  while (i < ordered.length && isTitle(ordered[i].str)) i++;
  return { header: ordered.slice(0, i), body: ordered.slice(i) };
}

/** Header items clustered by x into the table's columns, left to right. */
function columnsFrom(header) {
  const clusters = [];
  for (const item of [...header].sort((a, b) => a.x - b.x || b.y - a.y)) {
    const hit = clusters.find((c) => Math.abs(c.x - item.x) <= X_TOLERANCE);
    if (hit) {
      hit.parts.push(item);
      hit.x = Math.min(hit.x, item.x);
    } else {
      clusters.push({ x: item.x, parts: [item] });
    }
  }
  return clusters
    .sort((a, b) => a.x - b.x)
    .map((c) => ({ x: c.x, label: joinCell(c.parts) }));
}

function nearestIndex(candidates, value) {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (Math.abs(value - candidates[i]) < Math.abs(value - candidates[best])) best = i;
  }
  return best;
}

/**
 * Reads a table out of `section`.
 *
 * @param {Array} section    items from sectionItems()
 * @param {(s: string) => boolean} isTitle  recognises a column title
 * @param {RegExp} anchorLabel  matches the label of the column that prints
 *   exactly one cell per row; rows are keyed off it
 * @returns {{columns: string[], rows: (string|null)[][]}|null}
 */
function readTable(section, { isTitle, anchorLabel }) {
  if (!section || !section.length) return null;

  const { header, body } = splitHeader(section, isTitle);
  const columns = columnsFrom(header);
  if (!columns.length || !body.length) return null;

  const anchorCol = columns.findIndex((c) => anchorLabel.test(c.label));
  if (anchorCol === -1) return null;

  const colXs = columns.map((c) => c.x);
  const placed = body.map((item) => ({ ...item, col: nearestIndex(colXs, item.x) }));

  const anchorYs = placed
    .filter((i) => i.col === anchorCol)
    .map((i) => i.y)
    .sort((a, b) => b - a);
  if (!anchorYs.length) return null;

  const cells = anchorYs.map(() => columns.map(() => []));
  for (const item of placed) {
    cells[nearestIndex(anchorYs, item.y)][item.col].push(item);
  }

  return {
    columns: columns.map((c) => c.label),
    rows: cells.map((row) => row.map((cell) => joinCell(cell) || null)),
  };
}

/**
 * Maps a readTable() result onto field names.
 * `spec` is [key, RegExp] pairs tested against each column's label; a
 * column no pattern claims is simply left out.
 */
function toRecords(table, spec) {
  if (!table) return [];
  const keyed = table.columns.map((label) => {
    const hit = spec.find(([, re]) => re.test(label));
    return hit ? hit[0] : null;
  });
  return table.rows.map((row) => {
    const record = {};
    keyed.forEach((key, i) => {
      if (key && record[key] == null) record[key] = row[i];
    });
    return record;
  });
}

module.exports = {
  sectionItems, splitHeader, columnsFrom, readTable, toRecords, joinCell,
};
