/**
 * Deleting a UPI MPR batch must delete its bank_statement_records mirror too
 * (2026-09-25: 4 orphaned mirrors had piled up, 1,752 IP matches pointed at
 * one). Uploads a tiny synthetic UPI MPR through the real route handler, then
 * deletes it through the real DELETE handler. Leaves nothing behind.
 *   node scripts/test-upi-mirror-delete.js
 */
require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const router = require('../src/routes/ucr-upload.routes');

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); } };

function findHandler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function invoke(handler, req) {
  let statusCode = 200, body;
  const res = { status(c) { statusCode = c; return this; }, json(p) { body = p; return this; }, end() { return this; } };
  let error;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { statusCode, body };
}

(async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Order ID', 'Txn ref no. (RRN)', 'Transaction Req Date', 'Settlement Date', 'Transaction Amount'],
    ['ZZORD1', `ZZ${Date.now()}1`, '2099-01-05', '2099-01-06', '101.00'],
    ['ZZORD2', `ZZ${Date.now()}2`, '2099-01-05', '2099-01-06', '202.00'],
  ]), 'Sheet1');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  let batchId = null, bankBatchId = null;
  try {
    const up = await invoke(findHandler('post', '/upi-mpr'), {
      file: { buffer, originalname: 'zz-upi-mirror-test.xlsx', size: buffer.length }, body: { uploadedBy: 'ZZ test' }, query: {}, headers: {},
    });
    batchId = up.body?.id;
    check('upload: 201', up.statusCode === 201 && batchId);
    bankBatchId = (await db.query('SELECT bank_batch_id FROM ucr_upi_mpr_upload_batches WHERE id = $1', [batchId])).rows[0]?.bank_batch_id;
    check('upload: UPI batch linked to its bank mirror', bankBatchId != null);
    const mirrorRows = (await db.query('SELECT count(*)::int n FROM bank_statement_records WHERE batch_id = $1', [bankBatchId])).rows[0].n;
    check('upload: mirror holds both rows', mirrorRows === 2);

    const del = await invoke(findHandler('delete', '/upi-mpr/batches/:id'), { params: { id: String(batchId) }, query: {}, body: {}, headers: {}, user: { role: 'ADMIN' } });
    check('delete: 204', del.statusCode === 204);
    const left = (await db.query('SELECT (SELECT count(*) FROM ucr_upi_mpr_upload_batches WHERE id = $1)::int upi, (SELECT count(*) FROM bank_statement_uploads WHERE id = $2)::int bank, (SELECT count(*) FROM bank_statement_records WHERE batch_id = $2)::int rec', [batchId, bankBatchId])).rows[0];
    check('delete: UPI batch gone', left.upi === 0);
    check('delete: bank mirror batch gone', left.bank === 0);
    check('delete: bank mirror rows gone', left.rec === 0);
  } finally {
    if (batchId) await db.query('DELETE FROM ucr_upi_mpr_upload_batches WHERE id = $1', [batchId]);
    if (bankBatchId) await db.query('DELETE FROM bank_statement_uploads WHERE id = $1', [bankBatchId]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
