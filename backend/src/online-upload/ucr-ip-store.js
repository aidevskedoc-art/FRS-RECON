/**
 * Writing Card / UPI rows (ucr_ip_records) for the HIS API sync.
 *
 * The file uploads keep their own per-source INSERTs in ucr-upload.routes.js
 * (IP, OP and DIAG each fill a different set of columns). This fills the IP
 * set, tagged with the source the config names, so an API row and a file row
 * of the same receipt share the identity ucr-overlap.js compares.
 */

const RECORD_COLUMNS = [
  'batch_id', 'mis_source', 'receipt_no', 'receipt_date', 'yh_no', 'ip_no', 'patient_name',
  'bill_no', 'instrument_type', 'amount', 'user_id', 'user_name', 'reference_id',
];

function recordToRow(batchId, r) {
  return [
    batchId, r.misSource ?? 'IP', r.receiptNo ?? null, r.receiptDate ?? null, r.yhNo ?? null, r.ipNo ?? null,
    r.patientName ?? null, r.billNo ?? null, r.instrumentType ?? null, r.amount ?? null,
    r.userId ?? null, r.userName ?? null, r.referenceId ?? null,
  ];
}

/** Chunked multi-row INSERT — keeps parameter count well under Postgres's ~65535 limit. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO ucr_ip_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`, chunk.flat());
  }
}

module.exports = { RECORD_COLUMNS, recordToRow, insertRecordsChunked };
