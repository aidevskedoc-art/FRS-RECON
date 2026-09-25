/**
 * Route-level test for the four older upload routes when handed the combined
 * HIS workbook — /api/ip-payments, /api/diag-op-payments,
 * /api/cheque-collections, /api/refunds — against an IN-MEMORY stand-in for
 * src/db. No server, no database.
 *
 *   node scripts/test-his-upload-routes.js
 *
 * What it pins down: the workbook reaches his-mis-rows.js (not the old
 * parsers), rows land in the right columns, a repeat of the same file is
 * refused, a different file repeating stored rows only adds the new ones, and
 * held-back receipts and verification come back in the response. (That the
 * duplicate keys agree with rows stored by the OLD exports is proven on real
 * data by scripts/verify-his-mis-parity.js.)
 */
const path = require('path');
const XLSX = require('xlsx');
const { combinedWorkbook, toBuffer, workbook, put, at, IP_SHEET, DIAG_SHEET, OP_SHEET, ip, ipFoot, IP_COLL } = require('./fixtures/his-workbook');

// ---- in-memory db stand-in ---------------------------------------------------
const tables = {};
const rowsOf = (t) => (tables[t] = tables[t] || []);
let nextId = 1;

// JS mirrors of mis-identities.js's SQL, over stored (snake_case) rows.
const blank = (v) => (v === null || v === undefined || v === '' ? null : v);
const IDENTITY = {
  ip_payment_records: (r) => `${String(r.receipt_number ?? '').trim()}§${String(blank(r.transaction_id_1) ?? blank(r.transaction_id_2) ?? '').trim()}`,
  diag_op_payment_records: (r) =>
    `${String(r.receipt_number ?? '').trim()}§${String(blank(r.transaction_id_1) ?? blank(r.transaction_id_2) ?? blank(r.transaction_id_3) ?? '').trim()}`,
  cheque_collection_records: (r) => `${String(r.receipt_number ?? '').trim()}§${String(r.cheque_no ?? '').trim()}§${r.collection_kind ?? 'IP'}`,
  refund_records: (r) => `${String(r.refund_no ?? '').trim()}§${String(r.cheque_no ?? '').trim()}§${r.refund_kind ?? ''}`,
};

