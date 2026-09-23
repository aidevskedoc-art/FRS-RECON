/**
 * Period-overlap guard for the UCR MIS table (ucr_ip_records).
 *
 * The file-hash check in dedupe.js stops the SAME file twice. It cannot stop the
 * case the combined "All Collections" report makes routine: a 1-15 Sep combined
 * file arriving after a 1-6 Sep standalone file for the same unit. Different
 * bytes, but the first six days are the same transactions — stored twice, the
 * card/UPI matchers would pair both copies with one gateway row.
 *
 * Identity is (mis_source, receipt_no, instrument_type, amount, reference_id):
 * a receipt number never repeats across receipts, and the other three separate
 * the legitimate multi-row cases (one bill's consultation + registration lines,
 * a split payment). Repeats WITHIN one file are left alone — they are real rows.
 */
const db = require('../db');

/**
 * Parsed row -> the identity it is stored under, per MIS source. The upload
 * route and the upload preview both use these, so they cannot disagree.
 * OP stores its bill number as receipt_no.
 */
const OVERLAP_KEYS = {
  IP: (r) => ({ receiptNo: r.receiptNo, instrumentType: r.instrumentType, amount: r.amount, referenceId: r.referenceId }),
  OP: (r) => ({ receiptNo: r.billNo, instrumentType: r.instrumentType, amount: r.amount, referenceId: r.referenceId }),
  DIAG: (r) => ({ receiptNo: r.receiptNo, instrumentType: r.instrumentType, amount: r.amount, referenceId: r.referenceId }),
};

/**
 * @param {'IP'|'OP'|'DIAG'} misSource
 * @param {{receiptNo:string|null, instrumentType:string, amount:number|null, referenceId:string|null}[]} allKeys
 * @returns {Promise<{ rows:number, batches:{ id:number, fileName:string, rows:number }[] }>}
 *   `rows` = distinct rows of this file already stored anywhere; per batch, how many of them it holds.
 */
async function findStoredOverlap(misSource, allKeys) {
  const distinct = new Map();
  for (const k of allKeys) distinct.set(JSON.stringify([k.receiptNo, k.instrumentType, k.amount, k.referenceId]), k);
  const keys = [...distinct.values()];
  if (!keys.length) return { rows: 0, batches: [] };

  const { rows } = await db.query(
    `WITH n AS (
       SELECT * FROM unnest($2::text[], $3::text[], $4::numeric[], $5::text[])
         AS n(receipt_no, instrument_type, amount, reference_id)
     ),
     hit AS (
       SELECT DISTINCT r.batch_id, n.receipt_no, n.instrument_type, n.amount, n.reference_id
         FROM ucr_ip_records r
         JOIN n ON r.receipt_no = n.receipt_no
               AND r.instrument_type = n.instrument_type
               AND r.amount IS NOT DISTINCT FROM n.amount
               AND COALESCE(r.reference_id, '') = COALESCE(n.reference_id, '')
        WHERE r.mis_source = $1
     )
     SELECT b.id, b.file_name, COUNT(*)::int AS rows,
            (SELECT COUNT(*) FROM (SELECT DISTINCT receipt_no, instrument_type, amount, reference_id FROM hit) d)::int AS total
       FROM hit
       JOIN ucr_ip_upload_batches b ON b.id = hit.batch_id
      GROUP BY b.id, b.file_name
      ORDER BY b.id`,
    [
      misSource,
      keys.map((k) => k.receiptNo),
      keys.map((k) => k.instrumentType),
      keys.map((k) => k.amount),
      keys.map((k) => k.referenceId),
    ],
  );
  return {
    rows: rows.length ? rows[0].total : 0,
    batches: rows.map((r) => ({ id: r.id, fileName: r.file_name, rows: r.rows })),
  };
}

/** Throws 409 naming the batch(es) already holding these transactions. */
function assertNoOverlap(overlap, label) {
  if (!overlap.rows) return;
  const where = overlap.batches.map((b) => `batch #${b.id} "${b.fileName}" (${b.rows} rows)`).join(', ');
  const err = new Error(
    `${overlap.rows} of the ${label} rows in this file are already stored — ${where}. ` +
      'This usually means the periods overlap. Delete that batch first if this file replaces it; nothing was saved.',
  );
  err.status = 409;
  throw err;
}

module.exports = { findStoredOverlap, assertNoOverlap, OVERLAP_KEYS };
