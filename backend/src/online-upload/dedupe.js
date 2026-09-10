/**
 * Content-hash guard against re-uploading the same file. Hashing the bytes (not
 * the name) means a renamed copy is still caught, while a genuinely corrected
 * file has different bytes and uploads normally.
 *
 * Mirrors the check documents.routes.js already runs for the insurance module.
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
 * @param {{ table:string, identitySql:string, identityOf:(row:any)=>string, rows:any[] }} opts
 * @returns {Promise<{ newRows:any[], skipped:number }>}
 */
async function filterNewRows({ table, identitySql, identityOf, rows }) {
  if (!rows || rows.length === 0) return { newRows: [], skipped: 0 };
  const { rows: existing } = await db.query(`SELECT DISTINCT ${identitySql} AS ident FROM ${table}`);
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

module.exports = { sha256, assertNewFile, filterNewRows };