function runQuery(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  let m = text.match(/^SELECT id, file_name, uploaded_at FROM (\w+) WHERE file_hash = \$1/);
  if (m) return { rows: rowsOf(m[1]).filter((b) => b.file_hash === params[0]).slice(0, 1) };
  m = text.match(/^SELECT DISTINCT .* AS ident FROM (\w+)$/);
  if (m) return { rows: rowsOf(m[1]).map((r) => ({ ident: IDENTITY[m[1]](r) })) };
  m = text.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES (.*)$/);
  if (m) {
    const cols = m[2].split(',').map((c) => c.trim());
    const out = [];
    for (let i = 0; i < params.length; i += cols.length) {
      const row = { id: nextId++, uploaded_at: new Date() };
      cols.forEach((c, j) => (row[c] = params[i + j]));
      rowsOf(m[1]).push(row);
      out.push(row);
    }
    return { rows: out };
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 100)}`);
}

const dbPath = path.resolve(__dirname, '../src/db.js');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => runQuery(sql, params),
    withTransaction: async (fn) => fn({ query: async (sql, params) => runQuery(sql, params) }),
  },
};

function handlerOf(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const ROUTES = {
  ip: handlerOf(require('../src/routes/ip-payments.routes')),
  diag: handlerOf(require('../src/routes/diag-op-payments.routes')),
  cheque: handlerOf(require('../src/routes/cheque-collections.routes')),
  refund: handlerOf(require('../src/routes/refunds.routes')),
};

function post(route, buffer, fileName) {
  return new Promise((resolve) => {
    const req = { file: { buffer, originalname: fileName, size: buffer.length }, body: { uploadedBy: 'test' } };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    ROUTES[route](req, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400)));
  }
};

(async () => {
  const wb = combinedWorkbook();
  const bytes = toBuffer(wb);

  console.log('\n=== the combined workbook through each route ===');
  const ipRes = await post('ip', bytes, 'All Collections.xls');
  ok('IP MIS: 201, 4 receipts stored, verified', ipRes.status === 201 && ipRes.body.rowsStored === 4 && ipRes.body.verification.every((v) => v.status === 'VERIFIED'), ipRes);
  const upi = rowsOf('ip_payment_records').find((r) => r.receipt_number === '09/IDE1/26');
  ok('...stored as the export stored it (RRN in transaction_id_2, merged trans_id, unit on the batch)', upi && upi.transaction_id_2 === '624473022200' && upi.trans_id === '624473022200' && upi.payment_mode === 'UPI' && rowsOf('ip_payment_upload_batches')[0].unit_name === 'SECUNDERABAD', upi);

  const diagRes = await post('diag', bytes, 'All Collections.xls');
  ok('Diag MIS: 201, the split-paid receipt stored and reported by number', diagRes.status === 201 && diagRes.body.heldBack.length === 0 && diagRes.body.splitPaid.length === 1 && diagRes.body.splitPaid[0].receiptNo === 'ORE190739' && rowsOf('diag_op_payment_records').some((r) => r.receipt_number === 'ORE190739/26'), diagRes.body);
  ok('...doctor-fee bill stored with pay_mode blank and both references', rowsOf('diag_op_payment_records').some((r) => r.receipt_number === 'DFV1155251/26' && r.pay_mode === null && r.transaction_id_1 === '331890422868'));

  const chqRes = await post('cheque', bytes, 'All Collections.xls');
  ok('Cheques: 201, one batch per collection kind', chqRes.status === 201 && chqRes.body.batches && chqRes.body.batches.length === 2, chqRes.body);
  ok('...IP and OP kinds, unit on each batch', rowsOf('cheque_collection_upload_batches').map((b) => b.collection_kind).sort().join() === 'IP,OP' && rowsOf('cheque_collection_upload_batches').every((b) => b.unit_name === 'SECUNDERABAD'));

  const refRes = await post('refund', bytes, 'All Collections.xls');
  ok('Refunds: 201, IP + OP cheque refunds, document dates from the refunds', refRes.status === 201 && rowsOf('refund_records').length === 2 && rowsOf('refund_upload_batches')[0].document_from === '2026-09-01', refRes.body);

  console.log('\n=== repeats ===');
  for (const route of ['ip', 'diag', 'cheque', 'refund']) {
    const again = await post(route, bytes, 'copy.xls');
    ok(`${route}: the same file again -> 409`, again.status === 409, again.body);
  }

  // A later file covering the same receipts plus one new one.
  const moreColl = [...IP_COLL, ip(9, '09/IDE9/26', 'UPI', 1234, '999888777666'), ip(10, '09/IDE10/26', 'Cheque', 4321, '054000')];
  const ipSheet2 = IP_SHEET.map((row) => row);
  const footerAt = ipSheet2.findIndex((row) => row[6] === 'TOTAL COLLECTION :');
  ipSheet2.splice(2, footerAt - 1, ...moreColl.map((r) => r.cells), ipFoot(moreColl, 'TOTAL COLLECTION :'));
  const later = toBuffer(workbook({ 'ADVANCES_YH.RPT': ipSheet2, 'ADVANCES_OP_YH.RPT': DIAG_SHEET, 'DOCTOR_FEE_REG_YH.RPT': OP_SHEET }));
  const ip2 = await post('ip', later, 'All Collections later.xls');
  ok('IP MIS: an overlapping later file stores only the new receipt', ip2.status === 201 && ip2.body.rowsStored === 1 && ip2.body.rowsSkipped === 4, ip2.body);
  const chq2 = await post('cheque', later, 'All Collections later.xls');
  ok('Cheques: likewise only the new cheque (3 already stored: two IP, one OP)', chq2.status === 201 && chq2.body.rowsSkipped === 3 && chq2.body.rowCount === 1 && rowsOf('cheque_collection_records').length === 4, chq2.body);
  const ref2 = await post('refund', later, 'All Collections later.xls');
  ok('Refunds: nothing new -> 409, nothing stored twice', ref2.status === 409 && rowsOf('refund_records').length === 2, ref2.body);

  console.log('\n=== an unverified layout is refused, not guessed ===');
  const smjHeader = ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SOMAJIGUDA', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', '', 'OP DOCTOR CONSULTATIONS', 'Tot Amt', 'Post Disc', 'Net Amt', 'UserID', 'Reference ID'];
  const smj = toBuffer(workbook({ 'DOCTOR_FEE_REG_YH.RPT': [smjHeader, put(24, { 0: 1, 1: 'DFV1', 2: 116744125, 3: at(8, 11, 24), 5: 'P', 9: 'UPI', 10: 'Self Paying', 13: 1000, 14: 0, 15: 1000, 16: 'FO7601', 17: '127173468656' }), put(24, { 2: 'Cash Amount', 11: 1000, 13: 0, 16: 0, 17: 1000 })] }));
  const before = rowsOf('diag_op_payment_records').length;
  const smjRes = await post('diag', smj, 'SMJ OP.xls');
  ok('Diag MIS from the SMJ doctor-fee layout -> 422 with the reason', smjRes.status === 422 && /op-smj/.test(smjRes.body.error), smjRes.body);
  ok('...and nothing stored', rowsOf('diag_op_payment_records').length === before);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
