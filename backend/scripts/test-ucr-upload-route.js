/**
 * Route-level test for the UCR MIS uploads (ucr-upload.routes.js), run against
 * an IN-MEMORY stand-in for src/db — no server, no database.
 *
 *   node scripts/test-ucr-upload-route.js
 *
 * What it pins down is the part unit tests of the parsers cannot: the client's
 * combined "All Collections" workbook is uploaded three times (IP, OP, DIAG) and
 * each must land as its own batch; a repeat of any of them must be refused; and
 * rows already stored from an overlapping earlier file must be refused.
 */
const path = require('path');
const XLSX = require('xlsx');

// ---- in-memory db stand-in, installed before the router is loaded ---------
const store = { batches: [], records: [] };
let nextBatchId = 1;

function runQuery(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT id, file_name, uploaded_at FROM ucr_ip_upload_batches WHERE file_hash = \$1/.test(text)) {
    const scoped = /AND mis_source = \$2/.test(text);
    const rows = store.batches.filter((b) => b.file_hash === params[0] && (!scoped || b.mis_source === params[1]));
    return { rows: rows.slice(0, 1) };
  }
  if (/^WITH n AS/.test(text)) {
    const [source, receipts, types, amounts, refs] = params;
    const keys = new Set(receipts.map((r, i) => JSON.stringify([r, types[i], amounts[i] === null ? null : Number(amounts[i]), refs[i] || ''])));
    const hits = new Map();
    for (const r of store.records.filter((x) => x.mis_source === source)) {
      const k = JSON.stringify([r.receipt_no, r.instrument_type, r.amount, r.reference_id || '']);
      if (!keys.has(k)) continue;
      if (!hits.has(r.batch_id)) hits.set(r.batch_id, new Set());
      hits.get(r.batch_id).add(k);
    }
    const total = new Set([...hits.values()].flatMap((s) => [...s])).size;
    return {
      rows: [...hits].map(([id, s]) => ({ id, file_name: store.batches.find((b) => b.id === id).file_name, rows: s.size, total })),
    };
  }
  if (/^INSERT INTO ucr_ip_upload_batches/.test(text)) {
    // Read by the statement's own column list — which columns it names varies
    // (mis_source only for OP/DIAG, unit_name for the MIS sources).
    const cols = text.match(/^INSERT INTO ucr_ip_upload_batches \(([^)]*)\)/)[1].split(',').map((c) => c.trim());
    const v = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    const b = { id: nextBatchId++, ...v, mis_source: v.mis_source ?? 'IP', uploaded_at: new Date(), matched_at: null };
    store.batches.push(b);
    return { rows: [b] };
  }
  if (/^INSERT INTO ucr_ip_records/.test(text)) {
    const explicitSource = text.match(/VALUES \(\$1, '(OP|DIAG)'/);
    const mis_source = explicitSource ? explicitSource[1] : 'IP';
    const [batch_id, receipt_no, , , , , , instrument_type, amount, , , reference_id] = explicitSource
      ? // OP/DIAG inserts: (batch_id, 'SRC', receipt_no, receipt_date, …) — map by their own column lists
        mapOpDiag(explicitSource[1], params)
      : params;
    store.records.push({ batch_id, receipt_no, instrument_type, amount: amount === null ? null : Number(amount), reference_id, mis_source });
    return { rows: [] };
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 80)}`);
}

// OP:   (batch_id, receipt_no, receipt_date, yh_no, patient_name, instrument_type, amount, user_id, reference_id)
// DIAG: (batch_id, receipt_no, receipt_date, patient_name, instrument_type, amount, user_id, user_name, reference_id)
function mapOpDiag(source, p) {
  if (source === 'OP') return [p[0], p[1], null, null, null, null, null, p[5], p[6], null, null, p[8]];
  return [p[0], p[1], null, null, null, null, null, p[4], p[5], null, null, p[8]];
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

const router = require('../src/routes/ucr-upload.routes');

function handlerFor(routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // after multer
}

/** Invokes a POST handler; resolves with { status, body } or the error passed to next(). */
function post(routePath, buffer, fileName) {
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
    handlerFor(routePath)(req, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}

// ---- a small combined workbook in the real SBD layout ---------------------
const put = (width, entries) => {
  const row = Array(width).fill('');
  for (const [i, v] of Object.entries(entries)) row[Number(i)] = v;
  return row;
};
function combinedWorkbook(ipRows) {
  const ipHeader = ['SNO', 'RECEIPT NO', 'DATE', 'YH NO', 'IPNO', 'NAME', 'BILLNO', 'Type', 'AMOUNT', 'User ID', 'User Name', 'Reference ID'];
  const ip = [
    put(16, { 4: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }),
    ipHeader,
    ...ipRows.map(([sno, no, type, amt, ref]) => put(16, { 0: sno, 1: no, 3: '01-Sep-2026  0:01', 4: '1', 5: '2', 6: 'P', 10: 'ADVANCE', 11: type, 12: amt, 13: 'CC7024', 14: 'S', 15: ref })),
  ];
  const sum = (t) => ipRows.filter((r) => t.includes(r[2])).reduce((s, r) => s + r[3], 0);
  const total = ipRows.reduce((s, r) => s + r[3], 0);
  ip.push(put(16, { 1: 'Cash Amount', 6: 'TOTAL COLLECTION :', 8: total, 9: sum(['Cash']), 10: sum(['Card']), 11: 0, 12: sum(['UPI']), 13: 0 }));

  const op = [
    ['SNO', 'BILL NO', 'YHNO', 'DATE', 'Time', 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD', 'Consultant', 'Speciality', 'PmtType', 'PatType', 'Payment', 'Tot Amt', 'OP REGISTARTIONS', 'Post Disc', 'Net Amt', 'UserID', 'User Name', 'Reference ID'],
    put(28, { 0: 1, 1: 'DFV1', 2: '1', 3: '01-Sep-2026', 5: 'P', 9: 'UPI', 13: 700, 14: 0, 15: 0, 16: 700, 17: 'FO7607', 18: 'X', 19: '128826665223' }),
    put(28, { 2: 'Cash Amount', 4: 'Card Amt', 11: 700, 13: 0, 14: 0, 18: 700 }),
  ];
  const diag = [
    put(26, { 5: 'YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD' }),
    ['SNO', 'RECEIPTNO', 'DATE', 'YHNO', 'NAME', 'Doctor Name', '', 'Pat Type', 'Cash Amt', 'Card Amt', 'ChqAmt', 'AdjAmt', 'UPIAmt', 'OnlAmt', 'AMOUNT', 'RefId', 'USerId', 'UserName', 'Diag No.'],
    put(26, { 0: 1, 1: 'ODE1', 2: '01/09/26  08:42 AM', 6: 'P', 12: 0, 13: 12000, 14: 0, 15: 0, 16: 0, 17: 0, 18: 12000, 20: '079893', 24: 'DG7759', 25: 'N' }),
    put(26, { 14: 0, 16: 12000, 17: 0, 18: 0, 19: 0, 20: 0, 21: 12000 }),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ip), 'ADVANCES_YH.RPT');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(diag), 'ADVANCES_OP_YH.RPT');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(op), 'DOCTOR_FEE_REG_YH.RPT');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300)));
  }
};

(async () => {
  const sep1to15 = combinedWorkbook([
    [1, '09/IDE1/26', 'Card', 20000, '475806'],
    [2, '09/IDE2/26', 'UPI', 40000, '624473022200'],
    [3, '09/IDE3/26', 'Cash', 5000, ''],
  ]);

  console.log('\n=== the combined workbook, uploaded once per report ===');
  // DIAG and OP first, IP last: before the fix, IP's unscoped hash check found
  // the OP/DIAG batches of these same bytes and refused its own report.
  const diag = await post('/ucr-diag', sep1to15, 'All Collections.xls');
  const op = await post('/ucr-op', sep1to15, 'All Collections.xls');
  const ip = await post('/ucr-ip', sep1to15, 'All Collections.xls');
  ok('DIAG stored (1 card row), verified', diag.status === 201 && diag.body.rowCount === 1 && diag.body.verification.status === 'VERIFIED', diag);
  ok('OP stored (1 UPI row), verified', op.status === 201 && op.body.rowCount === 1 && op.body.verification.status === 'VERIFIED', op);
  ok('IP stored after OP/DIAG of the same bytes (hash check scoped to IP)', ip.status === 201 && ip.body.rowCount === 2, ip);
  ok('three batches, one per source', store.batches.map((b) => b.mis_source).sort().join() === 'DIAG,IP,OP', store.batches);
  ok('each report read only its own sheet', ip.body.sheetsParsed.join() === 'ADVANCES_YH.RPT' && op.body.sheetsParsed.join() === 'DOCTOR_FEE_REG_YH.RPT' && diag.body.sheetsParsed.join() === 'ADVANCES_OP_YH.RPT');
  ok('each batch keeps its report header as unit_name (location filter)', store.batches.every((b) => /SECUNDERABAD/.test(b.unit_name || '')), store.batches.map((b) => b.unit_name));

  console.log('\n=== duplicates are refused, with the batch named ===');
  const again = await post('/ucr-ip', sep1to15, 'All Collections (copy).xls');
  ok('the same file again -> 409', again.status === 409 && /already been uploaded/.test(again.body.error), again);

  const sep1to20 = combinedWorkbook([
    [1, '09/IDE1/26', 'Card', 20000, '475806'],
    [2, '09/IDE2/26', 'UPI', 40000, '624473022200'],
    [3, '09/IDE3/26', 'Cash', 5000, ''],
    [4, '09/IDE4/26', 'Card', 7000, '112233'],
  ]);
  const overlapping = await post('/ucr-ip', sep1to20, 'All Collections 1-20.xls');
  ok('a different file repeating stored transactions -> 409', overlapping.status === 409, overlapping);
  ok('...saying how many and where', /2 of the Card\/UPI rows in this file are already stored — batch #\d+ "All Collections.xls" \(2 rows\)/.test(overlapping.body.error), overlapping.body.error);
  ok('...and nothing was written', store.records.filter((r) => r.mis_source === 'IP').length === 2 && store.batches.length === 3);

  const fresh = combinedWorkbook([[1, '09/IDE9/26', 'UPI', 1000, '999999999999']]);
  const later = await post('/ucr-ip', fresh, 'All Collections 16-30.xls');
  ok('a genuinely new period is accepted', later.status === 201 && later.body.rowCount === 1, later);

  console.log('\n=== a report that fails its own totals is refused ===');
  const bad = combinedWorkbook([[1, '09/IDE7/26', 'Card', 20000, '475806']]);
  const wb = XLSX.read(bad, { type: 'buffer' });
  const ws = wb.Sheets['ADVANCES_YH.RPT'];
  ws[XLSX.utils.encode_cell({ r: 2, c: 12 })] = { t: 'n', v: 21000 }; // data row edited after export
  const tampered = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const before = store.batches.length;
  const refused = await post('/ucr-ip', tampered, 'edited.xls');
  ok('-> 422 with the reason', refused.status === 422 && /could not be verified/.test(refused.body.error), refused);
  ok('...and no batch was created', store.batches.length === before);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
