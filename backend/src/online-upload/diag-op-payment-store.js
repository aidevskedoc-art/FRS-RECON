/**
 * Writing Diagnostics / OP payment rows — shared by the file upload
 * (POST /api/diag-op-payments) and the HIS API sync, so a receipt stored either
 * way lands in exactly the same shape and is caught by the same duplicate check.
 */

const RECORD_COLUMNS = [
  'batch_id', 'receipt_number', 'receipt_date', 'yhno', 'diag_no', 'patient_name',
  'transaction_id_1', 'transaction_id_2', 'transaction_id_3', 'pay_type', 'pay_mode',
  'pat_type', 'bill_amount', 'cash_amount', 'card_amount', 'cheque_amount',
  'online_amount', 'discount_amount', 'diff_amount', 'user_id', 'user_name', 'department',
];

// department: 'DIAG' | 'OPD' from the HIS row builder (his-mis-rows.js
// misDiagRows); null from the legacy non-HIS parser, which can't tell them apart.
function recordToRow(batchId, r) {
  return [
    batchId, r.receiptNumber ?? null, r.receiptDate ?? null, r.yhno ?? null, r.diagNo ?? null,
    r.patientName ?? null, r.transactionRef1 ?? null, r.transactionRef2 ?? null, r.transactionRef3 ?? null,
    r.payType ?? null, r.payMode ?? null, r.patType ?? null, r.billAmount ?? null, r.cashAmount ?? null,
    r.cardAmount ?? null, r.chequeAmount ?? null, r.onlineUpiAmount ?? null, r.discountAmount ?? null,
    r.diffAmount ?? null, r.userId ?? null, r.userName ?? null, r.department ?? null,
  ];
}

/** Chunked multi-row INSERT — keeps parameter count well under Postgres's ~65535 limit for large uploads. */
async function insertRecordsChunked(client, rows, chunkSize = 500) {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const valuesSql = chunk
      .map((row, i) => `(${row.map((_, c) => `$${i * RECORD_COLUMNS.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(
      `INSERT INTO diag_op_payment_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`,
      chunk.flat(),
    );
  }
}

/**
 * One batch row plus its records, inside the caller's transaction.
 * @returns the inserted diag_op_upload_batches row
 */
async function insertDiagBatch(client, { fileName, fileSizeBytes, uploadedBy, unitName, fileHash }, records) {
  const { rows } = await client.query(
    `INSERT INTO diag_op_upload_batches (file_name, file_size_bytes, row_count, uploaded_by, unit_name, file_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [fileName, fileSizeBytes, records.length, uploadedBy, unitName, fileHash],
  );
  const batch = rows[0];
  await insertRecordsChunked(client, records.map((r) => recordToRow(batch.id, r)));
  return batch;
}

module.exports = { RECORD_COLUMNS, recordToRow, insertRecordsChunked, insertDiagBatch };
