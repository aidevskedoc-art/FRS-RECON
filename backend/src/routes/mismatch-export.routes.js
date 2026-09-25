/**
 * GET /api/mismatch-export.xlsx — the Mismatch Review screen as one workbook.
 *
 * Lives in its own route file because it is the only endpoint that spans all
 * four collection streams at once: Online (matched-rules), Cheque
 * (cheque-collections) and Card/UPI (ucr-matched). It owns no filtering of its
 * own — each stream's rows come from that stream's OWN query builder, handed
 * the same `req.query` the list endpoints receive, so the file and the screen
 * cannot disagree about what is in scope. See excel/mismatch-export.js.
 *
 * No pagination: a download is the one place the whole set is wanted. The row
 * cap below is a safety rail, not a page — it exists so a mis-clicked
 * unfiltered export cannot try to build a million-row workbook in memory.
 */
const express = require('express');
const db = require('../db');
const { buildOnlineMismatchSelects } = require('./matched-rules.routes');
const { buildUcrFilter } = require('./ucr-matched.routes');
const { buildRecordsFilter, RECORDS_WITH_MATCH_SQL } = require('./cheque-collections.routes');
const { ucrRecordSelect } = require('../reconciliation/upi-card-recon/ucr-record-query');
const { buildMismatchWorkbook } = require('../excel/mismatch-export');
const { writeXlsx } = require('../excel/write-xlsx');
const { onlineMismatchRowToApi, chequeCollectionRecordRowToApi } = require('../mappers');
const { ucrIpRecordRowToApi } = require('../ucr-mappers');
const { parseUpTo, settlementCutoffs } = require('../scope-filters');
const { MATCHED_STATUSES } = require('../reconciliation/status-tone');

const router = express.Router();

/** Per stream. Beyond this the export is refused rather than silently truncated. */
const MAX_ROWS_PER_SHEET = 50000;

/**
 * The screen's view mode translated to each stream's status filter.
 *
 * Two translations are needed, not one, and getting this wrong is silent: the
 * Online and Cheque endpoints take `matchStatus`, the Card/UPI ones take
 * `status`, and the two families do not share a status vocabulary — Card/UPI
 * have no PARTIAL_MATCH or AMBIGUOUS_MATCH, and no EASEBUZZ_MATCHED or
 * CONTRA_ENTRY. Passing the wrong parameter name does not error, it just
 * returns EVERY row, so an export asked for mismatches would quietly hand the
 * client the entire ledger.
 *
 * Taking the mode rather than the raw lists keeps the caller from having to
 * know any of that, and keeps this file the single place the mapping lives.
 * Clean statuses come from status-tone.js so the file's colours and its row
 * selection can never disagree about what "matched" means.
 */
/**
 * What each family of tables can actually hold. Spelled out rather than taken
 * from status-tone's MATCHED_STATUSES: that set exists to COLOUR any verdict
 * from any stream, so it includes GROUPED_MATCHED — which only Card/UPI ever
 * produce (verified against live data: ip/diag/cheque emit MATCHED,
 * PARTIAL_MATCH, AMBIGUOUS_MATCH, CONTRA_ENTRY, UNMATCHED and nothing else).
 * Reusing the colour set here would have let "Matched + Grouped Matched" send
 * a filter to the online tables that can never match, and then report it in the
 * Summary as though it were a live part of the query.
 *
 * The two vocabularies do NOT overlap fully, so a status the reviewer picks is
 * intersected with each stream's own before it is sent.
 */
const ONLINE_CLEAN = ['MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY'];
const ONLINE_MISMATCH = ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH'];
const UCR_CLEAN = ['MATCHED', 'GROUPED_MATCHED'];
const UCR_MISMATCH = ['UNMATCHED', 'AMOUNT_MISMATCH'];
const VIEW_MODES = ['mismatches', 'all', 'matched', 'matched_by_auditor'];

