/**
 * Location + department filters shared by the three list endpoints behind the
 * "Collection and Bank Deposit Reconciliation" screen (client mail AC-10):
 * matched-rules /online-mismatches, cheque-collections /records and
 * ucr-matched /card-recon + /upi-recon.
 *
 * LOCATION. A record's location is its upload batch's unit_name — the HIS
 * report header ("YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY"). Matched
 * by case-insensitive substring against the location master's names, the same
 * rule resolveDivision() applies (reconciliation/matcher.js), so a location an
 * Admin adds later filters correctly with no code change. Written as a batch_id
 * subquery rather than a join so it drops into queries that never join the
 * batch table (e.g. cheque status-counts).
 *
 * DEPARTMENT. 'IP' | 'DIAG' | 'OPD'. Where each table keeps it differs, so the
 * callers map it themselves; this module only validates the value.
 *
 * UP TO (AC-12). `?upTo=BANK` cuts each row at the date its branch's bank data
 * reaches — see settlementCutoffs() below. `?upTo=AWAITING` is the other side
 * of that cut: the rows no statement covers yet ("Awaiting statement").
 */

const db = require('./db');

const DEPARTMENTS = ['IP', 'DIAG', 'OPD'];

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `?location=Hitech City,Somajiguda` -> ILIKE patterns, or null when the
 * parameter is absent (meaning every location, including rows whose batch
 * names no known unit).
 */
function locationPatterns(value) {
  if (value === undefined || value === null) return null;
  const names = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names.map((n) => `%${escapeLike(n)}%`) : null;
}

