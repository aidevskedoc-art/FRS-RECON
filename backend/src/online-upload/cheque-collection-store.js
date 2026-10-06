/**
 * Writing cheque collection rows — shared by the file upload
 * (POST /api/cheque-collections) and the HIS API sync, so a receipt stored
 * either way lands in exactly the same shape and is caught by the same
 * duplicate check.
 */

const RECORD_COLUMNS = [
  'batch_id', 'collection_kind', 'receipt_number', 'receipt_date', 'cheque_date', 'ip_no', 'diag_no',
  'patient_name', 'cheque_no', 'pay_type', 'pat_type', 'bank_name', 'branch_name',
  'cheque_amount', 'receipt_amount', 'user_id', 'user_name',
];

function recordToRow(batchId, r) {
  return [
    batchId, r.collectionKind ?? 'IP', r.receiptNumber ?? null, r.receiptDate ?? null, r.chequeDate ?? null,
    r.ipNo ?? null, r.diagNo ?? null, r.patientName ?? null, r.chequeNo ?? null, r.payType ?? null,
    r.patType ?? null, r.bankName ?? null, r.branchName ?? null, r.amount ?? null,
    r.receiptAmount ?? null, r.userId ?? null, r.userName ?? null,
  ];
}

/** Chunked multi-row INSERT — keeps parameter count well under Postgres's ~65535 limit. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO cheque_collection_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`, chunk.flat());
  }
}

/**
 * One batch row plus its records, inside the caller's transaction.
 * @returns the inserted cheque_collection_upload_batches row
 */
async function insertChequeBatch(client, { fileName, fileSizeBytes, uploadedBy, unitName, collectionKind, fileHash }, records) {
  const { rows } = await client.query(
    `INSERT INTO cheque_collection_upload_batches (file_name, file_size_bytes, row_count, uploaded_by, unit_name, collection_kind, file_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [fileName, fileSizeBytes, records.length, uploadedBy, unitName, collectionKind, fileHash],
  );
  const batch = rows[0];
  await insertRecordsChunked(client, records.map((r) => recordToRow(batch.id, r)));
  return batch;
}

module.exports = { RECORD_COLUMNS, recordToRow, insertRecordsChunked, insertChequeBatch };
