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
 * reaches — see settlementCutoffs() below.
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

const UP_TO_MODES = ['BANK'];

/** 'BANK' (cut at the bank data), null when absent. Throws a 400 on anything else. */
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

/**
 * SQL: the row (alias `r`, with receipt_date and batch_id) is dated on or
 * before its own branch's cut-off, read off its batch's unit_name. Pushes its
 * values onto `params`. null when there is no cut-off (nothing uploaded yet) —
 * the caller then applies none.
 */
function cutoffClause(batchTable, cutoffs, params) {
  if (!cutoffs || !cutoffs.fallback) return null;
  const whens = cutoffs.byLocation.map(({ name, cutoff }) => {
    params.push(`%${escapeLike(name)}%`, cutoff);
    return `WHEN b.unit_name ILIKE $${params.length - 1} THEN $${params.length}::date`;
  });
  params.push(cutoffs.fallback);
  const fallback = `$${params.length}::date`;
  const cutoff = whens.length ? `CASE ${whens.join(' ')} ELSE ${fallback} END` : fallback;
  // `< cutoff + 1`: the whole of the cut-off day is in, whether receipt_date is a DATE or a timestamp.
  return `EXISTS (SELECT 1 FROM ${batchTable} b WHERE b.id = r.batch_id AND r.receipt_date < (${cutoff}) + 1)`;
}

module.exports = {
  DEPARTMENTS,
  UP_TO_MODES,
  locationPatterns,
  parseDepartment,
  batchLocationClause,
  parseUpTo,
  settlementCutoffs,
  cutoffClause,
};
