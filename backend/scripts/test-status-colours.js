/**
 * Result-file colour code (client mail AC-17): the Reconciliation Status cell
 * is filled green (matched), red (not matched) or orange (matched by an
 * auditor), in the Audit Working Report and in the payment / bank exports.
 * Builds real workbooks, writes them through excel/write-xlsx.js, and reads the
 * fills back with exceljs — what Excel itself would show. No DB, no server.
 *
 *   node scripts/test-status-colours.js
 */
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { statusTone, statusLabel, recordLabelOptions, isMatchedByAuditor } = require('../src/reconciliation/status-tone');
const { writeXlsx, TONE_STYLES } = require('../src/excel/write-xlsx');
const { buildAuditWorkbook } = require('../src/excel/audit-report');
const { buildReconciliationWorkbook } = require('../src/excel/reconciliation-export');
const { resolveColumns } = require('../src/excel/payment-export-columns');
const { columnSheet } = require('../src/excel/write-xlsx');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

const FILL = Object.fromEntries(Object.entries(TONE_STYLES).map(([tone, s]) => [`FF${s.fill}`, tone]));

/** Reads the workbook back with exceljs and returns, per sheet, a finder: header -> [{ value, tone }] down that column. */
async function readBack(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return (sheetName, header) => {
    const ws = book.getWorksheet(sheetName);
    let headerRow = null;
    let col = null;
    ws.eachRow((row, r) => {
      if (headerRow) return;
      row.eachCell((cell, c) => {
        if (String(cell.value).trim() === header) { headerRow = r; col = c; }
      });
    });
    if (!headerRow) return null;
    const out = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const cell = ws.getRow(r).getCell(col);
      if (cell.value === null || cell.value === '') continue;
      const argb = cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
      out.push({ value: cell.value, tone: FILL[argb] || null });
    }
    return out;
  };
}

