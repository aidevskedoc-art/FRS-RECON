/**
 * Disposable mismatched IP + Diag/OP rows for the route tests that page
 * through mismatches (test-mismatch-filter.js, test-online-mismatches-route.js).
 * Seeded rather than relying on whatever is in the dev DB at the time — those
 * tables get cleared and reloaded as real files are tested, and a test that
 * only passes while real data happens to be present is not a test.
 *
 * Both types share the same receipt dates so a date-sorted page mixes them.
 * Everything is tagged uploaded_by 'ZZ Mismatch Seed'; cleanup() removes the
 * batches and their records (ON DELETE CASCADE).
 */
const db = require('../../src/db');

const TAG = 'ZZ Mismatch Seed';
const PER_TYPE = 30;
const STATUSES = ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH'];

async function seed() {
  await cleanup();
  const { rows: ip } = await db.query(
    `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count, uploaded_by) VALUES ('ZZ-mismatch-seed-ip.xlsx', 1, $1, $2) RETURNING id`,
    [PER_TYPE, TAG],
  );
  const { rows: diag } = await db.query(
    `INSERT INTO diag_op_upload_batches (file_name, file_size_bytes, row_count, uploaded_by) VALUES ('ZZ-mismatch-seed-diag.xlsx', 1, $1, $2) RETURNING id`,
    [PER_TYPE, TAG],
  );
  for (let i = 0; i < PER_TYPE; i++) {
    const day = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`;
    const status = STATUSES[i % STATUSES.length];
    await db.query(
      `INSERT INTO ip_payment_records (batch_id, receipt_number, receipt_date, patient_name, bill_amount, match_status)
       VALUES ($1, $2, $3, 'ZZ SEED PATIENT', 100, $4)`,
      [ip[0].id, `ZZSEED-IP-${i}`, day, status],
    );
    await db.query(
      `INSERT INTO diag_op_payment_records (batch_id, receipt_number, receipt_date, patient_name, bill_amount, match_status)
       VALUES ($1, $2, $3, 'ZZ SEED PATIENT', 100, $4)`,
      [diag[0].id, `ZZSEED-DG-${i}`, day, status],
    );
  }
  return { ipBatchId: ip[0].id, diagBatchId: diag[0].id, perType: PER_TYPE };
}

async function cleanup() {
  await db.query('DELETE FROM ip_payment_upload_batches WHERE uploaded_by = $1', [TAG]);
  await db.query('DELETE FROM diag_op_upload_batches WHERE uploaded_by = $1', [TAG]);
}

module.exports = { seed, cleanup, PER_TYPE };
