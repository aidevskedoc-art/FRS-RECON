/**
 * Writing IP payment rows — shared by the file upload (POST /api/ip-payments)
 * and the HIS API sync (POST /api/ip-payments/sync), so a receipt stored either
 * way lands in exactly the same shape and is caught by the same duplicate check.
 */

const RECORD_COLUMNS = [
  'batch_id', 'receipt_number', 'receipt_date', 'yhno', 'ip_no', 'patient_name',
  'transaction_id_1', 'transaction_id_2', 'trans_id', 'payment_mode', 'pay_type', 'remarks',
  'payment_remarks', 'pat_type', 'bill_amount', 'cash_amount', 'card_amount',
  'cheque_amount', 'online_amount', 'user_id', 'user_name',
];

/** Merges the two transaction-id fields for display/search — joined when both are present, else whichever exists. */
function mergeTransId(r) {
  return [r.transactionRef1, r.transactionRef2].filter(Boolean).join(' / ') || null;
}

function recordToRow(batchId, r) {
  return [
    batchId, r.receiptNumber ?? null, r.receiptDate ?? null, r.yhno ?? null, r.ipNo ?? null,
    r.patientName ?? null, r.transactionRef1 ?? null, r.transactionRef2 ?? null, mergeTransId(r), r.paymentMode ?? null,
    r.payType ?? null, r.remarks ?? null, r.paymentRemarks ?? null, r.patType ?? null,
    r.billAmount ?? null, r.cashAmount ?? null, r.cardAmount ?? null, r.chequeAmount ?? null,
    r.onlineUpiAmount ?? null, r.userId ?? null, r.userName ?? null,
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
      `INSERT INTO ip_payment_records (${RECORD_COLUMNS.join(', ')}) VALUES ${valuesSql}`,
      chunk.flat(),
    );
  }
}

/**
 * One batch row plus its records, inside the caller's transaction.
 * @returns the inserted ip_payment_upload_batches row
 */
async function insertIpBatch(client, { fileName, fileSizeBytes, uploadedBy, unitName, fileHash, source = 'FILE', apiSyncRunId = null }, records) {
  const { rows } = await client.query(
    `INSERT INTO ip_payment_upload_batches (file_name, file_size_bytes, row_count, uploaded_by, unit_name, file_hash, source, api_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [fileName, fileSizeBytes, records.length, uploadedBy, unitName, fileHash, source, apiSyncRunId],
  );
  const batch = rows[0];
  await insertRecordsChunked(client, records.map((r) => recordToRow(batch.id, r)));
  return batch;
}

module.exports = { RECORD_COLUMNS, mergeTransId, recordToRow, insertRecordsChunked, insertIpBatch };