(async () => {
  console.log('\n=== statusTone ===');
  ok('MATCHED -> GREEN', statusTone('MATCHED') === 'GREEN');
  ok('EASEBUZZ_MATCHED -> GREEN', statusTone('EASEBUZZ_MATCHED') === 'GREEN');
  ok('CONTRA_ENTRY -> GREEN (a resolved cheque, not a mismatch)', statusTone('CONTRA_ENTRY') === 'GREEN');
  for (const s of ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH']) ok(`${s} -> RED`, statusTone(s) === 'RED');
  ok('matched by an auditor -> ORANGE', statusTone('MATCHED', { matchedByAuditor: true }) === 'ORANGE');
  ok('no verdict -> no colour', statusTone(null) === null && statusTone(undefined) === null);

  console.log('\n=== a contra entry is named by its cheque number ===');
  ok('real cheque number -> "Yashoda refund Cheque"', statusLabel('CONTRA_ENTRY', { chequeNo: '053847' }) === 'Yashoda refund Cheque');
  ok('reference code 12345 -> plain "Contra Entry"', statusLabel('CONTRA_ENTRY', { chequeNo: '12345' }) === 'Contra Entry');
  ok('reference code 123456 (padded) -> plain "Contra Entry"', statusLabel('CONTRA_ENTRY', { chequeNo: ' 123456 ' }) === 'Contra Entry');
  ok('mis-entered 1234567 -> plain "Contra Entry"', statusLabel('CONTRA_ENTRY', { chequeNo: '1234567' }) === 'Contra Entry');
  ok('blank cheque number -> plain "Contra Entry"', statusLabel('CONTRA_ENTRY', { chequeNo: null }) === 'Contra Entry');
  ok('no cheque number given (non-cheque sheets) -> plain "Contra Entry"', statusLabel('CONTRA_ENTRY') === 'Contra Entry');
  ok('other verdicts ignore the cheque number', statusLabel('UNMATCHED', { chequeNo: '053847' }) === 'Unmatched');
  ok('matched by an auditor still wins', statusLabel('CONTRA_ENTRY', { chequeNo: '053847', matchedByAuditor: true }) === 'Matched by Auditor');

  console.log('\n=== several receipts on one cheque read "Grouped Matched" ===');
  const groupedCheque = { uploadType: 'CHEQUE_PAYMENT', chequeNo: '127760', matchStatus: 'MATCHED', matchUnitCount: 10 };
  const singleCheque = { uploadType: 'CHEQUE_PAYMENT', chequeNo: '053500', matchStatus: 'MATCHED', matchUnitCount: null };
  const groupedIp = { uploadType: 'IP_PAYMENT', matchStatus: 'MATCHED', matchUnitCount: 2 };
  ok('grouped cheque -> "Grouped Matched"', statusLabel('MATCHED', recordLabelOptions(groupedCheque)) === 'Grouped Matched');
  ok('single cheque -> "Matched"', statusLabel('MATCHED', recordLabelOptions(singleCheque)) === 'Matched');
  ok('grouped IP row keeps "Matched" (cheque-only wording)', statusLabel('MATCHED', recordLabelOptions(groupedIp)) === 'Matched');
  ok('a grouped cheque that is not matched keeps its own status', statusLabel('PARTIAL_MATCH', recordLabelOptions({ ...groupedCheque, matchStatus: 'PARTIAL_MATCH' })) === 'Partial Match');
  ok('grouped cheque is still green', statusTone('MATCHED') === 'GREEN');
  ok('auditor approval wins over the group', statusLabel('MATCHED', { ...recordLabelOptions(groupedCheque), matchedByAuditor: true }) === 'Matched by Auditor');
  ok('auditor match needs locked_at AND locked_by', isMatchedByAuditor({ locked_at: new Date(), locked_by: 3 }) && !isMatchedByAuditor({ locked_at: new Date(), locked_by: null }) && !isMatchedByAuditor({}));

  console.log('\n=== Audit Working Report ===');
  const onlineRow = (id, result, extra = {}) => ({ id, receiptNumber: `R${id}`, receiptDate: '2026-09-10', patientName: 'P', __seq: id, __result: result, ...extra });
  const bank = { txnDate: '2026-09-11', narration: 'NEFT X', chqRefNo: 'REF', depositAmt: 100, bankName: 'HDFC', accountNo: '50200001234567' };
  const wb = buildAuditWorkbook({
    periodLabel: 'SEP-26',
    sheets: [
      {
        key: 'ONLINE',
        rows: [
          onlineRow(1, { status: 'MATCHED', bank }),
          onlineRow(2, { status: 'UNMATCHED', bank: null, matchReason: 'No bank credit found' }),
          onlineRow(3, { status: 'AMOUNT_MISMATCH', bank }),
          // what buildAuditSheets produces for an approved maker-checker change
          onlineRow(4, { status: 'MATCHED', bank: null, matchedByAuditor: true, matchReason: 'Manually matched — paid at counter (approved by Mrs. Radhika K)' }),
        ],
      },
      {
        key: 'UCR',
        rows: [
          { id: 7, receiptNo: 'C1', receiptDate: '2026-09-10', matchStatus: 'MATCHED', __seq: 1 },
          { id: 8, receiptNo: 'C2', receiptDate: '2026-09-10', matchStatus: 'UNMATCHED', __seq: 2 },
          { id: 9, receiptNo: 'C3', receiptDate: '2026-09-10', matchStatus: 'MATCHED', matchedByAuditor: true, __seq: 3 },
        ],
      },
    ],
  });
  const audit = await readBack(await writeXlsx(wb));
  const online = audit('ONLINE COLLECTION', 'RECONCILIATION STATUS');
  ok('ONLINE: status column found with 4 rows', online && online.length === 4, online);
  ok('ONLINE: Matched -> green', online[0].value === 'Matched' && online[0].tone === 'GREEN', online[0]);
  ok('ONLINE: Unmatched -> red', online[1].value === 'Unmatched' && online[1].tone === 'RED', online[1]);
  ok('ONLINE: Amount Mismatch -> red', online[2].value === 'Amount Mismatch' && online[2].tone === 'RED', online[2]);
  ok('ONLINE: auditor-approved -> "Matched by Auditor", orange', online[3].value === 'Matched by Auditor' && online[3].tone === 'ORANGE', online[3]);
  const remarks = audit('ONLINE COLLECTION', 'REMARKS');
  ok('ONLINE: auditor-approved REMARKS carry the approval text', remarks.some((c) => /approved by Mrs\. Radhika K/.test(String(c.value))), remarks);
  const ucr = audit('CARD AND UPI COLLECTION', 'RECONCILIATION STATUS');
  ok('UCR: green / red / orange', ucr && ucr.map((c) => c.tone).join() === 'GREEN,RED,ORANGE', ucr);
  ok('UCR: auditor-approved label', ucr[2].value === 'Matched by Auditor');
  const patient = audit('ONLINE COLLECTION', 'PATIENT NAME');
  ok('only the status column is coloured (PATIENT NAME has no fill)', patient.every((c) => c.tone === null), patient);
  ok('an empty sheet (CHEQUE) still writes, uncoloured', audit('CHEQUE COLL AND REALIZN', 'RECONCILIATION STATUS').length === 0);

  console.log('\n=== reconciliation export (all columns) ===');
  const records = [
    { id: '1', receiptNumber: 'R1', matchStatus: 'MATCHED', matchedByAuditor: false },
    { id: '2', receiptNumber: 'R2', matchStatus: 'PARTIAL_MATCH', matchedByAuditor: false },
    { id: '3', receiptNumber: 'R3', matchStatus: 'MATCHED', matchedByAuditor: true },
    { id: '4', receiptNumber: 'R4', matchStatus: null, matchedByAuditor: false },
  ];
  const { workbook: exportWb } = buildReconciliationWorkbook(records, 'IP Payments');
  const exp = (await readBack(await writeXlsx(exportWb)))('IP Payments', 'matchStatus');
  ok('export: matched / partial / auditor coloured; never-generated left blank', exp.map((c) => c.tone).join() === 'GREEN,RED,ORANGE', exp);

  console.log('\n=== picked-column export ===');
  const cols = resolveColumns('ip', 'receiptNumber,matchStatus');
  const pickWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(pickWb, columnSheet(records, cols), 'IP Payments');
  const picked = (await readBack(await writeXlsx(pickWb)))('IP Payments', 'Match Status');
  ok('picked: labels', picked.map((c) => c.value).join('|') === 'Matched|Partial Match|Matched by Auditor|Not Generated', picked.map((c) => c.value));
  ok('picked: tones (Not Generated uncoloured)', picked.map((c) => c.tone).join() === 'GREEN,RED,ORANGE,', picked.map((c) => c.tone));

  console.log('\n=== untagged workbook is byte-identical to plain SheetJS ===');
  const plain = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(plain, XLSX.utils.aoa_to_sheet([['a'], [1]]), 'S');
  const viaWriter = await writeXlsx(plain);
  ok('no tone -> SheetJS output, exceljs never involved', Buffer.isBuffer(viaWriter) && XLSX.read(viaWriter, { type: 'buffer' }).Sheets.S.A2.v === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