/** 'IP' | 'DIAG' | 'OPD', null when absent (all departments). Throws a 400 on anything else. */
function parseDepartment(value) {
  if (value === undefined || value === null || value === '') return null;
  const dept = String(value).trim().toUpperCase();
  if (!DEPARTMENTS.includes(dept)) {
    const err = new Error(`department must be one of ${DEPARTMENTS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return dept;
}

/** SQL: the row (alias `r`) belongs to a batch whose unit_name names one of the locations at $paramIdx. */
function batchLocationClause(batchTable, paramIdx) {
  return `r.batch_id IN (SELECT id FROM ${batchTable} WHERE unit_name ILIKE ANY($${paramIdx}::text[]))`;
}

// ---- AC-12: "till bank file is uploaded" ---------------------------------------------
//
// The client's default view of mismatches stops at the date the bank data
// reaches: a receipt after it cannot have been matched yet — its bank line
// hasn't been uploaded — so listing it as a mismatch would be noise.
//
// Per BRANCH, not one date: each unit's bank statement is its own upload and
// they don't land in step. Using one date for everyone would either list a
// lagging unit's not-yet-banked receipts as mismatches or hide an up-to-date
// unit's real ones. So a statement's account is traced to its division through
// master_division_bank_accounts (digits-only, the existing convention — the
// statement's account_no is free text), and each row is cut at its own
// branch's date. A row whose branch has no statement of its own yet — or whose
// unit can't be resolved — falls back to the latest date across all of them.
// The Card / UPI MPR exports carry no branch, so theirs is one date.
//
// AWAITING STATEMENT (sriram, 2026-10-07). A statement dated up to the 28th
// cannot yet hold the money for a receipt of the 27th either: card and UPI
// collections reach the bank a day or two later. So a row counts as covered
// only up to the statement's last date LESS `awaiting_statement_days`
// (reconciliation_settings, default 3, an Admin setting); everything after it
// is "Awaiting statement" — not a mismatch, not hidden, just not checkable yet.
// When the next statement arrives the cut-off moves and those rows fall into
// their real verdict on their own. Nothing about it is stored.

const UP_TO_MODES = ['BANK', 'AWAITING'];

/** Used when the setting cannot be read (a database the newer schema has not reached yet). */
const DEFAULT_AWAITING_DAYS = 3;

/** 'BANK' (cut at the bank data) or 'AWAITING' (only what lies beyond it), null when absent. Throws a 400 on anything else. */
function parseUpTo(value) {
  if (value === undefined || value === null || value === '') return null;
  const mode = String(value).trim().toUpperCase();
  if (!UP_TO_MODES.includes(mode)) {
    const err = new Error(`upTo must be one of ${UP_TO_MODES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return mode;
}

const BANK_BY_DIVISION_SQL = `
  SELECT mda.division_name AS name, to_char(max(br.txn_date), 'YYYY-MM-DD') AS cutoff
    FROM bank_statement_records br
    JOIN bank_statement_uploads u ON u.id = br.batch_id
    JOIN master_division_bank_accounts mda
      ON regexp_replace(mda.account_number, '\\D', '', 'g') = regexp_replace(u.account_no, '\\D', '', 'g')
   WHERE u.source = 'BANK' AND br.txn_date IS NOT NULL
   GROUP BY mda.division_name`;

const LATEST_SQL = {
  BANK: `SELECT to_char(max(br.txn_date), 'YYYY-MM-DD') AS cutoff
           FROM bank_statement_records br JOIN bank_statement_uploads u ON u.id = br.batch_id
          WHERE u.source = 'BANK'`,
  CARD_MPR: `SELECT to_char(max(d), 'YYYY-MM-DD') AS cutoff FROM (
               SELECT chg_date AS d FROM ucr_card_mpr_records
               UNION ALL
               SELECT txn_date::date FROM ucr_card_pinelabs_records) t`,
  UPI_MPR: `SELECT to_char(max(transaction_req_date::date), 'YYYY-MM-DD') AS cutoff FROM ucr_upi_mpr_records`,
};

/**
 * The cut-off dates for one settlement source ('YYYY-MM-DD', via to_char —
 * never a JS Date, see the date-timezone note in matched-rules.routes.js).
 * `fallback` is null when nothing has been uploaded: there is no cut-off yet.
 *
 * @param {'BANK'|'CARD_MPR'|'UPI_MPR'} source
 * @returns {Promise<{ byLocation: { name: string, cutoff: string }[], fallback: string|null }>}
 */
async function settlementCutoffs(source) {
  const [perBranch, latest] = await Promise.all([
    source === 'BANK' ? db.query(BANK_BY_DIVISION_SQL) : { rows: [] },
    db.query(LATEST_SQL[source]),
  ]);
  return {
    byLocation: perBranch.rows.filter((r) => r.cutoff).map((r) => ({ name: r.name, cutoff: r.cutoff })),
    fallback: (latest.rows[0] && latest.rows[0].cutoff) || null,
  };
}

/** 'YYYY-MM-DD' less `days`, as 'YYYY-MM-DD' — pure calendar arithmetic in UTC, so no timezone can shift it. */
function minusDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** The "Awaiting statement" allowance in days (reconciliation_settings). */
async function loadAwaitingDays() {
  try {
    const { rows } = await db.query('SELECT awaiting_statement_days FROM reconciliation_settings ORDER BY id LIMIT 1');
    return rows[0] ? Number(rows[0].awaiting_statement_days) : DEFAULT_AWAITING_DAYS;
  } catch {
    return DEFAULT_AWAITING_DAYS;
  }
}

/**
 * How far the statements COVER the receipts: settlementCutoffs() moved back by
 * the awaiting allowance. What every "till bank upload" list, the dashboard and
 * the exports cut at — a row after it is Awaiting statement. `days` and the
 * unshifted `statementUpTo` dates travel along for the screens to say so.
 *
 * @param {'BANK'|'CARD_MPR'|'UPI_MPR'} source
 */
async function coverageCutoffs(source) {
  const [raw, days] = await Promise.all([settlementCutoffs(source), loadAwaitingDays()]);
  return {
    byLocation: raw.byLocation.map(({ name, cutoff }) => ({ name, cutoff: minusDays(cutoff, days), statementUpTo: cutoff })),
    fallback: raw.fallback ? minusDays(raw.fallback, days) : null,
    statementUpTo: raw.fallback,
    days,
  };
}

/** SQL for the row's own cut-off date: its branch's, read off its batch `b`, else the fallback. Pushes its values onto `params`. */
function cutoffExpr(cutoffs, params) {
  const whens = cutoffs.byLocation.map(({ name, cutoff }) => {
    params.push(`%${escapeLike(name)}%`, cutoff);
    return `WHEN b.unit_name ILIKE $${params.length - 1} THEN $${params.length}::date`;
  });
  params.push(cutoffs.fallback);
  const fallback = `$${params.length}::date`;
  return whens.length ? `CASE ${whens.join(' ')} ELSE ${fallback} END` : fallback;
}

/**
 * SQL: the row (alias `r`, with receipt_date and batch_id) is dated on or
 * before its own branch's cut-off, read off its batch's unit_name. Pushes its
 * values onto `params`. null when there is no cut-off (nothing uploaded yet) —
 * the caller then applies none.
 */
function cutoffClause(batchTable, cutoffs, params) {
  if (!cutoffs || !cutoffs.fallback) return null;
  // `< cutoff + 1`: the whole of the cut-off day is in, whether receipt_date is a DATE or a timestamp.
  return `EXISTS (SELECT 1 FROM ${batchTable} b WHERE b.id = r.batch_id AND r.receipt_date < (${cutoffExpr(cutoffs, params)}) + 1)`;
}

/**
 * SQL: the exact complement of cutoffClause among dated rows — the row is dated
 * AFTER its branch's cut-off, so no statement covers it yet. With no statement
 * uploaded at all there is no cut-off, every row is listed as before, and
 * nothing is awaiting (FALSE) — so the two sides never overlap.
 */
function awaitingClause(batchTable, cutoffs, params) {
  if (!cutoffs || !cutoffs.fallback) return 'FALSE';
  return `EXISTS (SELECT 1 FROM ${batchTable} b WHERE b.id = r.batch_id AND r.receipt_date >= (${cutoffExpr(cutoffs, params)}) + 1)`;
}

/** The list endpoints' `upTo` as one clause: BANK keeps what is covered, AWAITING keeps what is not; null = no cut. */
function upToClause(mode, batchTable, cutoffs, params) {
  if (mode === 'BANK') return cutoffClause(batchTable, cutoffs, params);
  if (mode === 'AWAITING') return awaitingClause(batchTable, cutoffs, params);
  return null;
}

module.exports = {
  DEPARTMENTS,
  UP_TO_MODES,
  DEFAULT_AWAITING_DAYS,
  locationPatterns,
  parseDepartment,
  batchLocationClause,
  parseUpTo,
  settlementCutoffs,
  coverageCutoffs,
  loadAwaitingDays,
  minusDays,
  cutoffClause,
  awaitingClause,
  upToClause,
};
