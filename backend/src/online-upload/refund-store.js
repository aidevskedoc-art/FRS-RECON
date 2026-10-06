/**
 * Writing refund rows — shared by the file upload (POST /api/refunds) and the
 * HIS API sync, so a refund stored either way lands in exactly the same shape
 * and is caught by the same duplicate check.
 */

const RECORD_COLUMNS = [
  'batch_id', 'sheet_name', 'unit_name', 'division', 'refund_kind', 'refund_no',
  'cheque_date', 'cheque_no', 'patient_name', 'drawee_name', 'ip_no', 'diag_no', 'bank_name', 'amount',
];

function recordToRow(batchId, r) {
  return [
    batchId, r.sheetName ?? null, r.unitName ?? null, r.division ?? null, r.refundKind ?? null,
    r.refundNo ?? null, r.chequeDate ?? null, r.chequeNo ?? null, r.patientName ?? null,
    r.draweeName ?? null, r.ipNo ?? null, r.diagNo ?? null, r.bankName ?? null, r.amount ?? null,
  ];
}

/** Chunked multi-row INSERT — a refund workbook is ~4,300 rows, well past the ~65535 parameter limit in one statement. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO refund_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`, chunk.flat());
  }
}

/**
 * One batch row plus its records, inside the caller's transaction.
 * @returns the inserted refund_upload_batches row
 */
async function insertRefundBatch(client, { fileName, fileSizeBytes, sheetCount, uploadedBy, fileHash }, records) {
  const dates = records.map((r) => r.chequeDate).filter(Boolean).sort();
  const { rows } = await client.query(
    `INSERT INTO refund_upload_batches (file_name, file_size_bytes, row_count, sheet_count, document_from, document_to, uploaded_by, file_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [fileName, fileSizeBytes, records.length, sheetCount, dates[0] || null, dates[dates.length - 1] || null, uploadedBy, fileHash],
  );
  const batch = rows[0];
  await insertRecordsChunked(client, records.map((r) => recordToRow(batch.id, r)));
  return batch;
}

module.exports = { RECORD_COLUMNS, recordToRow, insertRecordsChunked, insertRefundBatch };