const ONLINE_VOCAB = new Set([...ONLINE_CLEAN, ...ONLINE_MISMATCH]);
const UCR_VOCAB = new Set([...UCR_CLEAN, ...UCR_MISMATCH]);
// Guard the claim above: if a clean status is ever added to the engine, this
// file must be told about it rather than silently dropping rows from the
// Matched report.
for (const s of MATCHED_STATUSES) {
  if (!ONLINE_VOCAB.has(s) && !UCR_VOCAB.has(s)) {
    throw new Error(`mismatch-export: clean status "${s}" belongs to no stream vocabulary`);
  }
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

/**
 * `null` means "no status filter — every row"; an EMPTY ARRAY means "this
 * stream can hold none of the chosen statuses, so it contributes nothing".
 *
 * The distinction matters: picking Contra Entry should give a workbook whose
 * Card and UPI sheets are empty, not one where they quietly fall back to every
 * card row because an empty filter read as "unfiltered".
 */
function statusesFor(query) {
  // An explicit per-stream list always wins, so the endpoint stays usable alone.
  if (query.matchStatus || query.status) {
    return { online: query.matchStatus ? splitList(query.matchStatus) : null, ucr: query.status ? splitList(query.status) : null };
  }

  // The report being asked for: Mismatched, Matched, or Both.
  const mode = VIEW_MODES.includes(String(query.mode)) ? String(query.mode) : 'mismatches';
  const clean = mode === 'matched' || mode === 'matched_by_auditor';
  const base = mode === 'all'
    ? { online: null, ucr: null }
    : { online: clean ? ONLINE_CLEAN : ONLINE_MISMATCH, ucr: clean ? UCR_CLEAN : UCR_MISMATCH };

  // A status pick NARROWS the chosen report rather than replacing it, which is
  // how the two controls read together: "the Mismatched report, just the
  // Unmatched ones". Replacing would have made picking Matched + Unmatched
  // silently produce unmatched rows under a heading that says Matched.
  const picked = splitList(query.statuses);
  if (!picked.length) return base;

  const narrow = (vocab, allowed) => {
    const inVocab = picked.filter((s) => vocab.has(s));
    return allowed === null ? inVocab : inVocab.filter((s) => allowed.includes(s));
  };
  return { online: narrow(ONLINE_VOCAB, base.online), ucr: narrow(UCR_VOCAB, base.ucr) };
}

async function loadOnline(query) {
  const { ipSelect, diagSelect, params } = await buildOnlineMismatchSelects(query);
  const { rows } = await db.query(
    `${ipSelect} UNION ALL ${diagSelect} ORDER BY receipt_date DESC NULLS LAST, id DESC LIMIT ${MAX_ROWS_PER_SHEET + 1}`,
    params,
  );
  return rows.map(onlineMismatchRowToApi);
}

async function loadCheque(query) {
  // The cheque list resolves its own bank cut-off; mirror that exactly.
  const bankCutoffs = parseUpTo(query.upTo) === 'BANK' ? await settlementCutoffs('BANK') : null;
  const { where, params } = buildRecordsFilter(query, { bankCutoffs });
  const { rows } = await db.query(
    `${RECORDS_WITH_MATCH_SQL} ${where} ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC LIMIT ${MAX_ROWS_PER_SHEET + 1}`,
    params,
  );
  return rows.map(chequeCollectionRecordRowToApi);
}

async function loadUcr(instrumentType, query) {
  const { where, params } = await buildUcrFilter({ instrumentType, query });
  const { rows } = await db.query(
    ucrRecordSelect(where, `ORDER BY ABS(COALESCE(r.match_difference, 0)) DESC, r.id LIMIT ${MAX_ROWS_PER_SHEET + 1}`),
    params,
  );
  return rows.map(ucrIpRecordRowToApi);
}

/**
 * What the file is a view OF, in the words the screen uses. A spreadsheet that
 * does not state its own scope is the easiest kind to misread later — someone
 * opens it in November and cannot tell whether "45 rows" meant all units or one.
 */
function describeFilters(query) {
  const lines = [];
  const resolved = statusesFor(query);
  const describe = (list) => {
    if (list === null) return 'all statuses';
    return list.length ? list.join(', ') : 'none — no status in this pick applies here';
  };
  lines.push(`Status (Online / Cheque): ${describe(resolved.online)}`);
  lines.push(`Status (Card / UPI): ${describe(resolved.ucr)}`);
  lines.push(`Location: ${query.location || 'all units'}`);
  lines.push(`Department: ${query.department || 'all'}`);
  if (query.search) lines.push(`Search: ${query.search}`);
  // The period, on ONE line and both ends together — this file is often a
  // partial period (the client picks a From/To range), and a spreadsheet that
  // does not state the period it covers is the easiest kind to misread later.
  if (parseUpTo(query.upTo) === 'BANK') {
    lines.push(query.dateFrom
      ? `Period: ${query.dateFrom} up to the date the bank / settlement file reaches`
      : 'Period: everything, up to the date the bank / settlement file reaches');
  } else if (query.dateFrom && query.dateTo) {
    lines.push(`Period: ${query.dateFrom} to ${query.dateTo}`);
  } else if (query.dateTo) {
    lines.push(`Period: everything up to ${query.dateTo}`);
  } else if (query.dateFrom) {
    lines.push(`Period: ${query.dateFrom} onwards`);
  } else {
    lines.push('Period: every date');
  }
  if (query.matchedByAuditor === 'true') lines.push('Matched by auditor only');
  return lines;
}

router.get('/mismatch-export.xlsx', async (req, res, next) => {
  try {
    // The four streams are independent reads — no reason to serialise them.
    // Each stream gets its own status parameter name and vocabulary — see statusesFor.
    // An empty (not null) list means this stream holds none of the chosen
    // statuses: skip the query entirely rather than send a filter that would
    // read as "unfiltered" and return everything.
    const statuses = statusesFor(req.query);
    const onlineQuery = { ...req.query, matchStatus: statuses.online ? statuses.online.join(',') : undefined };
    const ucrQuery = { ...req.query, status: statuses.ucr ? statuses.ucr.join(',') : undefined };
    const skipOnline = statuses.online !== null && statuses.online.length === 0;
    const skipUcr = statuses.ucr !== null && statuses.ucr.length === 0;
    const [online, cheque, card, upi] = await Promise.all([
      skipOnline ? [] : loadOnline(onlineQuery),
      skipOnline ? [] : loadCheque(onlineQuery),
      skipUcr ? [] : loadUcr('CARD', ucrQuery),
      skipUcr ? [] : loadUcr('UPI', ucrQuery),
    ]);

    const oversized = [
      ['Online', online], ['Cheque', cheque], ['Card', card], ['UPI', upi],
    ].filter(([, rows]) => rows.length > MAX_ROWS_PER_SHEET);
    if (oversized.length) {
      return res.status(413).json({
        error: `Too many rows to export (${oversized.map(([n, r]) => `${n}: ${r.length}+`).join(', ')}). `
          + `Narrow the filters — by unit, department or date — and try again.`,
      });
    }

    const workbook = buildMismatchWorkbook({
      online, cheque, card, upi, filterLines: describeFilters(req.query),
    });
    const buffer = await writeXlsx(workbook);
    // Name it after the PERIOD, not the day it was generated: several range
    // exports downloaded in one sitting would otherwise all be called the same
    // thing and overwrite each other in the browser's Downloads folder.
    const clean = (v) => String(v).trim().replace(/[\\/?*[\]:"<>|]/g, '-');
    const from = req.query.dateFrom ? clean(req.query.dateFrom) : null;
    const to = parseUpTo(req.query.upTo) === 'BANK' ? null : (req.query.dateTo ? clean(req.query.dateTo) : null);
    const period = from && to ? `${from} to ${to}` : from ? `${from} onwards` : to ? `up to ${to}` : new Date().toISOString().slice(0, 10);
    const unit = req.query.location ? ` - ${clean(req.query.location)}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Mismatch Review - ${period}${unit}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Exported for scripts/test-mismatch-export.js — the null ("no filter") vs []
// ("this stream can hold none of these") distinction is the one thing here that
// fails silently if it regresses.
module.exports.statusesFor = statusesFor;
// Also for that test: the real row loaders, so every sheet column can be checked
// against the field names the rows actually carry (a column reading a name the
// mapper doesn't produce is silently blank — Online Amount was, 2026-09-25).
module.exports.loaders = { loadOnline, loadCheque, loadUcr };
