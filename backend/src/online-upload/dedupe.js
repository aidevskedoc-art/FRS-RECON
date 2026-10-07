/**
 * Content-hash guard against re-uploading the same file. Hashing the bytes (not
 * the name) means a renamed copy is still caught, while a genuinely corrected
 * file has different bytes and uploads normally.
 */
const crypto = require('crypto');
const db = require('../db');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Throws a 409 (err.status = 409) if a file with this exact content is already
 * a batch in `table`. Otherwise returns the hash to store on the new batch.
 *
 * `scope` narrows the check to one kind of upload in a shared table —
 * bank_statement_uploads holds BANK, PAYU_MPR and EASEBUZZ rows, and the same
 * combined workbook is legitimately fed to two of those endpoints, so each only
 * guards against a repeat of its OWN source.
 *
 * @param {string} table   a table with a file_hash column
 * @param {Buffer} buffer  req.file.buffer (multer memoryStorage)
 * @param {{column: string, value: string}} [scope]
 */
async function assertNewFile(table, buffer, scope) {
  const hash = sha256(buffer);
  const params = [hash];
  let where = 'file_hash = $1';
  if (scope) {
    params.push(scope.value);
    where += ` AND ${scope.column} = $2`;
  }
  const { rows } = await db.query(
    `SELECT id, file_name, uploaded_at FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`,
    params,
  );
  if (rows.length) {
    const b = rows[0];
    const when = b.uploaded_at ? new Date(b.uploaded_at).toISOString().slice(0, 16).replace('T', ' ') : 'earlier';
    const err = new Error(
      `This file has already been uploaded (batch #${b.id}, "${b.file_name}", ${when}). Delete that batch first if you meant to replace it.`,
    );
    err.status = 409;
    throw err;
  }
  return hash;
}

/**
 * Row-level overlap guard. A second export often repeats part of the first
 * (e.g. two monthly files that share a few days). This returns only the parsed
 * rows whose transaction identity is NOT already stored in an earlier batch of
 * `table`, plus how many were skipped.
 *
 * `identitySql` builds the identity string in Postgres from the stored columns;
 * `identityOf` builds the SAME string from a parsed row. They MUST agree — keep
 * them next to each other in the route.
 *
 * `from` replaces the bare table where the identity needs a second table (a
 * cheque row's unit is its batch's — mis-identities.js).
 *
 * @param {{ table:string, from?:string, identitySql:string, identityOf:(row:any)=>string, rows:any[] }} opts
 * @returns {Promise<{ newRows:any[], skipped:number }>}
 */
async function filterNewRows({ table, from, identitySql, identityOf, rows }) {
  if (!rows || rows.length === 0) return { newRows: [], skipped: 0 };
  const { rows: existing } = await db.query(`SELECT DISTINCT ${identitySql} AS ident FROM ${from || table}`);
  const seen = new Set(existing.map((r) => r.ident));
  const newRows = [];
  let skipped = 0;
  for (const row of rows) {
    const id = identityOf(row);
    if (seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id); // also drops a row that repeats within this same file
    newRows.push(row);
  }
  return { newRows, skipped };
}

const money = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));

/** One bank statement line as a string — every column the statement prints. */
function bankLineIdentity(r) {
  return [r.txnDate ?? '', r.valueDate ?? '', r.narration ?? '', r.chqRefNo ?? '', money(r.withdrawalAmt), money(r.depositAmt), money(r.closingBalance)].join('§');
}

// Must build exactly the string bankLineIdentity does. Dates come out of SQL
// as text, never through a JS Date (a DATE read that way lands a day early in IST).
const BANK_LINE_IDENTITY_SQL = `
  COALESCE(to_char(r.txn_date, 'YYYY-MM-DD'), '') || '§' || COALESCE(to_char(r.value_date, 'YYYY-MM-DD'), '') || '§' ||
  COALESCE(r.narration, '') || '§' || COALESCE(r.chq_ref_no, '') || '§' ||
  COALESCE(to_char(r.withdrawal_amt, 'FM999999999990.00'), '') || '§' ||
  COALESCE(to_char(r.deposit_amt, 'FM999999999990.00'), '') || '§' ||
  COALESCE(to_char(r.closing_balance, 'FM999999999990.00'), '')`;

/**
 * The lines of one bank statement that an EARLIER upload of the same account
 * has not already stored — so two statements whose periods overlap store the
 * shared days once, not twice (a credit stored twice gives the matcher two
 * candidates for one payment).
 *
 * A line is "the same" when the account and every printed column match,
 * closing balance included. The running balance changes with every
 * transaction, so two genuinely different lines can never share all of it.
 *
 * Unlike filterNewRows, a line repeated WITHIN this statement is kept: this
 * only removes what an earlier file already holds, so an upload that overlaps
 * nothing stores exactly what it stored before this check existed.
 *
 * @param {string|null} accountNo the statement's account number, as parsed
 * @param {object[]}    rows      parsed lines (txnDate, valueDate, narration, chqRefNo, amounts)
 */
async function filterNewBankLines({ accountNo, rows }) {
  if (!rows || rows.length === 0) return { newRows: [], skipped: 0 };
  const dates = rows.map((r) => r.txnDate).filter(Boolean).sort();
  // Only this account's lines inside this statement's own dates can be the same line.
  const { rows: existing } = await db.query(
    `SELECT ${BANK_LINE_IDENTITY_SQL} AS ident
       FROM bank_statement_records r
       JOIN bank_statement_uploads u ON u.id = r.batch_id
      WHERE u.source = 'BANK'
        AND regexp_replace(COALESCE(u.account_no, ''), '[^0-9]', '', 'g') = $1
        AND (r.txn_date IS NULL OR r.txn_date BETWEEN $2::date AND $3::date)`,
    [String(accountNo ?? '').replace(/[^0-9]/g, ''), dates[0] ?? null, dates[dates.length - 1] ?? null],
  );
  const stored = new Set(existing.map((e) => e.ident));
  const newRows = rows.filter((r) => !stored.has(bankLineIdentity(r)));
  return { newRows, skipped: rows.length - newRows.length };
}

module.exports = { sha256, assertNewFile, filterNewRows, filterNewBankLines, bankLineIdentity };
