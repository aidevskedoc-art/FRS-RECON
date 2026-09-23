/**
 * Generic reader for the instrument-level HIS collection reports described in
 * his-report-layouts.js. Knows nothing about any one report.
 *
 * What it guarantees, per sheet:
 *   1. Every row is accounted for — data, header, footer, summary, banner or
 *      blank. Anything else is reported by row number, never skipped quietly.
 *   2. Sections are found from the report's own footer lines, so a sheet that
 *      stacks collections, refunds and several receipt series is read as those
 *      sections, not as one table.
 *   3. The column map (layout variant) is accepted only if every section's
 *      parsed total equals the total the report prints about itself, and every
 *      payment bucket is confirmed against a printed figure — to the rupee. A
 *      wrong map cannot pass, so this is both how the variant is chosen and how
 *      a changed export format is caught instead of ingested.
 *
 * Status per sheet:
 *   VERIFIED    every data row sits in a section whose totals reconcile.
 *   UNVERIFIED  fields validate but some rows are covered by no printed total
 *               (a trimmed file, or one exported without footers). Usable only
 *               after a person has looked at it.
 *   FAILED      no layout variant reconciles, or a value is unrecognised.
 *               Must not be ingested.
 *
 * Why a computed figure only has to APPEAR on the total line, rather than sit
 * in a particular cell: these footers do not keep their figures under their
 * labels, and omit different figures per unit (SMJ's doctor-fee footer prints
 * no Card or UPI; the IP refunds footer never prints Card). Two consequences:
 * a figure the section line omits is confirmed against the sheet's net line
 * instead, and a perfect exchange of two payment types' labels would pass.
 * The latter is not a failure a wrong column map produces — that yields values
 * outside the payment-type vocabulary, which is rejected outright.
 *
 * It returns raw cell text per field; each report's parser applies its own
 * existing normalisation, so parsed output is unchanged for files that already
 * worked.
 */
const XLSX = require('xlsx');
const { toText, toAmount, extractUnitName } = require('./parse-helpers');
const { HIS_REPORT_LAYOUTS, layoutFor, SERIAL } = require('./his-report-layouts');

/** Rows scanned for a header when a sheet has been renamed. */
const HEADER_SCAN_ROWS = 30;
/** How many offending row numbers a problem message lists before summarising. */
const MAX_ROWS_LISTED = 5;

const norm = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

/** Paise-exact addition — every comparison below is to the rupee and paise. */
const addMoney = (a, b) => Math.round((a + b) * 100) / 100;

function rowText(cells) {
  return cells.map((c) => toText(c) || '').join(' ');
}

function numbersIn(cells) {
  const out = [];
  for (const c of cells) {
    const text = toText(c);
    if (text === null) continue;
    const n = toAmount(text);
    if (n !== null && /^-?[\d,]+(\.\d+)?$/.test(text)) out.push(n);
  }
  return out;
}

function listRows(rows) {
  const shown = rows.slice(0, MAX_ROWS_LISTED).join(', ');
  return rows.length > MAX_ROWS_LISTED ? `${shown} and ${rows.length - MAX_ROWS_LISTED} more` : shown;
}

function formatMoney(n) {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** True when some row in the first HEADER_SCAN_ROWS contains every marker. */
function hasHeaderMarkers(grid, markers) {
  const wanted = markers.map(norm);
  return grid.slice(0, HEADER_SCAN_ROWS).some((cells) => {
    const have = cells.map(norm);
    return wanted.every((w) => have.includes(w));
  });
}

/**
 * The sheets of a workbook that hold this family's report. A sheet named for a
 * DIFFERENT family is never read — that is what stops one report's parser from
 * swallowing another report's sheet in a combined workbook.
 */
function sheetsForFamily(workbook, layout, grids) {
  const ownNames = new Set(layout.sheetNames.map(norm));
  const otherNames = new Set(
    HIS_REPORT_LAYOUTS.filter((l) => l.family !== layout.family).flatMap((l) => l.sheetNames.map(norm)),
  );
  const byName = workbook.SheetNames.filter((s) => ownNames.has(norm(s)));
  if (byName.length) return byName;
  return workbook.SheetNames.filter((s) => !otherNames.has(norm(s)) && hasHeaderMarkers(grids(s), layout.headerMarkers));
}

/** Excel row number (1-based) of grid index i, honouring a sheet range that doesn't start at A1. */
function rowNumberer(sheet) {
  const start = sheet && sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0;
  return (i) => start + i + 1;
}

/**
 * Classifies every row once. Classification depends only on the layout's
 * markers and the key column (identical across variants), so it is shared by
 * every variant tried.
 */
function classifyRows(grid, layout, keyColumn, rowNo) {
  const classified = [];
  let seenHeader = false;
  for (let i = 0; i < grid.length; i++) {
    const cells = grid[i];
    const text = rowText(cells).trim();
    const first = toText(cells[0]);

    if (!text) {
      classified.push({ kind: 'blank', index: i });
    } else if (first && /^sno$/i.test(first)) {
      seenHeader = true;
      classified.push({ kind: 'header', index: i });
    } else if (first && SERIAL.test(first) && toText(cells[keyColumn])) {
      classified.push({ kind: 'data', index: i });
    } else if (isFooter(cells, text, layout)) {
      classified.push({ kind: 'footer', index: i, text, numbers: numbersIn(cells) });
    } else if (layout.summary && layout.summary.match.test(text)) {
      classified.push({ kind: 'summary', index: i, text, numbers: numbersIn(cells) });
    } else if (!seenHeader) {
      classified.push({ kind: 'banner', index: i, text });
    } else {
      classified.push({ kind: 'unclassified', index: i, excelRow: rowNo(i), text: text.slice(0, 120) });
    }
  }
  return classified;
}

function isFooter(cells, text, layout) {
  const f = layout.footer;
  if (f.match) return f.match.test(text);
  if (f.numericOnly) {
    if (/[A-Za-z]/.test(text)) return false;
    return numbersIn(cells).length >= (f.minNumbers || 1);
  }
  return false;
}

/** Section name for a closed section: from the footer text, or from the receipt series it holds. */
function sectionNameFor(layout, footer, dataRows, keyField) {
  if (layout.footer.sectionName) return layout.footer.sectionName(footer.text);
  const series = [...new Set(dataRows.map((r) => (r.fields[keyField] || '').replace(/[\d/]+/g, '')).filter(Boolean))];
  return series.length ? `Series ${series.join('/')}` : 'Section';
}

function bucketApplies(bucket, sectionName) {
  return !bucket.sections || bucket.sections.includes(sectionName);
}

/** Case-insensitive: the parsers upper-case payment types, so "CARD" and "Card" must mean the same here. */
const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function rowInBucket(row, bucket) {
  if (!bucket.where) return true;
  return Object.entries(bucket.where).every(([field, values]) => values.some((v) => sameText(v, row.fields[field] || '')));
}

/**
 * Reads one sheet with one variant's column map: extracts fields, validates
 * them, splits into sections and reconciles against the printed totals.
 */
function readWithVariant(grid, layout, variant, classified, rowNo) {
  const problems = [];
  const cols = variant.columns;
  const amountFields = new Set(layout.amountFields);

  const rows = [];
  const badAmount = new Map();
  const badVocab = new Map();
  for (const c of classified) {
    if (c.kind !== 'data') continue;
    const cells = grid[c.index];
    const fields = {};
    for (const [field, col] of Object.entries(cols)) fields[field] = toText(cells[col]);

    // Canonicalise a vocabulary's known alternate spellings (e.g. "C Card" ->
    // "Card") before anything else sees the field, so validation, control
    // totals and every downstream parser agree on one spelling.
    for (const [field, vocab] of Object.entries(layout.vocabularies || {})) {
      if (!vocab.aliases || fields[field] == null) continue;
      const alias = Object.keys(vocab.aliases).find((a) => sameText(a, fields[field]));
      if (alias) fields[field] = vocab.aliases[alias];
    }

    for (const field of amountFields) {
      const raw = fields[field];
      if (raw !== null && toAmount(raw) === null) {
        const key = field;
        if (!badAmount.has(key)) badAmount.set(key, []);
        badAmount.get(key).push(rowNo(c.index));
      }
    }
    for (const [field, vocab] of Object.entries(layout.vocabularies || {})) {
      const raw = fields[field];
      const ok = raw === null ? vocab.allowBlank : vocab.values.some((v) => sameText(v, raw));
      if (!ok) {
        const key = `${field}=${raw === null ? '(blank)' : raw}`;
        if (!badVocab.has(key)) badVocab.set(key, []);
        badVocab.get(key).push(rowNo(c.index));
      }
    }
    rows.push({ excelRow: rowNo(c.index), index: c.index, section: null, fields });
  }

  for (const [field, at] of badAmount) {
    problems.push({
      severity: 'error',
      code: 'AMOUNT_NOT_NUMERIC',
      message: `"${field}" is not a number in ${at.length} row(s) (rows ${listRows(at)}) — this column layout does not fit the file.`,
    });
  }
  for (const [key, at] of badVocab) {
    const [field, value] = key.split('=');
    problems.push({
      severity: 'error',
      code: 'UNKNOWN_VALUE',
      message:
        `Unrecognised ${field} "${value}" in ${at.length} row(s) (rows ${listRows(at)}). ` +
        'If this is a genuine new payment type, add it to his-report-layouts.js; until then these rows cannot be classified safely.',
    });
  }

  // ---- structural checks ---------------------------------------------------
  // Totals only prove the AMOUNT column. Two variants that differ only in
  // where a text field sits (e.g. a User Name column present or not, which
  // moves the reference one column) reconcile identically — and the wrong one
  // stores every reference in the wrong field. A variant's `checks` state
  // facts about its data the other variant cannot also satisfy.
  const checks = variant.checks || {};
  const dataCells = classified.filter((c) => c.kind === 'data').map((c) => grid[c.index]);
  for (const col of checks.blankColumns || []) {
    const filled = dataCells.filter((cells) => toText(cells[col]) !== null).length;
    if (filled) {
      problems.push({
        severity: 'error',
        code: 'COLUMN_NOT_BLANK',
        message: `Column ${col + 1} holds data in ${filled} row(s), but this column layout expects it empty — it does not fit the file.`,
      });
    }
  }
  for (const field of checks.requireAnyValue || []) {
    if (!rows.some((r) => r.fields[field] !== null && r.fields[field] !== undefined)) {
      problems.push({
        severity: 'error',
        code: 'FIELD_NEVER_FILLED',
        message: `"${field}" is blank on every row with this column layout — it does not fit the file.`,
      });
    }
  }
  for (const [field, pattern] of Object.entries(checks.valuePattern || {})) {
    const bad = rows.filter((r) => r.fields[field] != null && !pattern.test(r.fields[field]));
    if (bad.length) {
      problems.push({
        severity: 'error',
        code: 'VALUE_PATTERN',
        message: `"${field}" does not look right in ${bad.length} row(s) (e.g. "${bad[0].fields[field]}", row ${bad[0].excelRow}) with this column layout — it does not fit the file.`,
      });
    }
  }
  // A transaction reference (RRN / UTR / approval code) is different on
  // essentially every row; a person's name (the wrong-variant reading of the
  // same column) repeats hard — a handful of cashiers process everything. Far
  // more reliable than a character-pattern check: verified against a real
  // Secunderabad export where 2 of 3,733 genuine approval codes are letters
  // only (no digit), which a digit-pattern check rejected outright, while a
  // real user-name column on two other confirmed-good exports repeats to
  // under 1% distinct (13-25 names across thousands of rows) — no plausible
  // reference column comes close to that. `min` is the floor a real reference
  // column can drop to (paise below the ~97% observed); `max` is the ceiling a
  // real name column can reach.
  for (const [field, { min = 0, max = 1 }] of Object.entries(checks.mostlyUnique || {})) {
    const values = rows.map((r) => r.fields[field]).filter((v) => v !== null && v !== undefined);
    const ratio = values.length ? new Set(values).size / values.length : 0;
    if (values.length && (ratio < min || ratio > max)) {
      problems.push({
        severity: 'error',
        code: 'UNIQUENESS',
        message: `"${field}" is ${Math.round(ratio * 100)}% distinct across ${values.length} row(s) (expected between ${Math.round(min * 100)}% and ${Math.round(max * 100)}%) with this column layout — it does not fit the file.`,
      });
    }
  }

  // ---- sections ------------------------------------------------------------
  const sections = [];
  let open = [];
  const rowsByIndex = new Map(rows.map((r) => [r.index, r]));
  const summaries = classified.filter((c) => c.kind === 'summary');

  for (const c of classified) {
    if (c.kind === 'data') {
      open.push(rowsByIndex.get(c.index));
    } else if (c.kind === 'footer' && open.length) {
      const name = sectionNameFor(layout, c, open, layout.keyField);
      sections.push({ name, footerRow: rowNo(c.index), footerNumbers: c.numbers, rows: open });
      open = [];
    }
  }
  const uncovered = open;

  const sectionReports = sections.map((s) => {
    for (const r of s.rows) r.section = s.name;
    const total = s.rows.reduce((sum, r) => addMoney(sum, toAmount(r.fields[layout.controlTotals.total.field]) || 0), 0);
    const totalPrinted = s.footerNumbers.includes(total);
    if (!totalPrinted) {
      problems.push({
        severity: 'error',
        code: 'SECTION_TOTAL_MISMATCH',
        message:
          `${s.name} (rows ${s.rows[0].excelRow}-${s.rows[s.rows.length - 1].excelRow}): parsed total ${formatMoney(total)} ` +
          `does not appear on the report's own total line (row ${s.footerRow}: ${s.footerNumbers.map(formatMoney).join(' | ')}).`,
      });
    }
    const buckets = layout.controlTotals.buckets
      .filter((b) => bucketApplies(b, s.name))
      .map((b) => {
        const computed = s.rows
          .filter((r) => rowInBucket(r, b))
          .reduce((sum, r) => addMoney(sum, toAmount(r.fields[b.field]) || 0), 0);
        let confirmedBy = null;
        if (computed === 0) confirmedBy = 'nothing to confirm';
        else if (s.footerNumbers.includes(computed)) confirmedBy = `row ${s.footerRow}`;
        return { name: b.name, computed, confirmedBy };
      });
    return { name: s.name, firstRow: s.rows[0].excelRow, lastRow: s.rows[s.rows.length - 1].excelRow, footerRow: s.footerRow, rowCount: s.rows.length, total, totalPrinted, buckets };
  });

  // A bucket the section line doesn't print (e.g. SMJ's doctor-fee footer has
  // no Card or UPI figure) can still be confirmed sheet-wide against the net
  // summary line, which is the sum across every section.
  const summaryNumbers = summaries.flatMap((s) => s.numbers);
  for (const bucket of layout.controlTotals.buckets) {
    const pending = sectionReports.flatMap((s) => s.buckets.filter((b) => b.name === bucket.name && !b.confirmedBy));
    if (!pending.length) continue;
    const sheetWide = sections
      .filter((s) => bucketApplies(bucket, s.name))
      .flatMap((s) => s.rows)
      .filter((r) => rowInBucket(r, bucket))
      .reduce((sum, r) => addMoney(sum, toAmount(r.fields[bucket.field]) || 0), 0);
    if (summaryNumbers.includes(sheetWide)) {
      for (const b of pending) b.confirmedBy = `net summary line (sheet total ${formatMoney(sheetWide)})`;
    } else {
      for (const s of sectionReports) {
        const b = s.buckets.find((x) => x.name === bucket.name && !x.confirmedBy);
        if (!b) continue;
        problems.push({
          severity: 'error',
          code: 'BUCKET_MISMATCH',
          message: `${s.name}: parsed ${bucket.name} total ${formatMoney(b.computed)} matches no figure the report prints for this section or for the whole sheet.`,
        });
      }
    }
  }

  if (uncovered.length) {
    problems.push({
      severity: 'warning',
      code: 'NOT_COVERED_BY_TOTALS',
      message:
        `${uncovered.length} data row(s) (rows ${uncovered[0].excelRow}-${uncovered[uncovered.length - 1].excelRow}) are not followed by any ` +
        'total line, so they cannot be checked against the report. Review them before relying on this file.',
    });
  }

  if (layout.uniqueKey) {
    const seen = new Map();
    for (const r of rows) {
      const k = r.fields[layout.keyField];
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dups = [...seen].filter(([, n]) => n > 1);
    if (dups.length) {
      problems.push({
        severity: 'warning',
        code: 'DUPLICATE_KEY',
        message: `${dups.length} ${layout.keyField} value(s) appear more than once in this sheet (e.g. ${dups.slice(0, 3).map(([k]) => k).join(', ')}).`,
      });
    }
  }

  // A zero "matches" any total line that prints a 0, so it proves nothing about
  // which columns are which: a layout reading an all-zero column would pass. It
  // must confirm at least one non-zero figure to count as verified.
  const evidence =
    sectionReports.filter((s) => s.total !== 0 && s.totalPrinted).length +
    sectionReports.flatMap((s) => s.buckets).filter((b) => b.computed !== 0 && b.confirmedBy).length;
  if (sections.length && !evidence && !problems.some((p) => p.severity === 'error')) {
    problems.push({
      severity: 'warning',
      code: 'NOTHING_PROVEN',
      message: 'Every total this column layout reads is zero, so the report\'s printed totals cannot confirm it.',
    });
  }

  const hasError = problems.some((p) => p.severity === 'error');
  let status = 'VERIFIED';
  if (hasError) status = 'FAILED';
  else if (uncovered.length || sections.length === 0 || !evidence) status = 'UNVERIFIED';

  return { variantId: variant.id, status, rows, sections: sectionReports, problems };
}

/**
 * Reads one sheet, choosing the layout variant that the report's own totals
 * confirm. Exactly one VERIFIED variant wins; failing that, exactly one
 * UNVERIFIED variant is used (with its warning). Anything else is FAILED —
 * including two variants that both fit, because then the file cannot tell us
 * which columns are which.
 */
function readSheet(workbook, sheetName, layout, grid) {
  const sheet = workbook.Sheets[sheetName];
  const rowNo = rowNumberer(sheet);
  const keyColumn = layout.variants[0].columns[layout.keyField];
  const classified = classifyRows(grid, layout, keyColumn, rowNo);

  const unitName = unitFromCells(grid);

  const structuralProblems = [];
  const unclassified = classified.filter((c) => c.kind === 'unclassified');
  if (unclassified.length) {
    structuralProblems.push({
      severity: 'error',
      code: 'UNCLASSIFIED_ROWS',
      message:
        `${unclassified.length} row(s) are neither data, header nor total lines (rows ${listRows(unclassified.map((u) => u.excelRow))}; ` +
        `first: "${unclassified[0].text}"). The sheet has been edited or the export format changed.`,
    });
  }
  const dataCount = classified.filter((c) => c.kind === 'data').length;

  const attempts = layout.variants.map((v) => readWithVariant(grid, layout, v, classified, rowNo));
  const verified = attempts.filter((a) => a.status === 'VERIFIED');
  const unverified = attempts.filter((a) => a.status === 'UNVERIFIED');

  let chosen;
  const selectionProblems = [];
  if (dataCount === 0) {
    chosen = { variantId: null, status: 'FAILED', rows: [], sections: [], problems: [] };
    selectionProblems.push({ severity: 'error', code: 'NO_DATA', message: 'No data rows found under the report header.' });
  } else if (verified.length === 1) {
    chosen = verified[0];
  } else if (verified.length > 1 || (verified.length === 0 && unverified.length > 1)) {
    const tied = verified.length > 1 ? verified : unverified;
    chosen = { ...tied[0], status: 'FAILED' };
    selectionProblems.push({
      severity: 'error',
      code: 'AMBIGUOUS_LAYOUT',
      message: `More than one known column layout fits this sheet (${tied.map((a) => a.variantId).join(', ')}), so which column is which cannot be proven.`,
    });
  } else if (unverified.length === 1) {
    chosen = unverified[0];
  } else {
    // Nothing fits: report the variant that came closest, so the message is about real columns.
    chosen = [...attempts].sort((a, b) => a.problems.length - b.problems.length)[0];
    chosen = { ...chosen, status: 'FAILED' };
    if (layout.variants.length > 1) {
      selectionProblems.push({
        severity: 'error',
        code: 'NO_LAYOUT_FITS',
        message: `None of the ${layout.variants.length} known column layouts for this report reconcile with its printed totals (closest: ${chosen.variantId}).`,
      });
    }
  }

  const problems = [...structuralProblems, ...selectionProblems, ...chosen.problems];
  const status = problems.some((p) => p.severity === 'error') ? 'FAILED' : chosen.status;

  const headerRow = classified.find((c) => c.kind === 'header');
  const fileHeaders = headerRow ? grid[headerRow.index].map((c) => toText(c)).filter(Boolean) : [];

  return {
    sheetName,
    unitName,
    variantId: chosen.variantId,
    status,
    rows: chosen.rows,
    sections: chosen.sections,
    problems,
    fileHeaders,
    rowCounts: countKinds(classified),
  };
}

/** "YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD" -> "SECUNDERABAD". The doctor-fee register puts it inside its header row. */
function unitFromCells(grid) {
  for (const cells of grid.slice(0, HEADER_SCAN_ROWS)) {
    for (const c of cells) {
      const t = toText(c);
      if (t && /^YASHODA\b/i.test(t)) return extractUnitName([t]);
    }
  }
  return null;
}

function countKinds(classified) {
  const counts = {};
  for (const c of classified) counts[c.kind] = (counts[c.kind] || 0) + 1;
  return counts;
}

/** Parses a buffer once; callers that already hold a workbook pass it straight through. */
function toWorkbook(bufferOrWorkbook) {
  if (bufferOrWorkbook && bufferOrWorkbook.SheetNames) return bufferOrWorkbook;
  return XLSX.read(bufferOrWorkbook, { type: 'buffer' });
}

/**
 * @param {Buffer|object} bufferOrWorkbook an .xls/.xlsx buffer, or a workbook already read by XLSX
 * @param {'UCR_IP'|'UCR_OP'|'UCR_DIAG'} family
 * @returns {{ family, label, sheets: Array, skippedSheets: string[], status: 'VERIFIED'|'UNVERIFIED'|'FAILED'|'ABSENT' }}
 *   `status` is the worst across the family's sheets; ABSENT when the workbook holds none.
 */
// A parsed workbook is read by up to seven previews (three UCR reports plus the
// four older pipelines built from them); reading each report once is enough.
const reportCache = new WeakMap();

function readHisReport(bufferOrWorkbook, family) {
  const layout = layoutFor(family);
  const workbook = toWorkbook(bufferOrWorkbook);
  let cached = reportCache.get(workbook);
  if (!cached) reportCache.set(workbook, (cached = new Map()));
  if (!cached.has(family)) cached.set(family, readHisReportUncached(workbook, layout, family));
  return cached.get(family);
}

function readHisReportUncached(workbook, layout, family) {
  const gridCache = new Map();
  const grids = (name) => {
    if (!gridCache.has(name)) {
      gridCache.set(name, XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }));
    }
    return gridCache.get(name);
  };

  const names = sheetsForFamily(workbook, layout, grids);
  const sheets = names.map((name) => readSheet(workbook, name, layout, grids(name)));
  const skippedSheets = workbook.SheetNames.filter((s) => !names.includes(s));

  let status = 'ABSENT';
  if (sheets.length) {
    if (sheets.some((s) => s.status === 'FAILED')) status = 'FAILED';
    else if (sheets.some((s) => s.status === 'UNVERIFIED')) status = 'UNVERIFIED';
    else status = 'VERIFIED';
  }
  return { family, label: layout.label, sheets, skippedSheets, status };
}

/**
 * The error a parser throws when a report is FAILED. 422 because the file is
 * well-formed but its content cannot be trusted; the message carries the
 * report's own reasons so the person uploading can act on it.
 */
function verificationError(report) {
  const lines = [];
  for (const s of report.sheets) {
    for (const p of s.problems.filter((x) => x.severity === 'error')) lines.push(`[${s.sheetName}] ${p.message}`);
  }
  const err = new Error(
    `${report.label}: this file could not be verified against the report's own totals, so nothing was saved. ${lines.slice(0, 4).join(' ')}` +
      (lines.length > 4 ? ` (+${lines.length - 4} more)` : ''),
  );
  err.status = 422;
  return err;
}

/** The compact, JSON-safe verification summary the upload and preview endpoints return. */
function verificationSummary(report) {
  return {
    family: report.family,
    label: report.label,
    status: report.status,
    sheets: report.sheets.map((s) => ({
      sheetName: s.sheetName,
      unitName: s.unitName,
      variantId: s.variantId,
      status: s.status,
      dataRows: s.rows.length,
      sections: s.sections,
      problems: s.problems,
    })),
  };
}

module.exports = { readHisReport, verificationError, verificationSummary, toWorkbook };
